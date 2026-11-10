/**
 * M16 production: BOM versions (one active per product) and manufacturing orders (MO).
 * Issue cuts raw materials FIFO (lots locked FOR UPDATE, BR-07) into work in progress; outputs are recorded any
 * number of times (good / reject); closing returns leftovers at their issued cost and creates ONE FIFO lot of the
 * finished good at (materials used + labour + overhead) ÷ good qty (REQ-M16-03, BR-21).
 */
import type { Tx } from '@erp/db';
import type { Bom, Mo } from '@erp/contracts';
import { bomSuggest, d, fmtTHB, money, moUnitCost, qty4, sum, yieldPct , searchTokens } from '@erp/core';
import { writeAudit } from '../../lib/audit';
import { can, requireAny, requirePerm, type Ctx, type Deps } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E, isUuid } from '../../lib/errors';
import { decodeCursor, likeEscape, pageOf } from '../../lib/paging';
import { addLot, applyOut, lockLots, planTakes, recordIn, reverseOuts } from '../../lib/stock';
import { loadProducts, requireWarehouse } from '../../services/master';
import { iso, onHand, peekCosts } from './common';

const readPerm = (ctx: Ctx) => requireAny(ctx, ['inv.produce', 'rep.view'], { readOnly: true });
const seeCost = (ctx: Ctx) => can(ctx, 'data.cost') === 1;

// ---------- BOM ----------

interface BomRow {
  id: string; product_id: string; version: number; components: { productId: string; qtyPerUnit: string }[]; labour_per_unit: string; overhead_per_unit: string;
  note: string; active: boolean; created_by: string; created_at: Date;
}
const BOM_SELECT = `select b.id, b.product_id, b.version, b.components, b.labour_per_unit::text, b.overhead_per_unit::text, b.note, b.active, u.name created_by, b.created_at
  from retail_boms b join users u on u.id = b.created_by`;

async function toBoms(tx: Tx, ctx: Ctx, rows: BomRow[]): Promise<Bom[]> {
  if (!rows.length) return [];
  const ids = rows.flatMap((r) => [r.product_id, ...r.components.map((c) => c.productId)]);
  const products = await loadProducts(tx, ids);
  const wh = (await tx.query<{ id: string }>(`select id from warehouses where active order by is_pos, code limit 1`)).rows[0]?.id ?? null; // production usually draws from the back store
  return Promise.all(rows.map(async (r) => {
    const p = products.get(r.product_id)!;
    const costs = seeCost(ctx) ? await peekCosts(tx, wh, r.components.map((c) => ({ productId: c.productId, qty: c.qtyPerUnit }))) : [];
    const mat = sum(r.components.map((c, i) => d(costs[i] ?? 0).times(d(c.qtyPerUnit))));
    return {
      id: r.id, productId: p.id, productName: p.name, unitName: p.units[0]!.name, version: r.version, active: r.active,
      components: r.components.map((c, i) => {
        const m = products.get(c.productId)!;
        return { productId: m.id, qtyPerUnit: qty4(c.qtyPerUnit), name: m.name, unitName: m.units[0]!.name, unitCost: seeCost(ctx) ? costs[i] ?? null : null };
      }),
      labourPerUnit: qty4(r.labour_per_unit), overheadPerUnit: qty4(r.overhead_per_unit), note: r.note,
      stdUnitCost: seeCost(ctx) ? money(mat.plus(d(r.labour_per_unit)).plus(d(r.overhead_per_unit))) : null,
      price: money(p.price), createdBy: r.created_by, createdAt: r.created_at.toISOString(),
    };
  }));
}

