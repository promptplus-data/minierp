/**
 * Stock extras (M06): count sessions (BR-09 hidden system qty, variance → adjustment request needing approval),
 * stock ledger with running balance (REQ-M06-01 / NFR-05), reorder-point list, purchasing dashboard numbers and the
 * GR-overdue alert (BR-10 / REQ-M05-09).
 */
import type { Tx } from '@erp/db';
import type { StockCount } from '@erp/contracts';
import { addDays, d, apDaysOverdue, money, qty4, sum , searchTokens } from '@erp/core';
import { writeAudit } from '../../lib/audit';
import { can, requireAny, requirePerm, type Ctx, type Deps } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E, isUuid } from '../../lib/errors';
import { decodeCursor, likeEscape, pageOf } from '../../lib/paging';
import { requestAdjust } from '../../services/inventory';
import { requireWarehouse } from '../../services/master';

/** BR-10: drafts waiting longer than this many days raise the banner. */
export const GR_ALERT_DAYS = 2;

// ---------- stock count ----------
interface CountRow {
  id: string; no: string; warehouse_id: string; category: string | null; status: StockCount['status']; opened_by: string; opened_at: Date;
  submitted_at: Date | null; adjust_request_no: string | null; lines: number; counted: number;
}
const COUNT_SELECT = `
  select c.id, c.no, c.warehouse_id, c.category, c.status, u.name opened_by, c.opened_at, c.submitted_at, c.adjust_request_no,
         (select count(*)::int from stock_count_lines l where l.count_id = c.id) lines,
         (select count(*)::int from stock_count_lines l where l.count_id = c.id and l.counted_qty is not null) counted
    from stock_counts c join users u on u.id = c.opened_by`;
const toCount = (r: CountRow) => ({
  id: r.id, no: r.no, warehouseId: r.warehouse_id, category: r.category, status: r.status, openedBy: r.opened_by, openedAt: r.opened_at.toISOString(),
  submittedAt: r.submitted_at?.toISOString() ?? null, adjustRequestNo: r.adjust_request_no, lines: r.lines, counted: r.counted,
});

