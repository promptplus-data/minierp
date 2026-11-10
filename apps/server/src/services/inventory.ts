/** Inventory (M05, M06): balances, lots, manual receipt, transfer, issue, adjustment request / approval. */
import type { Tx } from '@erp/db';
import type { StockDoc } from '@erp/contracts';
import { allocate, d, fmtTHB, money, movingAverage, qty4, sum , searchTokens } from '@erp/core';
import { writeAudit } from '../lib/audit';
import { can, requireAny, requirePerm, type Ctx, type Deps } from '../lib/context';
import { nextDocNo } from '../lib/docno';
import { E, isUuid } from '../lib/errors';
import { decodeCursor, likeEscape, pageOf } from '../lib/paging';
import { addLot, applyOut, currentAvgCost, lockLots, planTakes, recordIn, type LockedLot } from '../lib/stock';
import { billDiscountMode, onGoodsReceipt, type GrHookLine } from '../modules/purchasing/grhook';

/** F9: unit costs in stock documents are shown only with data.cost. */
export const maskStockDoc = (ctx: Ctx, doc: StockDoc): StockDoc =>
  can(ctx, 'data.cost') === 1 ? doc : { ...doc, lines: doc.lines.map((l) => ({ ...l, unitCost: null })) };
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

/**
 * Open sales-order quantity not delivered yet, per product × warehouse (REQ-M06-01 reserved). A sales order without a
 * warehouse reserves in the default sellable warehouse (the one its delivery would cut by default). Held POS bills do
 * not reserve: they are carts parked at the counter, not commitments, and stock is checked when they are paid.
 * Reserved never blocks a sale or delivery (only on hand does, BR-07); it is shown so staff do not promise the same goods twice.
 */
export const RESERVED_CTE = `
  reserved as (
    select l.product_id, coalesce(so.warehouse_id, (select w0.id from warehouses w0 where w0.active and w0.kind = 'normal' order by w0.is_pos, w0.code limit 1)) warehouse_id,
           sum(greatest(l.base_qty - coalesce((select sum(dl.base_qty) from sales_delivery_lines dl join sales_deliveries dv on dv.id = dl.delivery_id
                                                where dl.so_line_id = l.id and dv.status = 'active'), 0), 0)) q
      from sales_order_lines l join sales_orders so on so.id = l.so_id
     where so.status = 'active' and so.dlv_status <> 'delivered'
     group by 1, 2
  )`;