export async function listBoms(tx: Tx, ctx: Ctx, q: { q?: string; limit: number; cursor?: string; productId?: string; all?: boolean }) {
  readPerm(ctx);
  const cur = decodeCursor(q.cursor, 3);
  const params: unknown[] = [];
  const where: string[] = q.all ? [] : ['b.active'];
  if (q.productId) {
    if (!isUuid(q.productId)) throw E.validation('Unknown product');
    params.push(q.productId);
    where.push(`b.product_id = $${params.length}`);
  }
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(p.name ilike $${params.length} or p.sku ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], Number(cur[1]), cur[2]);
    where.push(`(p.sku, -b.version, b.id) > ($${params.length - 2}, -$${params.length - 1}::int, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<BomRow & { sku: string }>(
    `${BOM_SELECT.replace('from retail_boms b', 'from retail_boms b join products p on p.id = b.product_id').replace('select b.id', 'select p.sku, b.id')}
     ${where.length ? 'where ' + where.join(' and ') : ''} order by p.sku, b.version desc, b.id limit $${params.length}`,
    params,
  );
  const pg = pageOf(r.rows, q.limit, (x) => [x.sku, x.version, x.id], (x) => x);
  return { items: await toBoms(tx, ctx, pg.items), nextCursor: pg.nextCursor };
}

/** Saves a new BOM version and makes it the active one (versions are immutable). */
export async function saveBom(tx: Tx, ctx: Ctx, b: { productId: string; components: { productId: string; qtyPerUnit: string }[]; labourPerUnit: string; overheadPerUnit: string; note: string }): Promise<Bom> {
  requirePerm(ctx, 'inv.produce');
  const products = await loadProducts(tx, [b.productId, ...b.components.map((c) => c.productId)]);
  const p = products.get(b.productId)!;
  if (p.kind !== 'stock') throw E.validation('Only stock products can be produced');
  const seen = new Set<string>();
  for (const c of b.components) {
    if (c.productId === b.productId) throw E.validation('A product cannot be its own material');
    if (seen.has(c.productId)) throw E.validation('A material appears twice');
    seen.add(c.productId);
    if (products.get(c.productId)!.kind !== 'stock') throw E.validation(`${products.get(c.productId)!.sku} is a service and cannot be a material`);
    if (!d(c.qtyPerUnit).gt(0)) throw E.validation('Material qty per unit must be > 0');
  }
  await tx.query(`select pg_advisory_xact_lock(hashtext('retail_bom:' || $1))`, [p.id]);
  const prev = await tx.query<{ v: number | null }>(`select max(version) v from retail_boms where product_id = $1`, [p.id]);
  const version = (prev.rows[0]?.v ?? 0) + 1;
  await tx.query(`update retail_boms set active = false where product_id = $1 and active`, [p.id]);
  const comps = b.components.map((c) => ({ productId: c.productId, qtyPerUnit: qty4(c.qtyPerUnit) }));
  const r = await tx.query<{ id: string }>(
    `insert into retail_boms (tenant_id, product_id, version, components, labour_per_unit, overhead_per_unit, note, active, created_by) values ($1,$2,$3,$4,$5,$6,$7,true,$8) returning id`,
    [ctx.tenantId, p.id, version, JSON.stringify(comps), b.labourPerUnit, b.overheadPerUnit, b.note, ctx.userId],
  );
  await writeAudit(tx, ctx, [{
    action: 'update', object: 'bom', ref: p.sku,
    detail: `${p.name} · v${version} · ${comps.map((c) => `${products.get(c.productId)!.name.split(' ')[0]} ${c.qtyPerUnit}`).join(', ')} · ค่าแรง ${qty4(b.labourPerUnit)} · ค่าใช้จ่าย ${qty4(b.overheadPerUnit)}`,
  }]);
  return (await toBoms(tx, ctx, (await tx.query<BomRow>(`${BOM_SELECT} where b.id = $1`, [r.rows[0]!.id])).rows))[0]!;
}

export async function activateBom(tx: Tx, ctx: Ctx, id: string): Promise<Bom> {
  requirePerm(ctx, 'inv.produce');
  if (!isUuid(id)) throw E.notFound('BOM not found');
  const row = (await tx.query<BomRow>(`${BOM_SELECT} where b.id = $1`, [id])).rows[0];
  if (!row) throw E.notFound('BOM not found');
  await tx.query(`select pg_advisory_xact_lock(hashtext('retail_bom:' || $1))`, [row.product_id]);
  await tx.query(`update retail_boms set active = false where product_id = $1 and active and id <> $2`, [row.product_id, id]);
  await tx.query(`update retail_boms set active = true where id = $1`, [id]);
  const p = (await loadProducts(tx, [row.product_id])).get(row.product_id)!;
  await writeAudit(tx, ctx, [{ action: 'update', object: 'bom', ref: p.sku, detail: `${p.name} · ใช้สูตร v${row.version}` }]);
  return (await toBoms(tx, ctx, [{ ...row, active: true }]))[0]!;
}

async function activeBom(tx: Tx, productId: string): Promise<BomRow> {
  if (!isUuid(productId)) throw E.validation('Unknown product');
  const r = await tx.query<BomRow>(`${BOM_SELECT} where b.product_id = $1 and b.active`, [productId]);
  if (!r.rows[0]) throw E.validation('This product has no active BOM; set up its recipe first');
  return r.rows[0];
}

// ---------- MO ----------

export async function suggestMo(tx: Tx, ctx: Ctx, q: { productId: string; planQty: string; issueWarehouseId: string }) {
  requirePerm(ctx, 'inv.produce', { readOnly: true });
  if (!d(q.planQty).gt(0)) throw E.validation('Planned qty must be > 0');
  const wh = await requireWarehouse(tx, q.issueWarehouseId);
  const bom = await activeBom(tx, q.productId);
  const products = await loadProducts(tx, bom.components.map((c) => c.productId));
  const have = await onHand(tx, wh.id, bom.components.map((c) => c.productId));
  const std = bom.components.map((c) => bomSuggest(c.qtyPerUnit, q.planQty));
  const costs = seeCost(ctx) ? await peekCosts(tx, wh.id, bom.components.map((c, i) => ({ productId: c.productId, qty: std[i]! }))) : [];
  return {
    bomId: bom.id, version: bom.version,
    labourPerUnit: seeCost(ctx) ? qty4(bom.labour_per_unit) : null, overheadPerUnit: seeCost(ctx) ? qty4(bom.overhead_per_unit) : null,
    lines: bom.components.map((c, i) => {
      const m = products.get(c.productId)!;
      return { productId: m.id, name: m.name, unitName: m.units[0]!.name, stdQty: std[i]!, available: qty4(have.get(m.id) ?? 0), estCost: seeCost(ctx) && costs[i] ? money(d(costs[i]!).times(d(std[i]!))) : null };
    }),
  };
}

interface MoRow {
  id: string; no: string; date: string; product_id: string; bom_id: string; bom_version: number; plan_qty: string; issue_wh: string; issue_wh_name: string;
  output_wh: string; output_wh_name: string; status: Mo['status']; labour_per_unit: string; overhead_per_unit: string; materials_cost: string; returned_cost: string;
  labour_cost: string | null; overhead_cost: string | null; good_qty: string; reject_qty: string; unit_cost: string | null; note: string;
  created_by: string; created_at: Date; closed_by: string | null; closed_at: Date | null; cancel_reason: string | null; product_name: string; unit_name: string;
}
const MO_SELECT = `select m.id, m.no, m.date, m.product_id, m.bom_id, b.version bom_version, m.plan_qty::text, m.issue_wh, wi.name issue_wh_name, m.output_wh, wo.name output_wh_name,
    m.status, m.labour_per_unit::text, m.overhead_per_unit::text, m.materials_cost::text, m.returned_cost::text, m.labour_cost::text, m.overhead_cost::text,
    m.good_qty::text, m.reject_qty::text, m.unit_cost::text, m.note, cu.name created_by, m.created_at, xu.name closed_by, m.closed_at, m.cancel_reason,
    p.name product_name, p.units->0->>'name' unit_name
  from retail_mos m join retail_boms b on b.id = m.bom_id join warehouses wi on wi.id = m.issue_wh join warehouses wo on wo.id = m.output_wh
  join products p on p.id = m.product_id join users cu on cu.id = m.created_by left join users xu on xu.id = m.closed_by`;

async function moRow(tx: Tx, no: string, forUpdate = false): Promise<MoRow> {
  if (forUpdate) await tx.query(`select id from retail_mos where no = $1 for update`, [no]);
  const r = await tx.query<MoRow>(`${MO_SELECT} where m.no = $1`, [no]);
  if (!r.rows[0]) throw E.notFound(`MO ${no} not found`);
  return r.rows[0];
}

export async function getMo(tx: Tx, ctx: Ctx, no: string): Promise<Mo> {
  readPerm(ctx);
  const m = await moRow(tx, no);
  const see = seeCost(ctx);
  const mats = await tx.query<{ id: string; product_id: string; name: string; unit_name: string; std_qty: string; issue_qty: string; returned_qty: string; cost: string; returned_cost: string }>(
    `select x.id, x.product_id, p.name, p.units->0->>'name' unit_name, x.std_qty::text, x.issue_qty::text, x.returned_qty::text, x.cost::text, x.returned_cost::text
       from retail_mo_materials x join products p on p.id = x.product_id where x.mo_id = $1 order by x.line_no`,
    [m.id],
  );
  const lots = await tx.query<{ doc_line_id: string; ref: string; received_at: Date; qty: string; unit_cost: string }>(
    `select mv.doc_line_id, l.ref, l.received_at, ml.qty::text, ml.unit_cost::text from stock_moves mv join stock_move_lots ml on ml.move_id = mv.id
       join stock_lots l on l.id = ml.lot_id where mv.doc_id = $1 and mv.qty < 0 order by l.received_at, l.id`,
    [m.id],
  );
  const outs = await tx.query<{ id: string; good_qty: string; reject_qty: string; note: string; by: string; created_at: Date }>(
    `select o.id, o.good_qty::text, o.reject_qty::text, o.note, u.name by, o.created_at from retail_mo_outputs o join users u on u.id = o.created_by where o.mo_id = $1 order by o.created_at, o.id`,
    [m.id],
  );
  return {
    id: m.id, no: m.no, date: m.date, productId: m.product_id, productName: m.product_name, unitName: m.unit_name, bomVersion: m.bom_version, planQty: qty4(m.plan_qty),
    issueWarehouse: { id: m.issue_wh, name: m.issue_wh_name }, outputWarehouse: { id: m.output_wh, name: m.output_wh_name }, status: m.status,
    materials: mats.rows.map((x) => ({
      productId: x.product_id, name: x.name, unitName: x.unit_name, stdQty: qty4(x.std_qty), issueQty: qty4(x.issue_qty), returnedQty: qty4(x.returned_qty),
      cost: see ? money(x.cost) : null, returnedCost: see ? money(x.returned_cost) : null,
      lots: lots.rows.filter((l) => l.doc_line_id === x.id).map((l) => ({ ref: l.ref, receivedAt: l.received_at.toISOString(), qty: qty4(l.qty), unitCost: see ? qty4(l.unit_cost) : null })),
    })),
    outputs: outs.rows.map((o) => ({ id: o.id, good: qty4(o.good_qty), reject: qty4(o.reject_qty), note: o.note, by: o.by, at: o.created_at.toISOString() })),
    goodQty: qty4(m.good_qty), rejectQty: qty4(m.reject_qty), yieldPct: yieldPct(m.good_qty, m.plan_qty),
    labourPerUnit: see ? qty4(m.labour_per_unit) : null, overheadPerUnit: see ? qty4(m.overhead_per_unit) : null,
    materialsCost: see ? money(d(m.materials_cost).minus(d(m.returned_cost))) : null, labourCost: see && m.labour_cost != null ? money(m.labour_cost) : null,
    overheadCost: see && m.overhead_cost != null ? money(m.overhead_cost) : null, unitCost: see && m.unit_cost != null ? qty4(m.unit_cost) : null,
    note: m.note, createdBy: m.created_by, createdAt: m.created_at.toISOString(), closedBy: m.closed_by, closedAt: iso(m.closed_at), cancelReason: m.cancel_reason,
  };
}

export async function listMos(tx: Tx, ctx: Ctx, q: { q?: string; limit: number; cursor?: string; status?: Mo['status'] }) {
  readPerm(ctx);
  const see = seeCost(ctx);
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.status) {
    params.push(q.status);
    where.push(`m.status = $${params.length}`);
  }
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(m.no ilike $${params.length} or p.name ilike $${params.length} or p.sku ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(m.created_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<MoRow>(`${MO_SELECT} ${where.length ? 'where ' + where.join(' and ') : ''} order by m.created_at desc, m.id desc limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (x) => [x.created_at.toISOString(), x.id], (m) => ({
    id: m.id, no: m.no, date: m.date, productId: m.product_id, productName: m.product_name, unitName: m.unit_name, planQty: qty4(m.plan_qty), status: m.status,
    goodQty: qty4(m.good_qty), rejectQty: qty4(m.reject_qty), yieldPct: yieldPct(m.good_qty, m.plan_qty),
    materialsCost: see ? money(d(m.materials_cost).minus(d(m.returned_cost))) : null, unitCost: see && m.unit_cost != null ? qty4(m.unit_cost) : null,
    createdBy: m.created_by, closedBy: m.closed_by,
  }));
}

