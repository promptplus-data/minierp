/** Inventory (M05, M06): balances, lots, manual receipt, transfer, issue, adjustment request / approval. */
import type { Tx } from '@erp/db';
import type { StockDoc } from '@erp/contracts';
import { allocate, d, fmtTHB, money, movingAverage, qty4, sum } from '@erp/core';
import { writeAudit } from '../lib/audit';
import { requireAny, requirePerm, type Ctx, type Deps } from '../lib/context';
import { nextDocNo } from '../lib/docno';
import { E, isUuid } from '../lib/errors';
import { decodeCursor, likeEscape, pageOf } from '../lib/paging';
import { addLot, applyOut, currentAvgCost, lockLots, planTakes, recordIn, type LockedLot } from '../lib/stock';
import { loadProducts, requireWarehouse, unitOf, type ProductRow } from './master';

interface LineIn { productId: string; unitIdx: number; qty: string }

/** Validates lines (stock products, qty > 0) and converts to base units. */
async function baseLines(tx: Tx, lines: LineIn[]): Promise<{ p: ProductRow; qty: string; baseQty: string; factor: string }[]> {
  const products = await loadProducts(tx, lines.map((l) => l.productId));
  return lines.map((l, i) => {
    const p = products.get(l.productId)!;
    if (p.kind !== 'stock') throw E.validation(`Line ${i + 1}: ${p.sku} is a service and has no stock`);
    if (!d(l.qty).gt(0)) throw E.validation(`Line ${i + 1}: qty must be > 0`);
    const u = unitOf(p, l.unitIdx);
    return { p, qty: l.qty, baseQty: qty4(d(l.qty).times(d(u.factor))), factor: u.factor };
  });
}

interface StockDocInput {
  no: string; type: StockDoc['type']; date: string; warehouseId: string; toWarehouseId?: string | null; vendorId?: string; vendorInvoiceNo?: string;
  deliveryNo?: string; reason?: string; lines: StockDoc['lines']; total?: string;
}

/** The document id is needed for the ledger before stock_docs is written; reserve one. */
const newId = async (tx: Tx) => (await tx.query<{ id: string }>(`select gen_random_uuid() id`)).rows[0]!.id;