export async function listCounts(tx: Tx, ctx: Ctx, q: { q?: string; limit: number; cursor?: string }) {
  requireAny(ctx, ['inv.count', 'inv.adjApprove']);
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const conds: string[] = [];
  if (q.q?.trim()) {
    params.push(`%${likeEscape(q.q.trim())}%`);
    conds.push(`(c.no ilike $1 or coalesce(c.adjust_request_no,'') ilike $1)`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    conds.push(`(c.opened_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  const where = conds.length ? `where ${conds.join(' and ')}` : '';
  params.push(q.limit + 1);
  const r = await tx.query<CountRow>(`${COUNT_SELECT} ${where} order by c.opened_at desc, c.id desc limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (x) => [x.opened_at.toISOString(), x.id], toCount);
}

export async function openCount(tx: Tx, deps: Deps, ctx: Ctx, req: { warehouseId: string; category?: string; note?: string }) {
  requirePerm(ctx, 'inv.count');
  const wh = await requireWarehouse(tx, req.warehouseId);
  const open = await tx.query<{ no: string }>(`select no from stock_counts where warehouse_id = $1 and status = 'counting'`, [wh.id]);
  if (open.rows[0]) throw E.conflict(`${wh.name} มีรอบนับ ${open.rows[0].no} ที่ยังไม่ปิด`);
  const no = await nextDocNo(tx, ctx.tenantId, 'CNT', deps.today());
  const ins = await tx.query<{ id: string }>(
    `insert into stock_counts (tenant_id, no, warehouse_id, category, opened_by, note) values ($1,$2,$3,$4,$5,$6) returning id`,
    [ctx.tenantId, no, wh.id, req.category?.trim() || null, ctx.userId, req.note?.trim() || null]);
  const id = ins.rows[0]!.id;
  // Snapshot of the system quantity at open (REQ-M06-05: variance is against the system at the time the round opened).
  const params: unknown[] = [ctx.tenantId, id, wh.id];
  let cat = '';
  if (req.category?.trim()) {
    params.push(req.category.trim());
    cat = `and p.category = $4`;
  }
  const n = await tx.query(
    `insert into stock_count_lines (tenant_id, count_id, product_id, system_qty)
     select $1, $2, p.id, coalesce((select sum(l.remaining) from stock_lots l where l.product_id = p.id and l.warehouse_id = $3), 0)
       from products p where p.kind = 'stock' and p.active ${cat}`, params);
  if (!n.rowCount) throw E.validation('ไม่มีสินค้าให้นับในเงื่อนไขนี้');
  await writeAudit(tx, ctx, [{ action: 'open', object: 'stock-count', ref: no, detail: `${wh.name}${req.category ? ' · หมวด ' + req.category : ''} · ${n.rowCount} รายการ` }]);
  return getCount(tx, ctx, id, {});
}

async function lockCount(tx: Tx, id: string) {
  if (!isUuid(id)) throw E.notFound('ไม่พบรอบนับ');
  const r = await tx.query<{ id: string; no: string; status: string; warehouse_id: string; opened_at: Date }>(
    `select id, no, status, warehouse_id, opened_at from stock_counts where id = $1 for update`, [id]);
  if (!r.rows[0]) throw E.notFound('ไม่พบรอบนับ');
  return r.rows[0];
}

/** Moves of each product in the warehouse since the round opened (sales / receipts during counting). */
async function movesSince(tx: Tx, warehouseId: string, since: Date): Promise<Map<string, string>> {
  const r = await tx.query<{ product_id: string; q: string }>(
    `select product_id, sum(qty)::text q from stock_moves where warehouse_id = $1 and at > $2 group by product_id`, [warehouseId, since]);
  return new Map(r.rows.map((x) => [x.product_id, x.q]));
}

export async function getCount(tx: Tx, ctx: Ctx, id: string, q: { showSystem?: boolean }): Promise<StockCount> {
  requireAny(ctx, ['inv.count', 'inv.adjApprove']);
  if (!isUuid(id)) throw E.notFound('ไม่พบรอบนับ');
  const r = await tx.query<CountRow>(`${COUNT_SELECT} where c.id = $1`, [id]);
  const c = r.rows[0];
  if (!c) throw E.notFound('ไม่พบรอบนับ');
  // BR-09: while counting the system quantity is hidden; only inv.seeSys may reveal it on request.
  const hidden = c.status === 'counting' && !(q.showSystem && can(ctx, 'inv.seeSys') === 1);
  const lines = await tx.query<{ product_id: string; sku: string; name: string; units: { name: string }[]; barcode: string | null; system_qty: string; moved_qty: string | null; counted_qty: string | null; counted_by: string | null }>(
    `select l.product_id, p.sku, p.name, p.units, p.barcode, l.system_qty::text, l.moved_qty::text, l.counted_qty::text, u.name counted_by
       from stock_count_lines l join products p on p.id = l.product_id left join users u on u.id = l.counted_by
      where l.count_id = $1 order by p.category, p.sku`, [c.id]);
  const moves = c.status === 'counting' && !hidden ? await movesSince(tx, c.warehouse_id, c.opened_at) : null;
  return {
    ...toCount(c), systemHidden: hidden,
    items: lines.rows.map((l) => {
      const moved = l.moved_qty ?? moves?.get(l.product_id) ?? '0';
      const expected = d(l.system_qty).plus(d(moved));
      return {
        productId: l.product_id, sku: l.sku, name: l.name, unitName: l.units[0]?.name ?? '', barcode: l.barcode,
        systemQty: hidden ? null : qty4(l.system_qty), movedQty: hidden ? null : qty4(moved),
        countedQty: l.counted_qty == null ? null : qty4(l.counted_qty),
        variance: hidden || l.counted_qty == null ? null : qty4(d(l.counted_qty).minus(expected)),
        countedBy: l.counted_by,
      };
    }),
  };
}

export async function countEntry(tx: Tx, ctx: Ctx, id: string, req: { productId: string; qty: string; mode: 'set' | 'add' }) {
  requirePerm(ctx, 'inv.count');
  const c = await lockCount(tx, id);
  if (c.status !== 'counting') throw E.conflict(`${c.no} ปิดรอบแล้ว`);
  if (!isUuid(req.productId)) throw E.validation('Unknown product');
  const r = await tx.query<{ counted_qty: string | null }>(
    `update stock_count_lines set counted_qty = case when $3 = 'add' then coalesce(counted_qty, 0) + $4 else $4 end, counted_by = $5, counted_at = now()
      where count_id = $1 and product_id = $2 returning counted_qty::text`, [c.id, req.productId, req.mode, req.qty, ctx.userId]);
  if (!r.rows[0]) throw E.validation('สินค้านี้ไม่อยู่ในรอบนับ');
  return { productId: req.productId, countedQty: qty4(r.rows[0].counted_qty ?? 0) };
}

/**
 * Closes the round: variance = counted − (snapshot + moves during the count) for every counted line; non-zero
 * variances become ONE adjustment request (core adjust_requests) that needs owner/manager approval (BR-09).
 */
export async function submitCount(tx: Tx, deps: Deps, ctx: Ctx, id: string) {
  requirePerm(ctx, 'inv.count');
  const c = await lockCount(tx, id);
  if (c.status !== 'counting') throw E.conflict(`${c.no} ปิดรอบแล้ว`);
  const moves = await movesSince(tx, c.warehouse_id, c.opened_at);
  const lines = await tx.query<{ product_id: string; system_qty: string; counted_qty: string | null }>(
    `select product_id, system_qty::text, counted_qty::text from stock_count_lines where count_id = $1`, [c.id]);
  if (!lines.rows.some((l) => l.counted_qty != null)) throw E.validation('ยังไม่ได้นับสินค้าเลย');
  const deltas: { productId: string; qtyDelta: string }[] = [];
  for (const l of lines.rows) {
    const moved = moves.get(l.product_id) ?? '0';
    await tx.query(`update stock_count_lines set moved_qty = $1 where count_id = $2 and product_id = $3`, [moved, c.id, l.product_id]);
    if (l.counted_qty == null) continue;
    const v = d(l.counted_qty).minus(d(l.system_qty).plus(d(moved)));
    if (!v.isZero()) deltas.push({ productId: l.product_id, qtyDelta: qty4(v) });
  }
  let adj: { id: string; no: string } | null = null;
  if (deltas.length) adj = await requestAdjust(tx, deps, ctx, { warehouseId: c.warehouse_id, lines: deltas, reason: `ผลนับสต็อก ${c.no}` });
  await tx.query(`update stock_counts set status = 'submitted', submitted_by = $2, submitted_at = now(), adjust_request_id = $3, adjust_request_no = $4 where id = $1`,
    [c.id, ctx.userId, adj?.id ?? null, adj?.no ?? null]);
  await writeAudit(tx, ctx, [{ action: 'submit', object: 'stock-count', ref: c.no, detail: deltas.length ? `ผลต่าง ${deltas.length} รายการ → ${adj!.no} รออนุมัติ` : 'ตรงทุกรายการ' }]);
  return getCount(tx, ctx, c.id, {});
}

export async function cancelCount(tx: Tx, ctx: Ctx, id: string) {
  requirePerm(ctx, 'inv.count');
  const c = await lockCount(tx, id);
  if (c.status !== 'counting') throw E.conflict(`${c.no} ปิดรอบแล้ว`);
  await tx.query(`update stock_counts set status = 'cancelled' where id = $1`, [c.id]);
  await writeAudit(tx, ctx, [{ action: 'cancel', object: 'stock-count', ref: c.no, detail: 'ยกเลิกรอบนับ' }]);
  return getCount(tx, ctx, c.id, {});
}

// ---------- ledger ----------
export async function ledger(tx: Tx, ctx: Ctx, q: { q?: string; limit: number; cursor?: string; productId?: string; warehouseId?: string; from?: string; to?: string }) {
  requirePerm(ctx, 'inv.view', { readOnly: true });
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const part: string[] = [];
  for (const [col, v] of [['m.product_id', q.productId], ['m.warehouse_id', q.warehouseId]] as const) {
    if (!v) continue;
    if (!isUuid(v)) throw E.validation(`Bad ${col}`);
    params.push(v);
    part.push(`${col} = $${params.length}`);
  }
  // Text search filters the outer query only, so the running-balance window still sees every move.
  const outer: string[] = [];
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    outer.push(`(x.doc_no ilike $${params.length} or x.name ilike $${params.length} or x.sku ilike $${params.length} or x.note ilike $${params.length})`);
  }
  if (q.from) {
    params.push(q.from);
    outer.push(`(x.at at time zone 'Asia/Bangkok')::date >= $${params.length}::date`);
  }
  if (q.to) {
    params.push(q.to);
    outer.push(`(x.at at time zone 'Asia/Bangkok')::date <= $${params.length}::date`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    outer.push(`(x.at, x.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  // Balance after each move = current lot balance − later moves of the same product × warehouse (exact even when
  // opening lots were loaded without a ledger row).
  const r = await tx.query<{ id: string; at: Date; doc_type: string; doc_no: string; product_id: string; sku: string; name: string; units: { name: string }[]; warehouse_id: string; qty: string; cost: string; balance: string; note: string; user_name: string }>(
    `select * from (
       select m.id, m.at, m.doc_type, m.doc_no, m.product_id, p.sku, p.name, p.units, m.warehouse_id, m.qty::text, m.cost::text, m.note, u.name user_name,
              (coalesce((select sum(l.remaining) from stock_lots l where l.product_id = m.product_id and l.warehouse_id = m.warehouse_id), 0)
               - coalesce(sum(m.qty) over (partition by m.product_id, m.warehouse_id order by m.at desc, m.id desc rows between unbounded preceding and 1 preceding), 0))::text balance
         from stock_moves m join products p on p.id = m.product_id join users u on u.id = m.user_id
        ${part.length ? 'where ' + part.join(' and ') : ''}
     ) x ${outer.length ? 'where ' + outer.join(' and ') : ''}
     order by x.at desc, x.id desc limit $${params.length}`, params);
  const cost = can(ctx, 'data.cost') === 1;
  return pageOf(r.rows, q.limit, (x) => [x.at.toISOString(), x.id], (x) => ({
    id: x.id, at: x.at.toISOString(), docType: x.doc_type, docNo: x.doc_no, productId: x.product_id, sku: x.sku, name: x.name, unitName: x.units[0]?.name ?? '',
    warehouseId: x.warehouse_id, qty: qty4(x.qty), unitCost: cost && !d(x.qty).isZero() ? qty4(d(x.cost).div(d(x.qty)).abs()) : null,
    balance: qty4(x.balance), note: x.note, user: x.user_name,
  }));
}

// ---------- reorder ----------
const BELOW = `from products p left join (select product_id, sum(remaining) q from stock_lots group by product_id) s on s.product_id = p.id
  where p.kind = 'stock' and p.active and p.reorder_point > 0 and coalesce(s.q, 0) < p.reorder_point`;

export async function reorder(tx: Tx, ctx: Ctx, q: { q?: string; limit: number; cursor?: string }) {
  requireAny(ctx, ['inv.view', 'inv.receive', 'fin.ap'], { readOnly: true });
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(p.name ilike $${params.length} or p.sku ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(p.sku, p.id) > ($${params.length - 1}, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<{ id: string; sku: string; name: string; units: { name: string }[]; category: string; q: string; rp: string }>(
    `select p.id, p.sku, p.name, p.units, p.category, coalesce(s.q, 0)::text q, p.reorder_point::text rp ${BELOW} ${where.length ? 'and ' + where.join(' and ') : ''}
      order by p.sku, p.id limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (x) => [x.sku, x.id], (x) => ({
    productId: x.id, sku: x.sku, name: x.name, unitName: x.units[0]?.name ?? '', category: x.category, qty: qty4(x.q), reorderPoint: qty4(x.rp), shortBy: qty4(d(x.rp).minus(d(x.q))),
  }));
}

// ---------- GR overdue alert + dashboard ----------
export async function grAlerts(tx: Tx, deps: Deps) {
  const today = deps.today();
  const r = await tx.query<{ id: string; dn_no: string | null; dealer_name: string | null; received_on: string }>(
    `select id, dn_no, dealer_name, to_char(received_on,'YYYY-MM-DD') received_on from gr_drafts
      where status = 'draft' and received_on <= $1::date order by received_on, id limit 50`, [addDays(today, -GR_ALERT_DAYS)]);
  const n = await tx.query<{ n: number }>(`select count(*)::int n from gr_drafts where status = 'draft' and received_on <= $1::date`, [addDays(today, -GR_ALERT_DAYS)]);
  return {
    days: GR_ALERT_DAYS, count: n.rows[0]!.n,
    items: r.rows.map((x) => ({ id: x.id, dnNo: x.dn_no, dealer: x.dealer_name, receivedOn: x.received_on, ageDays: apDaysOverdue(x.received_on, today) })),
  };
}

export async function dashboard(tx: Tx, deps: Deps, ctx: Ctx) {
  const today = deps.today();
  const drafts = await tx.query<{ n: number; old: number }>(
    `select count(*)::int n, count(*) filter (where received_on <= $1::date)::int old from gr_drafts where status = 'draft'`, [addDays(today, -GR_ALERT_DAYS)]);
  const below = await tx.query<{ n: number }>(`select count(*)::int n ${BELOW}`);
  let apDue7 = { count: 0, amount: '0.00' };
  let apOverdue = { count: 0, amount: '0.00' };
  if (can(ctx, 'fin.ap') !== 0) {
    const ap = await tx.query<{ due: string; bal: string }>(
      `select to_char(due_date,'YYYY-MM-DD') due, (total - paid - returned)::text bal from ap_bills where status = 'active' and total - paid - returned > 0`);
    const soon = ap.rows.filter((x) => x.due >= today && x.due <= addDays(today, 7));
    const late = ap.rows.filter((x) => x.due < today);
    apDue7 = { count: soon.length, amount: money(sum(soon.map((x) => x.bal))) };
    apOverdue = { count: late.length, amount: money(sum(late.map((x) => x.bal))) };
  }
  return { draftCount: drafts.rows[0]!.n, overdueDrafts: drafts.rows[0]!.old, belowReorder: below.rows[0]!.n, apDue7, apOverdue };
}