/** REQ-M16-02: open an MO and issue materials (editable qty) FIFO from the issue warehouse into WIP. */
export async function createMo(tx: Tx, deps: Deps, ctx: Ctx, b: { productId: string; planQty: string; issueWarehouseId: string; outputWarehouseId: string; issues: { productId: string; qty: string }[]; note: string }): Promise<Mo> {
  requirePerm(ctx, 'inv.produce');
  if (!d(b.planQty).gt(0)) throw E.validation('Planned qty must be > 0');
  const issueWh = await requireWarehouse(tx, b.issueWarehouseId);
  const outWh = await requireWarehouse(tx, b.outputWarehouseId);
  const bom = await activeBom(tx, b.productId);
  const product = (await loadProducts(tx, [b.productId])).get(b.productId)!;
  const materials = await loadProducts(tx, bom.components.map((c) => c.productId));
  const given = new Map<string, string>();
  for (const x of b.issues) {
    if (!bom.components.some((c) => c.productId === x.productId)) throw E.validation('Only materials of the active BOM can be issued');
    if (given.has(x.productId)) throw E.validation('A material appears twice');
    if (d(x.qty).lt(0)) throw E.validation('Issue qty must not be negative');
    given.set(x.productId, qty4(x.qty));
  }
  const lines = bom.components.map((c) => {
    const std = bomSuggest(c.qtyPerUnit, b.planQty);
    return { productId: c.productId, std, issue: given.get(c.productId) ?? std };
  });
  if (!lines.some((l) => d(l.issue).gt(0))) throw E.validation('Issue at least one material');

  const no = await nextDocNo(tx, ctx.tenantId, 'MO', deps.today());
  const issuing = lines.filter((l) => d(l.issue).gt(0));
  // BR-07: lock and plan before writing anything; a shortage aborts with 409.
  const lots = await lockLots(tx, issueWh.id, issuing.map((l) => l.productId));
  const plans = planTakes(lots, issueWh.id, issuing.map((l) => ({ productId: l.productId, qty: l.issue })));
  const moId = (await tx.query<{ id: string }>(
    `insert into retail_mos (tenant_id, no, date, product_id, bom_id, plan_qty, issue_wh, output_wh, labour_per_unit, overhead_per_unit, note, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [ctx.tenantId, no, deps.today(), product.id, bom.id, b.planQty, issueWh.id, outWh.id, bom.labour_per_unit, bom.overhead_per_unit, b.note, ctx.userId],
  )).rows[0]!.id;
  let total = d(0);
  for (const [i, l] of lines.entries()) {
    const pl = plans[issuing.indexOf(l)];
    const cost = pl ? pl.cogs : '0';
    total = total.plus(d(cost));
    const lineId = (await tx.query<{ id: string }>(
      `insert into retail_mo_materials (tenant_id, mo_id, line_no, product_id, std_qty, issue_qty, cost) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [ctx.tenantId, moId, i + 1, l.productId, l.std, l.issue, cost],
    )).rows[0]!.id;
    if (pl) await applyOut(tx, ctx, issueWh.id, pl, { docType: 'MO', docNo: no, docId: moId, docLineId: lineId, note: `เบิกผลิต ${product.name}` });
  }
  await tx.query(`update retail_mos set materials_cost = $2 where id = $1`, [moId, money(total)]);
  await deps.hooks.beforeCommit?.('createMo', tx);
  await writeAudit(tx, ctx, [{
    action: 'issue', object: 'MO', ref: no,
    detail: `${product.name} ${qty4(b.planQty)} ${product.units[0]!.name} · เบิก ${issuing.map((l) => `${materials.get(l.productId)!.name.split(' ')[0]} ${l.issue}${l.issue !== l.std ? ` (สูตร ${l.std})` : ''}`).join(', ')} · วัตถุดิบ ฿${fmtTHB(total)}`,
  }]);
  return getMo(tx, ctx, no);
}