async function insertStockDocWithId(tx: Tx, ctx: Ctx, id: string, doc: StockDocInput): Promise<StockDoc> {
  await tx.query(
    `insert into stock_docs (id, tenant_id, no, type, date, warehouse_id, to_warehouse_id, vendor_id, vendor_invoice_no, delivery_no, reason, lines, total, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, ctx.tenantId, doc.no, doc.type, doc.date, doc.warehouseId, doc.toWarehouseId ?? null, doc.vendorId ?? null, doc.vendorInvoiceNo ?? null,
      doc.deliveryNo ?? null, doc.reason ?? null, JSON.stringify(doc.lines), doc.total ?? null, ctx.userId],
  );
  return { id, no: doc.no, type: doc.type, date: doc.date, warehouseId: doc.warehouseId, toWarehouseId: doc.toWarehouseId ?? null, lines: doc.lines };
}

// ---------- reads ----------

export async function balances(tx: Tx, q: { q?: string; limit: number; cursor?: string; warehouseId?: string; productId?: string }) {
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where = [`p.kind = 'stock'`, `p.active`, `w.active`];
  if (q.warehouseId) {
    if (!isUuid(q.warehouseId)) throw E.validation('Unknown warehouse');
    params.push(q.warehouseId);
    where.push(`w.id = $${params.length}`);
  }
  if (q.productId) {
    if (!isUuid(q.productId)) throw E.validation('Unknown product');
    params.push(q.productId);
    where.push(`p.id = $${params.length}`);
  }
  for (const word of (q.q ?? '').trim().split(/\s+/).filter(Boolean)) {
    params.push(`%${likeEscape(word)}%`);
    where.push(`(p.name ilike $${params.length} or p.sku ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(p.sku, w.code) > ($${params.length - 1}, $${params.length})`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<{ product_id: string; warehouse_id: string; sku: string; code: string; qty: string }>(
    `select p.id product_id, w.id warehouse_id, p.sku, w.code,
            coalesce((select sum(l.remaining) from stock_lots l where l.product_id = p.id and l.warehouse_id = w.id), 0)::text qty
       from products p cross join warehouses w
      where ${where.join(' and ')}
      order by p.sku, w.code limit $${params.length}`,
    params,
  );
  return pageOf(r.rows, q.limit, (x) => [x.sku, x.code], (x) => ({ productId: x.product_id, warehouseId: x.warehouse_id, qty: qty4(x.qty) }));
}

export async function lots(tx: Tx, ctx: Ctx, q: { limit: number; cursor?: string; warehouseId?: string; productId?: string }) {
  requirePerm(ctx, 'inv.view', { readOnly: true });
  requirePerm(ctx, 'data.cost'); // unit costs
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where = ['remaining > 0'];
  for (const [col, v] of [['warehouse_id', q.warehouseId], ['product_id', q.productId]] as const) {
    if (!v) continue;
    if (!isUuid(v)) throw E.validation(`Bad ${col}`);
    params.push(v);
    where.push(`${col} = $${params.length}`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(received_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<{ id: string; product_id: string; warehouse_id: string; received_at: Date; remaining: string; unit_cost: string; ref: string }>(
    `select id::text, product_id, warehouse_id, received_at, remaining::text, unit_cost::text, ref from stock_lots
      where ${where.join(' and ')} order by received_at, id limit $${params.length}`,
    params,
  );
  return pageOf(r.rows, q.limit, (l) => [l.received_at.toISOString(), l.id], (l) => ({
    id: l.id, productId: l.product_id, warehouseId: l.warehouse_id, receivedAt: l.received_at.toISOString(), qty: qty4(l.remaining), unitCost: qty4(l.unit_cost), ref: l.ref,
  }));
}

// ---------- writes ----------

export async function receipt(
  tx: Tx, deps: Deps, ctx: Ctx,
  req: { vendorId: string; vendorInvoiceNo: string; deliveryNo: string; warehouseId: string; lines: (LineIn & { unitCost: string })[]; billDiscount: string },
): Promise<StockDoc> {
  requirePerm(ctx, 'inv.receive');
  if (!isUuid(req.vendorId) || !(await tx.query(`select 1 from vendors where id = $1`, [req.vendorId])).rowCount) throw E.validation('Unknown vendor');
  const wh = await requireWarehouse(tx, req.warehouseId);
  const dup = await tx.query<{ no: string }>(`select no from stock_docs where vendor_id = $1 and vendor_invoice_no = $2`, [req.vendorId, req.vendorInvoiceNo]);
  if (dup.rows[0]) throw E.conflict(`Vendor invoice ${req.vendorInvoiceNo} was already received as ${dup.rows[0].no}`);
  const lines = await baseLines(tx, req.lines);
  const amounts = req.lines.map((l) => money(d(l.qty).times(d(l.unitCost))));
  if (d(req.billDiscount).lt(0) || d(req.billDiscount).gt(sum(amounts))) throw E.validation('Bill discount must be between 0 and the receipt total');
  const disc = allocate(req.billDiscount, amounts);
  const no = await nextDocNo(tx, ctx.tenantId, 'GR', deps.today());
  const docId = await newId(tx);
  const out: StockDoc['lines'] = [];
  for (const [i, l] of lines.entries()) {
    const net = d(amounts[i]!).minus(disc[i]!);
    const unitCost = qty4(net.div(d(l.baseQty)));
    // moving-average product cost (shown as product.cost) before the new lot is added
    const prev = await tx.query<{ q: string | null }>(`select sum(remaining)::text q from stock_lots where product_id = $1`, [l.p.id]);
    await tx.query(`update products set cost = $1 where id = $2`, [movingAverage(prev.rows[0]?.q ?? 0, l.p.cost, l.baseQty, unitCost), l.p.id]);
    const lotId = await addLot(tx, ctx, { productId: l.p.id, warehouseId: wh.id, qty: l.baseQty, unitCost, ref: no });
    await recordIn(tx, ctx, wh.id, l.p.id, [{ lotId, qty: l.baseQty, unitCost }], { docType: 'GR', docNo: no, docId, note: `รับสินค้า · ${req.vendorInvoiceNo}` });
    out.push({ productId: l.p.id, qty: l.baseQty, unitCost });
  }
  const total = money(sum(amounts).minus(d(req.billDiscount)));
  const doc = await insertStockDocWithId(tx, ctx, docId, {
    no, type: 'GR', date: deps.today(), warehouseId: wh.id, vendorId: req.vendorId, vendorInvoiceNo: req.vendorInvoiceNo, deliveryNo: req.deliveryNo, lines: out, total,
  });
  await deps.hooks.beforeCommit?.('receipt', tx);
  await writeAudit(tx, ctx, [{ action: 'create', object: 'GR', ref: no, detail: `${wh.name} · ใบกำกับ ${req.vendorInvoiceNo} · ใบส่งของ ${req.deliveryNo} · ${out.length} รายการ · ฿${fmtTHB(total)}` }]);
  return doc;
}

/** Locks, plans and writes stock-outs for lines in one warehouse. Returns the plans with the locked lots. */
async function takeOut(tx: Tx, ctx: Ctx, warehouseId: string, lines: { p: ProductRow; baseQty: string }[], ref: { docType: string; docNo: string; docId: string; note: string }) {
  const locked = await lockLots(tx, warehouseId, lines.map((l) => l.p.id));
  const plans = planTakes(locked, warehouseId, lines.map((l) => ({ productId: l.p.id, qty: l.baseQty })));
  for (const pl of plans) await applyOut(tx, ctx, warehouseId, pl, ref);
  const byId = new Map<string, LockedLot>();
  for (const ls of locked.values()) for (const l of ls) byId.set(l.id, l);
  return { plans, lotById: byId };
}

export async function transfer(tx: Tx, deps: Deps, ctx: Ctx, req: { fromWarehouseId: string; toWarehouseId: string; lines: LineIn[]; note?: string }): Promise<StockDoc> {
  requireAny(ctx, ['inv.adj', 'inv.receive']);
  if (req.fromWarehouseId === req.toWarehouseId) throw E.validation('Pick a destination different from the source');
  const from = await requireWarehouse(tx, req.fromWarehouseId);
  const to = await requireWarehouse(tx, req.toWarehouseId);
  const lines = await baseLines(tx, req.lines);
  const no = await nextDocNo(tx, ctx.tenantId, 'TR', deps.today());
  const docId = await newId(tx);
  const { plans, lotById } = await takeOut(tx, ctx, from.id, lines, { docType: 'TR', docNo: no, docId, note: `โอนออก → ${to.name}` });
  for (const pl of plans) {
    // Same received date and unit cost in the destination, so FIFO order and value carry over.
    const takes = [];
    for (const t of pl.takes) {
      const src = lotById.get(t.lotId)!;
      const lotId = await addLot(tx, ctx, { productId: pl.productId, warehouseId: to.id, qty: t.qty, unitCost: t.unitCost, ref: src.ref, receivedAt: src.receivedAt, sourceLotId: src.id });
      takes.push({ lotId, qty: t.qty, unitCost: t.unitCost });
    }
    await recordIn(tx, ctx, to.id, pl.productId, takes, { docType: 'TR', docNo: no, docId, note: `รับโอน ← ${from.name}` });
  }
  const doc = await insertStockDocWithId(tx, ctx, docId, {
    no, type: 'TR', date: deps.today(), warehouseId: from.id, toWarehouseId: to.id, reason: req.note,
    lines: plans.map((p) => ({ productId: p.productId, qty: p.qty, unitCost: null })),
  });
  await deps.hooks.beforeCommit?.('transfer', tx);
  await writeAudit(tx, ctx, [{ action: 'create', object: 'TR', ref: no, detail: `${from.name} → ${to.name} · ${lines.length} รายการ${req.note ? ' · ' + req.note : ''}` }]);
  return doc;
}

export async function issue(tx: Tx, deps: Deps, ctx: Ctx, req: { warehouseId: string; lines: LineIn[]; reason: string }): Promise<StockDoc> {
  requirePerm(ctx, 'inv.adj');
  const wh = await requireWarehouse(tx, req.warehouseId);
  const lines = await baseLines(tx, req.lines);
  const no = await nextDocNo(tx, ctx.tenantId, 'ADJ', deps.today());
  const docId = await newId(tx);
  const { plans } = await takeOut(tx, ctx, wh.id, lines, { docType: 'ADJ', docNo: no, docId, note: `เบิก: ${req.reason}` });
  const doc = await insertStockDocWithId(tx, ctx, docId, {
    no, type: 'ADJ', date: deps.today(), warehouseId: wh.id, reason: req.reason,
    lines: plans.map((p) => ({ productId: p.productId, qty: d(p.qty).neg().toFixed(), unitCost: d(p.qty).gt(0) ? qty4(d(p.cogs).div(d(p.qty))) : null })),
  });
  await deps.hooks.beforeCommit?.('issue', tx);
  await writeAudit(tx, ctx, [{ action: 'create', object: 'ADJ', ref: no, detail: `เบิก ${wh.name} · ${lines.length} รายการ · ${req.reason}` }]);
  return doc;
}

interface AdjRow { id: string; no: string; warehouse_id: string; lines: { productId: string; qtyDelta: string }[]; reason: string; status: 'pending' | 'approved' | 'rejected'; requested_by: string; decided_by: string | null; result_doc_no: string | null; created_at: Date }
const ADJ_SELECT = `select a.id, a.no, a.warehouse_id, a.lines, a.reason, a.status, ru.name requested_by, du.name decided_by, a.result_doc_no, a.created_at
  from adjust_requests a join users ru on ru.id = a.requested_by left join users du on du.id = a.decided_by`;
const toAdj = (r: AdjRow) => ({
  id: r.id, no: r.no, warehouseId: r.warehouse_id, lines: r.lines, reason: r.reason, status: r.status, requestedBy: r.requested_by,
  decidedBy: r.decided_by, resultDocNo: r.result_doc_no, createdAt: r.created_at.toISOString(),
});

export async function requestAdjust(tx: Tx, deps: Deps, ctx: Ctx, req: { warehouseId: string; lines: { productId: string; qtyDelta: string }[]; reason: string }) {
  requireAny(ctx, ['inv.adj', 'inv.count']);
  const wh = await requireWarehouse(tx, req.warehouseId);
  const products = await loadProducts(tx, req.lines.map((l) => l.productId));
  for (const l of req.lines) {
    if (products.get(l.productId)!.kind !== 'stock') throw E.validation('Services have no stock');
    if (d(l.qtyDelta).isZero()) throw E.validation('qtyDelta must not be 0');
  }
  const no = await nextDocNo(tx, ctx.tenantId, 'RQ', deps.today());
  const lines = req.lines.map((l) => ({ productId: l.productId, qtyDelta: qty4(l.qtyDelta) }));
  const r = await tx.query<{ id: string }>(
    `insert into adjust_requests (tenant_id, no, warehouse_id, lines, reason, requested_by) values ($1,$2,$3,$4,$5,$6) returning id`,
    [ctx.tenantId, no, wh.id, JSON.stringify(lines), req.reason, ctx.userId],
  );
  await writeAudit(tx, ctx, [{ action: 'request', object: 'stock-adjust', ref: no, detail: `${wh.name} · ${lines.map((l) => `${products.get(l.productId)!.sku} ${d(l.qtyDelta).gt(0) ? '+' : ''}${l.qtyDelta}`).join(', ')} · ${req.reason}` }]);
  return toAdj((await tx.query<AdjRow>(`${ADJ_SELECT} where a.id = $1`, [r.rows[0]!.id])).rows[0]!);
}

export async function listAdjust(tx: Tx, ctx: Ctx, q: { limit: number; cursor?: string; status?: string }) {
  requireAny(ctx, ['inv.adj', 'inv.adjApprove', 'inv.count']);
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.status) {
    params.push(q.status);
    where.push(`a.status = $${params.length}`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<AdjRow>(`${ADJ_SELECT} ${where.length ? 'where ' + where.join(' and ') : ''} order by a.created_at desc, a.id desc limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (a) => [a.created_at.toISOString(), a.id], toAdj);
}

async function lockPending(tx: Tx, id: string): Promise<AdjRow> {
  if (!isUuid(id)) throw E.notFound('Adjustment request not found');
  await tx.query(`select id from adjust_requests where id = $1 for update`, [id]);
  const r = await tx.query<AdjRow>(`${ADJ_SELECT} where a.id = $1`, [id]);
  const a = r.rows[0];
  if (!a) throw E.notFound('Adjustment request not found');
  if (a.status !== 'pending') throw E.conflict(`${a.no} is already ${a.status}`);
  return a;
}

/** Approval applies the deltas: decreases consume FIFO lots (shortage -> 409, request stays pending), increases add a lot at current FIFO average cost. */
export async function approveAdjust(tx: Tx, deps: Deps, ctx: Ctx, id: string) {
  requirePerm(ctx, 'inv.adjApprove');
  const a = await lockPending(tx, id);
  const products = await loadProducts(tx, a.lines.map((l) => l.productId));
  const no = await nextDocNo(tx, ctx.tenantId, 'ADJ', deps.today());
  const docId = await newId(tx);
  const decreases = a.lines.filter((l) => d(l.qtyDelta).lt(0)).map((l) => ({ p: products.get(l.productId)!, baseQty: qty4(d(l.qtyDelta).neg()) }));
  const { plans } = await takeOut(tx, ctx, a.warehouse_id, decreases, { docType: 'ADJ', docNo: no, docId, note: `ปรับยอด: ${a.reason}` });
  const out: StockDoc['lines'] = plans.map((p) => ({ productId: p.productId, qty: d(p.qty).neg().toFixed(), unitCost: qty4(d(p.cogs).div(d(p.qty))) }));
  for (const l of a.lines.filter((x) => d(x.qtyDelta).gt(0))) {
    const unitCost = await currentAvgCost(tx, l.productId);
    const lotId = await addLot(tx, ctx, { productId: l.productId, warehouseId: a.warehouse_id, qty: l.qtyDelta, unitCost, ref: no });
    await recordIn(tx, ctx, a.warehouse_id, l.productId, [{ lotId, qty: l.qtyDelta, unitCost }], { docType: 'ADJ', docNo: no, docId, note: `ปรับยอด: ${a.reason}` });
    out.push({ productId: l.productId, qty: l.qtyDelta, unitCost });
  }
  const doc = await insertStockDocWithId(tx, ctx, docId, { no, type: 'ADJ', date: deps.today(), warehouseId: a.warehouse_id, reason: `${a.no} · ${a.reason}`, lines: out });
  await tx.query(`update adjust_requests set status = 'approved', decided_by = $2, decided_at = now(), result_doc_no = $3 where id = $1`, [a.id, ctx.userId, no]);
  await deps.hooks.beforeCommit?.('approveAdjust', tx);
  await writeAudit(tx, ctx, [{ action: 'approve', object: 'stock-adjust', ref: no, detail: `${a.no} · ${a.lines.map((l) => `${products.get(l.productId)!.sku} ${d(l.qtyDelta).gt(0) ? '+' : ''}${l.qtyDelta}`).join(', ')} · ขอโดย ${a.requested_by}` }]);
  return { request: toAdj((await tx.query<AdjRow>(`${ADJ_SELECT} where a.id = $1`, [a.id])).rows[0]!), doc };
}

export async function rejectAdjust(tx: Tx, ctx: Ctx, id: string, note?: string) {
  requirePerm(ctx, 'inv.adjApprove');
  const a = await lockPending(tx, id);
  await tx.query(`update adjust_requests set status = 'rejected', decided_by = $2, decided_at = now() where id = $1`, [a.id, ctx.userId]);
  await writeAudit(tx, ctx, [{ action: 'reject', object: 'stock-adjust', ref: a.no, detail: `${a.reason}${note ? ' · ' + note : ''}` }]);
  return toAdj((await tx.query<AdjRow>(`${ADJ_SELECT} where a.id = $1`, [a.id])).rows[0]!);
}