export async function balances(tx: Tx, q: { q?: string; limit: number; cursor?: string; warehouseId?: string; productId?: string; damaged?: 'exclude' | 'include' | 'only' }) {
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where = [`p.kind = 'stock'`, `p.active`, `w.active`];
  if (q.warehouseId) {
    if (!isUuid(q.warehouseId)) throw E.validation('Unknown warehouse');
    params.push(q.warehouseId);
    where.push(`w.id = $${params.length}`);
  }
  // Damaged-goods warehouses are not sellable stock: left out of the totals unless asked for (or that warehouse is picked).
  const damaged = q.damaged ?? (q.warehouseId ? 'include' : 'exclude');
  if (damaged === 'exclude') where.push(`w.kind <> 'damaged'`);
  if (damaged === 'only') where.push(`w.kind = 'damaged'`);
  if (q.productId) {
    if (!isUuid(q.productId)) throw E.validation('Unknown product');
    params.push(q.productId);
    where.push(`p.id = $${params.length}`);
  }
  for (const word of searchTokens(q.q)) {
    params.push(`%${likeEscape(word)}%`);
    where.push(`(p.name ilike $${params.length} or p.sku ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(p.sku, w.code) > ($${params.length - 1}, $${params.length})`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<{ product_id: string; warehouse_id: string; sku: string; code: string; qty: string; reserved: string; damaged: boolean }>(
    `with ${RESERVED_CTE}
     select p.id product_id, w.id warehouse_id, p.sku, w.code, w.kind = 'damaged' damaged,
            coalesce((select sum(l.remaining) from stock_lots l where l.product_id = p.id and l.warehouse_id = w.id), 0)::text qty,
            coalesce(r.q, 0)::text reserved
       from products p cross join warehouses w
       left join reserved r on r.product_id = p.id and r.warehouse_id = w.id
      where ${where.join(' and ')}
      order by p.sku, w.code limit $${params.length}`,
    params,
  );
  return pageOf(r.rows, q.limit, (x) => [x.sku, x.code], (x) => ({
    productId: x.product_id, warehouseId: x.warehouse_id, qty: qty4(x.qty), reserved: qty4(x.reserved),
    available: x.damaged ? '0' : qty4(d(x.qty).minus(d(x.reserved))), damaged: x.damaged,
  }));
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
  req: { vendorId: string; vendorInvoiceNo: string; deliveryNo: string; warehouseId: string; lines: (LineIn & { unitCost: string })[]; billDiscount: string; note?: string },
): Promise<StockDoc> {
  requirePerm(ctx, 'inv.receive');
  if (!isUuid(req.vendorId) || !(await tx.query(`select 1 from vendors where id = $1`, [req.vendorId])).rowCount) throw E.validation('Unknown vendor');
  const wh = await requireWarehouse(tx, req.warehouseId);
  const dup = await tx.query<{ no: string }>(`select no from stock_docs where vendor_id = $1 and vendor_invoice_no = $2`, [req.vendorId, req.vendorInvoiceNo]);
  if (dup.rows[0]) throw E.conflict(`Vendor invoice ${req.vendorInvoiceNo} was already received as ${dup.rows[0].no}`);
  if (req.lines.some((l) => d(l.unitCost).lt(0))) throw E.validation('Unit cost must not be negative');
  const lines = await baseLines(tx, req.lines);
  const amounts = req.lines.map((l) => money(d(l.qty).times(d(l.unitCost))));
  if (d(req.billDiscount).lt(0) || d(req.billDiscount).gt(sum(amounts))) throw E.validation('Bill discount must be between 0 and the receipt total');
  // BR-19: the bill discount reduces lot cost only when the shop chose 'alloc'; by default it is a separate purchase discount.
  const mode = await billDiscountMode(tx);
  const disc = mode === 'alloc' ? allocate(req.billDiscount, amounts) : amounts.map(() => '0');
  const no = await nextDocNo(tx, ctx.tenantId, 'GR', deps.today());
  const docId = await newId(tx);
  const out: StockDoc['lines'] = [];
  const grLines: GrHookLine[] = [];
  for (const [i, l] of lines.entries()) {
    const net = d(amounts[i]!).minus(disc[i]!);
    const unitCost = qty4(net.div(d(l.baseQty)));
    // Moving-average product cost (shown as product.cost), from the CURRENT cost and stock before this lot, so
    // several lines of one product in a receipt chain correctly.
    const prev = await tx.query<{ q: string | null; cost: string }>(
      `select (select sum(remaining) from stock_lots where product_id = $1)::text q, cost::text from products where id = $1`, [l.p.id]);
    await tx.query(`update products set cost = $1 where id = $2`, [movingAverage(prev.rows[0]?.q ?? 0, prev.rows[0]!.cost, l.baseQty, unitCost), l.p.id]);
    const lotId = await addLot(tx, ctx, { productId: l.p.id, warehouseId: wh.id, qty: l.baseQty, unitCost, ref: no });
    await recordIn(tx, ctx, wh.id, l.p.id, [{ lotId, qty: l.baseQty, unitCost }], { docType: 'GR', docNo: no, docId, note: `รับสินค้า · ${req.vendorInvoiceNo}` });
    out.push({ productId: l.p.id, qty: l.baseQty, unitCost });
    const rl = req.lines[i]!;
    grLines.push({ productId: l.p.id, warehouseId: wh.id, unitIdx: rl.unitIdx, unitName: unitOf(l.p, rl.unitIdx).name, unitFactor: l.factor, qty: rl.qty, baseQty: l.baseQty, unitPrice: rl.unitCost, amount: amounts[i]!, lotUnitCost: unitCost, lotId });
  }
  const total = money(sum(amounts).minus(d(req.billDiscount)));
  const doc = await insertStockDocWithId(tx, ctx, docId, {
    no, type: 'GR', date: deps.today(), warehouseId: wh.id, vendorId: req.vendorId, vendorInvoiceNo: req.vendorInvoiceNo, deliveryNo: req.deliveryNo, lines: out, total,
    reason: req.note?.trim() || undefined, // GR note (หมายเหตุ) lives in stock_docs.reason
  });
  const apNo = await onGoodsReceipt(tx, ctx, { docId, no, date: deps.today(), vendorId: req.vendorId, vendorInvoiceNo: req.vendorInvoiceNo, billDiscount: req.billDiscount, mode, lines: grLines, note: req.note?.trim() ?? '' }); // REQ-M18-01
  await deps.hooks.beforeCommit?.('receipt', tx);
  await writeAudit(tx, ctx, [{ action: 'create', object: 'GR', ref: no, detail: `${wh.name} · ใบกำกับ ${req.vendorInvoiceNo} · ใบส่งของ ${req.deliveryNo} · ${out.length} รายการ · ฿${fmtTHB(total)} · ตั้งเจ้าหนี้ ${apNo}` }]);
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
  // Damaged goods may move between warehouses (e.g. to the store they go back to the vendor from), so both ends opt in.
  const from = await requireWarehouse(tx, req.fromWarehouseId, { damaged: true });
  const to = await requireWarehouse(tx, req.toWarehouseId, { damaged: true });
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
  const wh = await requireWarehouse(tx, req.warehouseId, { damaged: true });
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

type AdjLineState = 'approved' | 'rejected' | 'recount';
interface AdjLine { productId: string; qtyDelta: string; state?: AdjLineState }
interface AdjRow { id: string; requested_by_id: string; no: string; warehouse_id: string; lines: AdjLine[]; reason: string; note: string; status: 'pending' | 'approved' | 'rejected'; requested_by: string; decided_by: string | null; result_doc_no: string | null; created_at: Date; count_no: string | null }
const ADJ_SELECT = `select a.id, a.requested_by requested_by_id, a.no, a.warehouse_id, a.lines, a.reason, a.note, a.status, ru.name requested_by, du.name decided_by, a.result_doc_no, a.created_at,
    (select c.no from stock_count_lines cl join stock_counts c on c.id = cl.count_id where cl.adjust_request_id = a.id limit 1) count_no
  from adjust_requests a join users ru on ru.id = a.requested_by left join users du on du.id = a.decided_by`;
const toAdj = (r: AdjRow) => ({
  id: r.id, no: r.no, warehouseId: r.warehouse_id, lines: r.lines, reason: r.reason, note: r.note, status: r.status, requestedBy: r.requested_by,
  decidedBy: r.decided_by, resultDocNo: r.result_doc_no, createdAt: r.created_at.toISOString(), countNo: r.count_no,
});
const adjById = async (tx: Tx, id: string) => toAdj((await tx.query<AdjRow>(`${ADJ_SELECT} where a.id = $1`, [id])).rows[0]!);
const signed = (q: string) => `${d(q).gt(0) ? '+' : ''}${q}`;

export async function requestAdjust(tx: Tx, deps: Deps, ctx: Ctx, req: { warehouseId: string; lines: { productId: string; qtyDelta: string }[]; reason: string; note?: string }) {
  requireAny(ctx, ['inv.adj', 'inv.count']);
  // A write-off of damaged goods is an adjustment of the damaged-goods warehouse.
  const wh = await requireWarehouse(tx, req.warehouseId, { damaged: true });
  const products = await loadProducts(tx, req.lines.map((l) => l.productId));
  const seen = new Set<string>();
  for (const l of req.lines) {
    if (products.get(l.productId)!.kind !== 'stock') throw E.validation('Services have no stock');
    if (d(l.qtyDelta).isZero()) throw E.validation('qtyDelta must not be 0');
    if (seen.has(l.productId)) throw E.validation(`${products.get(l.productId)!.sku} appears twice`);
    seen.add(l.productId);
  }
  const no = await nextDocNo(tx, ctx.tenantId, 'RQ', deps.today());
  const lines = req.lines.map((l) => ({ productId: l.productId, qtyDelta: qty4(l.qtyDelta) }));
  const note = req.note?.trim() ?? '';
  const r = await tx.query<{ id: string }>(
    `insert into adjust_requests (tenant_id, no, warehouse_id, lines, reason, note, requested_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [ctx.tenantId, no, wh.id, JSON.stringify(lines), req.reason, note, ctx.userId],
  );
  await writeAudit(tx, ctx, [{ action: 'request', object: 'stock-adjust', ref: no, detail: `${wh.name} · ${lines.map((l) => `${products.get(l.productId)!.sku} ${signed(l.qtyDelta)}`).join(', ')} · ${req.reason}${note ? ' · ' + note : ''}` }]);
  return adjById(tx, r.rows[0]!.id);
}

export async function listAdjust(tx: Tx, ctx: Ctx, q: { limit: number; cursor?: string; status?: string; q?: string }) {
  requireAny(ctx, ['inv.adj', 'inv.adjApprove', 'inv.count']);
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.status) {
    params.push(q.status);
    where.push(`a.status = $${params.length}`);
  }
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(a.no ilike $${params.length} or a.reason ilike $${params.length} or a.note ilike $${params.length})`);
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

/**
 * Sends count lines back to counting (สั่งนับใหม่): the previous count is kept in prev_counted_qty, the round number
 * goes up and the count reopens. The snapshot and opened_at stay, so moves during the whole round remain netted.
 */
export async function resetCountLines(tx: Tx, countId: string, productIds: string[]): Promise<void> {
  const c = await tx.query<{ round: number }>(`update stock_counts set status = 'counting', round = round + 1 where id = $1 returning round`, [countId]);
  await tx.query(
    `update stock_count_lines set state = 'counting', prev_counted_qty = coalesce(counted_qty, prev_counted_qty), counted_qty = null, counted_by = null,
            counted_at = null, moved_qty = null, adjust_request_id = null, round = $3
      where count_id = $1 and product_id = any($2::uuid[])`,
    [countId, productIds, c.rows[0]!.round],
  );
}

/** Marks lines of a pending request as sent back to recount; a request with nothing left to decide is closed as rejected. */
export async function markRecount(tx: Tx, ctx: Ctx, a: { id: string; lines: AdjLine[] }, productIds: string[]): Promise<void> {
  const ids = new Set(productIds);
  const lines = a.lines.map((l) => (ids.has(l.productId) && !l.state ? { ...l, state: 'recount' as const } : l));
  const done = lines.every((l) => l.state);
  await tx.query(
    `update adjust_requests set lines = $2, status = case when $3 then 'rejected' else status end,
            decided_by = case when $3 then $4::uuid else decided_by end, decided_at = case when $3 then now() else decided_at end where id = $1`,
    [a.id, JSON.stringify(lines), done, ctx.userId],
  );
}

/**
 * Line-by-line decision on a pending adjustment request (REQ-M06-06 partial approval). Approved lines are applied in one
 * ADJ document: decreases consume FIFO lots (shortage → 409, nothing written), increases add a lot at the current FIFO
 * average cost. Lines not listed are rejected. recount sends lines of a stock count back to counting. Self-approval is
 * forbidden (owner excepted).
 */
export async function decideAdjust(tx: Tx, deps: Deps, ctx: Ctx, id: string, req: { approve: string[]; reject: string[]; recount: string[]; note?: string }) {
  requirePerm(ctx, 'inv.adjApprove');
  const a = await lockPending(tx, id);
  const open = a.lines.filter((l) => !l.state);
  const openIds = new Set(open.map((l) => l.productId));
  const listed = [...req.approve, ...req.reject, ...req.recount];
  if (new Set(listed).size !== listed.length) throw E.validation('A line can have only one decision');
  const bad = listed.find((p) => !openIds.has(p));
  if (bad) throw E.validation(`Product ${bad} is not an open line of ${a.no}`);
  if (req.approve.length && a.requested_by_id === ctx.userId && ctx.role !== 'owner') throw E.forbidden('You cannot approve your own adjustment request', { reason: 'SELF_APPROVAL' });
  const countLines = await tx.query<{ count_id: string; product_id: string }>(`select count_id, product_id from stock_count_lines where adjust_request_id = $1`, [a.id]);
  if (req.recount.length) {
    const fromCount = new Set(countLines.rows.map((x) => x.product_id));
    if (req.recount.some((p) => !fromCount.has(p))) throw E.validation('Only lines of a stock count can be sent back to recount');
  }
  const approve = new Set(req.approve);
  const recount = new Set(req.recount);
  const stateOf = (pid: string): AdjLineState => (approve.has(pid) ? 'approved' : recount.has(pid) ? 'recount' : 'rejected');
  const products = await loadProducts(tx, a.lines.map((l) => l.productId));
  const approved = open.filter((l) => approve.has(l.productId));

  let doc: StockDoc | null = null;
  if (approved.length) {
    const no = await nextDocNo(tx, ctx.tenantId, 'ADJ', deps.today());
    const docId = await newId(tx);
    const decreases = approved.filter((l) => d(l.qtyDelta).lt(0)).map((l) => ({ p: products.get(l.productId)!, baseQty: qty4(d(l.qtyDelta).neg()) }));
    const { plans } = await takeOut(tx, ctx, a.warehouse_id, decreases, { docType: 'ADJ', docNo: no, docId, note: `ปรับยอด: ${a.reason}` });
    const out: StockDoc['lines'] = plans.map((p) => ({ productId: p.productId, qty: d(p.qty).neg().toFixed(), unitCost: qty4(d(p.cogs).div(d(p.qty))) }));
    for (const l of approved.filter((x) => d(x.qtyDelta).gt(0))) {
      const unitCost = await currentAvgCost(tx, l.productId);
      const lotId = await addLot(tx, ctx, { productId: l.productId, warehouseId: a.warehouse_id, qty: l.qtyDelta, unitCost, ref: no });
      await recordIn(tx, ctx, a.warehouse_id, l.productId, [{ lotId, qty: l.qtyDelta, unitCost }], { docType: 'ADJ', docNo: no, docId, note: `ปรับยอด: ${a.reason}` });
      out.push({ productId: l.productId, qty: l.qtyDelta, unitCost });
    }
    doc = await insertStockDocWithId(tx, ctx, docId, { no, type: 'ADJ', date: deps.today(), warehouseId: a.warehouse_id, reason: `${a.no} · ${a.reason}`, lines: out });
  }
  // Lines decided earlier (sent back to recount from the count page) keep their state.
  const lines = a.lines.map((l) => (l.state ? l : { ...l, state: stateOf(l.productId) }));
  const partial = lines.some((l) => l.state !== lines[0]!.state);
  const note = req.note?.trim() ?? '';
  await tx.query(
    `update adjust_requests set status = $2, decided_by = $3, decided_at = now(), result_doc_no = $4, lines = $5,
            note = case when $6 = '' then note when note = '' then $6 else note || ' · ' || $6 end where id = $1`,
    [a.id, approved.length ? 'approved' : 'rejected', ctx.userId, doc?.no ?? null, JSON.stringify(partial ? lines : a.lines), note],
  );
  // Stock-count lines follow the decision; recount lines reopen the count.
  for (const st of ['approved', 'rejected'] as const) {
    const ids = open.filter((l) => stateOf(l.productId) === st).map((l) => l.productId);
    if (ids.length) await tx.query(`update stock_count_lines set state = $3 where adjust_request_id = $1 and product_id = any($2::uuid[])`, [a.id, ids, st]);
  }
  if (req.recount.length) await resetCountLines(tx, countLines.rows[0]!.count_id, req.recount);

  await deps.hooks.beforeCommit?.('approveAdjust', tx);
  const sku = (pid: string) => products.get(pid)!.sku;
  const parts = [
    approved.length ? `อนุมัติ ${approved.map((l) => `${sku(l.productId)} ${signed(l.qtyDelta)}`).join(', ')}` : '',
    open.filter((l) => stateOf(l.productId) === 'rejected').length ? `ไม่อนุมัติ ${open.filter((l) => stateOf(l.productId) === 'rejected').map((l) => sku(l.productId)).join(', ')}` : '',
    req.recount.length ? `สั่งนับใหม่ ${req.recount.map(sku).join(', ')}` : '',
  ].filter(Boolean).join(' · ');
  await writeAudit(tx, ctx, [{
    action: approved.length ? 'approve' : 'reject', object: 'stock-adjust', ref: doc?.no ?? a.no,
    detail: `${a.no} · ${parts} · ขอโดย ${a.requested_by}${note ? ' · ' + note : ''}`,
  }]);
  return { request: await adjById(tx, a.id), doc };
}

/** Approves every open line (the whole request). */
export async function approveAdjust(tx: Tx, deps: Deps, ctx: Ctx, id: string) {
  requirePerm(ctx, 'inv.adjApprove');
  const a = await lockPending(tx, id);
  const r = await decideAdjust(tx, deps, ctx, id, { approve: a.lines.filter((l) => !l.state).map((l) => l.productId), reject: [], recount: [] });
  return { request: r.request, doc: r.doc! };
}

export async function rejectAdjust(tx: Tx, deps: Deps, ctx: Ctx, id: string, note?: string) {
  requirePerm(ctx, 'inv.adjApprove');
  const a = await lockPending(tx, id);
  return (await decideAdjust(tx, deps, ctx, id, { approve: [], reject: a.lines.filter((l) => !l.state).map((l) => l.productId), recount: [], note })).request;
}