/** REQ-M16-03: record output (good / reject); may be called several times while the MO is in progress. */
export async function recordOutput(tx: Tx, ctx: Ctx, no: string, b: { good: string; reject: string; note: string }): Promise<Mo> {
  requirePerm(ctx, 'inv.produce');
  const m = await moRow(tx, no, true);
  if (m.status !== 'wip') throw E.conflict(`${no} is ${m.status}`);
  if (!d(b.good).plus(d(b.reject)).gt(0)) throw E.validation('Enter a good or reject qty');
  await tx.query(`insert into retail_mo_outputs (tenant_id, mo_id, good_qty, reject_qty, note, created_by) values ($1,$2,$3,$4,$5,$6)`, [ctx.tenantId, m.id, b.good, b.reject, b.note, ctx.userId]);
  await tx.query(`update retail_mos set good_qty = good_qty + $2, reject_qty = reject_qty + $3 where id = $1`, [m.id, b.good, b.reject]);
  await writeAudit(tx, ctx, [{ action: 'output', object: 'MO', ref: no, detail: `${m.product_name} ดี ${qty4(b.good)} เสีย ${qty4(b.reject)}${b.note ? ' · ' + b.note : ''}` }]);
  return getMo(tx, ctx, no);
}

/** Close: return leftovers, cost the good units, receive them as one FIFO lot at that unit cost. */
export async function closeMo(tx: Tx, deps: Deps, ctx: Ctx, no: string, b: { returns: { productId: string; qty: string }[]; labourPerUnit?: string; overheadPerUnit?: string }): Promise<Mo> {
  requirePerm(ctx, 'inv.produce');
  const m = await moRow(tx, no, true);
  if (m.status !== 'wip') throw E.conflict(`${no} is ${m.status}`);
  if (!d(m.good_qty).gt(0)) throw E.validation('Record the good output before closing (or cancel the MO)');
  const mats = (await tx.query<{ id: string; product_id: string; issue_qty: string; cost: string; returned_qty: string }>(
    `select id, product_id, issue_qty::text, cost::text, returned_qty::text from retail_mo_materials where mo_id = $1 order by line_no`, [m.id])).rows;
  let returnedCost = d(0);
  const seen = new Set<string>();
  const retText: string[] = [];
  for (const r of b.returns.filter((x) => d(x.qty).gt(0))) {
    if (seen.has(r.productId)) throw E.validation('A material appears twice');
    seen.add(r.productId);
    const x = mats.find((y) => y.product_id === r.productId);
    if (!x) throw E.validation('Returned material was not issued on this MO');
    const left = d(x.issue_qty).minus(d(x.returned_qty));
    if (d(r.qty).gt(left)) throw E.validation(`Return qty ${qty4(r.qty)} is more than issued (${qty4(left)})`);
    // BR-21: back into stock at the unit cost it was issued at.
    const unitCost = qty4(d(x.cost).div(d(x.issue_qty)));
    const value = money(d(unitCost).times(d(r.qty)));
    const lotId = await addLot(tx, ctx, { productId: x.product_id, warehouseId: m.issue_wh, qty: qty4(r.qty), unitCost, ref: no });
    await recordIn(tx, ctx, m.issue_wh, x.product_id, [{ lotId, qty: qty4(r.qty), unitCost }], { docType: 'MO', docNo: no, docId: m.id, docLineId: x.id, note: `คืนวัตถุดิบเหลือจาก ${no}` });
    await tx.query(`update retail_mo_materials set returned_qty = returned_qty + $2, returned_cost = returned_cost + $3 where id = $1`, [x.id, r.qty, value]);
    returnedCost = returnedCost.plus(d(value));
    retText.push(`${qty4(r.qty)}`);
  }
  const labourPer = b.labourPerUnit ?? m.labour_per_unit;
  const overheadPer = b.overheadPerUnit ?? m.overhead_per_unit;
  const labour = money(d(labourPer).times(d(m.good_qty)));
  const overhead = money(d(overheadPer).times(d(m.good_qty)));
  const used = d(m.materials_cost).minus(d(m.returned_cost)).minus(returnedCost);
  const unit = moUnitCost({ materials: used, labour, overhead, good: m.good_qty });
  const lotId = await addLot(tx, ctx, { productId: m.product_id, warehouseId: m.output_wh, qty: qty4(m.good_qty), unitCost: unit, ref: no });
  await recordIn(tx, ctx, m.output_wh, m.product_id, [{ lotId, qty: qty4(m.good_qty), unitCost: unit }], { docType: 'MO', docNo: no, docId: m.id, note: `ผลิตเสร็จ ${no} (ดี ${qty4(m.good_qty)} เสีย ${qty4(m.reject_qty)})` });
  await tx.query(
    `update retail_mos set status = 'closed', returned_cost = returned_cost + $2, labour_per_unit = $3, overhead_per_unit = $4, labour_cost = $5, overhead_cost = $6,
       unit_cost = $7, lot_id = $8, closed_by = $9, closed_at = now() where id = $1`,
    [m.id, money(returnedCost), labourPer, overheadPer, labour, overhead, unit, lotId, ctx.userId],
  );
  await deps.hooks.beforeCommit?.('closeMo', tx);
  await writeAudit(tx, ctx, [{
    action: 'close', object: 'MO', ref: no,
    detail: `${m.product_name} ดี ${qty4(m.good_qty)} เสีย ${qty4(m.reject_qty)} · ผลได้ ${yieldPct(m.good_qty, m.plan_qty)}% · ทุน/หน่วย ${fmtTHB(unit)}${retText.length ? ` · คืนวัตถุดิบ ${retText.length} รายการ` : ''}`,
  }]);
  return getMo(tx, ctx, no);
}

/** Cancel an MO with no output yet: every issued material goes back into its original lots (BR-21/22). */
export async function cancelMo(tx: Tx, ctx: Ctx, no: string, reason: string): Promise<Mo> {
  requirePerm(ctx, 'inv.produce');
  const m = await moRow(tx, no, true);
  if (m.status !== 'wip') throw E.conflict(`${no} is ${m.status}`);
  const outs = await tx.query(`select 1 from retail_mo_outputs where mo_id = $1 limit 1`, [m.id]);
  if (outs.rowCount) throw E.downstreamFirst(`${no} already has output; close it instead`);
  await reverseOuts(tx, ctx, m.id, { docType: 'MO', docNo: no, docId: m.id, note: `คืนสต็อก · ยกเลิก ${no}` });
  await tx.query(`update retail_mo_materials set returned_qty = issue_qty, returned_cost = cost where mo_id = $1`, [m.id]);
  await tx.query(`update retail_mos set status = 'cancelled', returned_cost = materials_cost, cancel_reason = $2, closed_by = $3, closed_at = now() where id = $1`, [m.id, reason, ctx.userId]);
  await writeAudit(tx, ctx, [{ action: 'void', object: 'MO', ref: no, detail: `${m.product_name} · ${reason} · คืนวัตถุดิบเข้าล็อตเดิม` }]);
  return getMo(tx, ctx, no);
}

/** REQ-M16-04 per-MO report: BOM standard vs used, yield, unit cost vs standard (data for group E). */
export async function moReport(tx: Tx, ctx: Ctx, q: { from?: string; to?: string }) {
  readPerm(ctx);
  const see = seeCost(ctx);
  const params: unknown[] = [];
  const where: string[] = [`m.status <> 'cancelled'`];
  if (q.from) { params.push(q.from); where.push(`m.date >= $${params.length}::date`); }
  if (q.to) { params.push(q.to); where.push(`m.date <= $${params.length}::date`); }
  const rows = (await tx.query<MoRow>(`${MO_SELECT} where ${where.join(' and ')} order by m.date desc, m.no desc limit 500`, params)).rows;
  const items = [];
  for (const m of rows) {
    const mats = (await tx.query<{ name: string; std_qty: string; issue_qty: string; returned_qty: string; cost: string; returned_cost: string }>(
      `select p.name, x.std_qty::text, x.issue_qty::text, x.returned_qty::text, x.cost::text, x.returned_cost::text from retail_mo_materials x join products p on p.id = x.product_id where x.mo_id = $1 order by x.line_no`,
      [m.id],
    )).rows;
    const used = sum(mats.map((x) => d(x.cost).minus(d(x.returned_cost))));
    // Standard cost per unit = BOM qty × the actual issue unit cost + standard labour / overhead.
    const stdMat = sum(mats.map((x) => (d(x.issue_qty).gt(0) ? d(x.cost).div(d(x.issue_qty)).times(d(x.std_qty)) : d(0))));
    const stdUnit = d(m.plan_qty).gt(0) ? stdMat.div(d(m.plan_qty)).plus(d(m.labour_per_unit)).plus(d(m.overhead_per_unit)) : null;
    items.push({
      no: m.no, date: m.date, productName: m.product_name, status: m.status, planQty: qty4(m.plan_qty), goodQty: qty4(m.good_qty), rejectQty: qty4(m.reject_qty),
      yieldPct: yieldPct(m.good_qty, m.plan_qty),
      materials: mats.map((x) => {
        const usedQty = d(x.issue_qty).minus(d(x.returned_qty));
        return { name: x.name, stdQty: qty4(x.std_qty), usedQty: qty4(usedQty), varianceQty: qty4(usedQty.minus(d(x.std_qty))), cost: see ? money(d(x.cost).minus(d(x.returned_cost))) : null };
      }),
      stdUnitCost: see && stdUnit ? qty4(stdUnit) : null,
      unitCost: see ? (m.unit_cost != null ? qty4(m.unit_cost) : d(m.good_qty).gt(0) ? qty4(used.div(d(m.good_qty))) : null) : null,
    });
  }
  return { items };
}
