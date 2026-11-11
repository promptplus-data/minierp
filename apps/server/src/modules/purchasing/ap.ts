/**
 * M18 accounts payable: confirmed goods receipts, AP bills, aging, payment vouchers (several bills / partial,
 * transfer / cheque / cash, WHT 1% / 3%), vendor returns against a GR (stock out from that GR's lot first,
 * FOR UPDATE), purchase discounts (BR-19) and the purchasing settings.
 */
import type { Tx } from '@erp/db';
import type { ApBill, ApBillDetail, ApPayment, GrDetail, GrSummary, VendorReturn } from '@erp/contracts';
import {
  addDays, agingSummary, checkAllocations, d, apDaysOverdue, fmtTHB, money, qty4, sum, termLabel, vendorReturnAmounts, whtAmount,
  type BillDiscountMode, type FreeGoodsCosting, type PaymentTerm, searchTokens,
} from '@erp/core';
import { writeAudit } from '../../lib/audit';
import { can, requirePerm, type Ctx, type Deps } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E, isUuid } from '../../lib/errors';
import { decodeCursor, likeEscape, pageOf } from '../../lib/paging';
import { applyOut, lockLots, planTakes } from '../../lib/stock';
import { billDiscountMode, freeGoodsCosting } from './grhook';

const seeCost = (ctx: Ctx) => can(ctx, 'data.cost') === 1;
const words = (q?: string) => searchTokens(q);

// ---------- settings ----------
export async function getSettings(tx: Tx) {
  return { billDiscountMode: await billDiscountMode(tx), freeGoodsCosting: await freeGoodsCosting(tx) };
}

const FGC_TH: Record<FreeGoodsCosting, string> = { zero: 'ต้นทุน 0', allocate: 'เฉลี่ยต้นทุนตามมูลค่าตลาด' };

export async function updateSettings(tx: Tx, ctx: Ctx, s: { billDiscountMode?: BillDiscountMode; freeGoodsCosting?: FreeGoodsCosting }) {
  requirePerm(ctx, 'sys.settings');
  // How free goods are costed changes every later lot cost: the owner decides.
  if (s.freeGoodsCosting && ctx.role !== 'owner') throw E.forbidden('เฉพาะเจ้าของร้านเปลี่ยนวิธีคิดต้นทุนของแถมได้');
  const before = await getSettings(tx);
  const next = { billDiscountMode: s.billDiscountMode ?? before.billDiscountMode, freeGoodsCosting: s.freeGoodsCosting ?? before.freeGoodsCosting };
  await tx.query(
    `insert into purchasing_settings (tenant_id, bill_discount_mode, free_goods_costing, updated_by, updated_at) values ($1,$2,$3,$4,now())
     on conflict (tenant_id) do update set bill_discount_mode = excluded.bill_discount_mode, free_goods_costing = excluded.free_goods_costing,
       updated_by = excluded.updated_by, updated_at = now()`,
    [ctx.tenantId, next.billDiscountMode, next.freeGoodsCosting, ctx.userId],
  );
  const th = (m: BillDiscountMode) => (m === 'sep' ? 'แยกเป็นส่วนลดรับ' : 'กระจายเข้าทุนสินค้า');
  const audit = [];
  if (next.billDiscountMode !== before.billDiscountMode) audit.push({ action: 'update', object: 'purchasing-settings', ref: 'ส่วนลดท้ายบิลตอนซื้อ', detail: `${th(before.billDiscountMode)} → ${th(next.billDiscountMode)}` });
  if (next.freeGoodsCosting !== before.freeGoodsCosting) audit.push({ action: 'update', object: 'purchasing-settings', ref: 'วิธีคิดต้นทุนของแถม', detail: `${FGC_TH[before.freeGoodsCosting]} → ${FGC_TH[next.freeGoodsCosting]}` });
  if (audit.length) await writeAudit(tx, ctx, audit);
  return next;
}

// ---------- confirmed goods receipts ----------
interface GrRow {
  id: string; no: string; date: string; vendor_id: string | null; vendor_name: string | null; vendor_invoice_no: string | null; delivery_no: string | null;
  warehouse_id: string; total: string | null; ap_no: string | null; preview: string | null; qty_units: { unit: string; qty: string }[] | null; line_count: number; created_by: string; returnable: boolean; created_at: Date; discount: string | null; note: string | null;
  po_nos: string[] | null; void_at: Date | null; void_reason: string | null; void_by_name: string | null; over_receive_note: string | null;
}
const GR_SELECT = `
  select s.id, s.no, to_char(s.date,'YYYY-MM-DD') date, s.vendor_id, v.name vendor_name, s.vendor_invoice_no, s.delivery_no, s.warehouse_id, s.total::text,
         b.no ap_no, b.discount::text discount, u.name created_by, s.created_at, s.reason note,
         (select string_agg(p.name || ' × ' || trim_scale(g.qty)::text || ' ' || g.unit_name || case when g.free then ' (ของแถม)' else '' end, ', ' order by g.line_no) from gr_lines g join products p on p.id = g.product_id where g.gr_doc_id = s.id) preview,
         (select json_agg(json_build_object('unit', u.unit_name, 'qty', trim_scale(u.q)::text) order by u.first)
            from (select g.unit_name, sum(g.qty) q, min(g.line_no) first from gr_lines g where g.gr_doc_id = s.id group by g.unit_name) u) qty_units,
         (select count(*)::int from gr_lines g where g.gr_doc_id = s.id) line_count,
         s.void_at is null and exists (select 1 from gr_lines g where g.gr_doc_id = s.id and g.returned_base_qty < g.base_qty) returnable,
         (select array_agg(distinct po.no) from gr_lines g join purchase_orders po on po.id = g.po_id where g.gr_doc_id = s.id) po_nos,
         s.void_at, s.void_reason, vu.name void_by_name, s.over_receive_note
    from stock_docs s left join vendors v on v.id = s.vendor_id left join ap_bills b on b.gr_doc_id = s.id join users u on u.id = s.created_by
    left join users vu on vu.id = s.void_by`;
const toGr = (r: GrRow, ctx: Ctx): GrSummary => ({
  id: r.id, no: r.no, date: r.date, vendorId: r.vendor_id, vendorName: r.vendor_name, vendorInvoiceNo: r.vendor_invoice_no, deliveryNo: r.delivery_no,
  warehouseId: r.warehouse_id, total: r.total != null && seeCost(ctx) ? money(r.total) : null, apBillNo: r.ap_no, itemsPreview: r.preview ?? '', receivedQty: r.qty_units ?? [], lineCount: r.line_count,
  createdBy: r.created_by, returnable: r.returnable, note: r.note ?? '', poNos: r.po_nos ?? [], status: r.void_at ? 'void' : 'active', overReceiveNote: r.over_receive_note,
});

export async function listReceipts(tx: Tx, ctx: Ctx, q: { q?: string; limit: number; cursor?: string; returnable?: boolean }) {
  if (can(ctx, 'inv.receive') !== 1 && can(ctx, 'fin.ap') === 0) requirePerm(ctx, 'inv.view', { readOnly: true });
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where = [`s.type = 'GR'`];
  for (const w of words(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    const i = params.length;
    where.push(`(s.no ilike $${i} or coalesce(v.name,'') ilike $${i} or coalesce(s.vendor_invoice_no,'') ilike $${i} or coalesce(s.delivery_no,'') ilike $${i})`);
  }
  if (q.returnable) where.push(`s.void_at is null and exists (select 1 from gr_lines g where g.gr_doc_id = s.id and g.returned_base_qty < g.base_qty)`);
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(s.created_at, s.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<GrRow>(`${GR_SELECT} where ${where.join(' and ')} order by s.created_at desc, s.id desc limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (x) => [x.created_at.toISOString(), x.id], (x) => toGr(x, ctx));
}

export async function getReceipt(tx: Tx, ctx: Ctx, no: string): Promise<GrDetail> {
  if (can(ctx, 'inv.receive') !== 1 && can(ctx, 'fin.ap') === 0) requirePerm(ctx, 'inv.view', { readOnly: true });
  const r = await tx.query<GrRow>(`${GR_SELECT} where s.type = 'GR' and s.no = $1`, [no]);
  const g = r.rows[0];
  if (!g) throw E.notFound(`ไม่พบใบรับสินค้า ${no}`);
  const lines = await tx.query<{ id: string; line_no: number; product_id: string; name: string; warehouse_id: string; unit_idx: number; unit_name: string; unit_factor: string; qty: string; returned_base_qty: string; unit_price: string; amount: string; free: boolean;
    alloc_unit_cost: string | null; market_unit_price: string | null }>(
    `select g.id, g.line_no, g.product_id, p.name, g.warehouse_id, g.unit_idx, g.unit_name, g.unit_factor::text, g.qty::text, g.returned_base_qty::text, g.unit_price::text, g.amount::text, g.free,
            g.alloc_unit_cost::text, g.market_unit_price::text
       from gr_lines g join products p on p.id = g.product_id where g.gr_doc_id = $1 order by g.line_no`, [g.id]);
  const cost = seeCost(ctx);
  const rets = await tx.query<{ no: string; date: string; total: string }>(
    `select no, to_char(date,'YYYY-MM-DD') date, total::text from vendor_returns where gr_no = $1 order by created_at`, [g.no]);
  return {
    ...toGr(g, ctx),
    returns: rets.rows.map((x) => ({ no: x.no, date: x.date, total: money(x.total) })),
    billDiscount: cost && g.discount != null ? money(g.discount) : null,
    voided: g.void_at ? { by: g.void_by_name ?? '', at: g.void_at.toISOString(), reason: g.void_reason ?? '' } : null,
    lines: lines.rows.map((l) => ({
      id: l.id, lineNo: l.line_no, productId: l.product_id, name: l.name, warehouseId: l.warehouse_id, unitIdx: l.unit_idx, unitName: l.unit_name,
      unitFactor: qty4(l.unit_factor), qty: qty4(l.qty), returnedQty: qty4(d(l.returned_base_qty).div(d(l.unit_factor))),
      unitPrice: cost ? qty4(l.unit_price) : null, amount: cost ? money(l.amount) : null, free: l.free,
      allocUnitCost: cost && l.alloc_unit_cost != null ? qty4(l.alloc_unit_cost) : null, marketUnitPrice: cost && l.market_unit_price != null ? qty4(l.market_unit_price) : null,
    })),
    freeGoodsCosting: (await tx.query<{ m: FreeGoodsCosting | null }>(`select free_goods_costing m from stock_docs where id = $1`, [g.id])).rows[0]?.m ?? 'zero',
  };
}

// ---------- AP bills ----------
interface BillRow {
  id: string; no: string; source: 'gr' | 'opening'; vendor_id: string; vendor_name: string; term: PaymentTerm | null; vendor_invoice_no: string; gr_no: string | null;
  date: string; due_date: string; base: string; discount: string; discount_mode: BillDiscountMode; vat: string; total: string; paid: string; returned: string; created_by: string; created_at: Date; note: string;
}
const BILL_SELECT = `
  select b.id, b.no, b.source, b.vendor_id, v.name vendor_name, v.term, b.vendor_invoice_no, b.gr_no, to_char(b.date,'YYYY-MM-DD') date, to_char(b.due_date,'YYYY-MM-DD') due_date,
         b.base::text, b.discount::text, b.discount_mode, b.vat::text, b.total::text, b.paid::text, b.returned::text, u.name created_by, b.created_at, b.note
    from ap_bills b join vendors v on v.id = b.vendor_id join users u on u.id = b.created_by`;
const balanceOf = (r: { total: string; paid: string; returned: string }) => money(d(r.total).minus(d(r.paid)).minus(d(r.returned)));
const toBill = (r: BillRow, today: string): ApBill => ({
  id: r.id, no: r.no, source: r.source, vendorId: r.vendor_id, vendorName: r.vendor_name, vendorInvoiceNo: r.vendor_invoice_no, grNo: r.gr_no,
  date: r.date, dueDate: r.due_date, termLabel: r.source === 'opening' ? 'ยอดยกมา' : termLabel(r.term), base: money(r.base), discount: money(r.discount),
  discountMode: r.discount_mode, vat: money(r.vat), total: money(r.total), paid: money(r.paid), returned: money(r.returned), balance: balanceOf(r),
  overdueDays: Math.max(0, apDaysOverdue(r.due_date, today)), createdBy: r.created_by, note: r.note,
});

export async function listBills(tx: Tx, deps: Deps, ctx: Ctx, q: { q?: string; limit: number; cursor?: string; vendorId?: string; status: 'open' | 'all' }) {
  requirePerm(ctx, 'fin.ap', { readOnly: true });
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where = [`b.status = 'active'`];
  if (q.status === 'open') where.push(`b.total - b.paid - b.returned > 0`);
  if (q.vendorId) {
    if (!isUuid(q.vendorId)) throw E.validation('Unknown vendor');
    params.push(q.vendorId);
    where.push(`b.vendor_id = $${params.length}`);
  }
  for (const w of words(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    const i = params.length;
    where.push(`(b.no ilike $${i} or v.name ilike $${i} or b.vendor_invoice_no ilike $${i} or coalesce(b.gr_no,'') ilike $${i} or b.total::text like $${i})`);
  }
  // open bills: oldest due first (what to pay next); all bills: newest first
  const order = q.status === 'open' ? ['b.due_date', 'asc'] : ['b.created_at', 'desc'];
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(q.status === 'open'
      ? `(b.due_date, b.id) > ($${params.length - 1}::date, $${params.length}::uuid)`
      : `(b.created_at, b.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<BillRow>(`${BILL_SELECT} where ${where.join(' and ')} order by ${order[0]} ${order[1]}, b.id ${order[1]} limit $${params.length}`, params);
  const today = deps.today();
  return pageOf(r.rows, q.limit, (x) => (q.status === 'open' ? [x.due_date, x.id] : [x.created_at.toISOString(), x.id]), (x) => toBill(x, today));
}

/** One bill with the payment vouchers and vendor returns that settled it (so the bill, PV and return link both ways). */
export async function getBill(tx: Tx, deps: Deps, ctx: Ctx, no: string): Promise<ApBillDetail> {
  requirePerm(ctx, 'fin.ap', { readOnly: true });
  const r = await tx.query<BillRow>(`${BILL_SELECT} where b.no = $1`, [no]);
  const b = r.rows[0];
  if (!b) throw E.notFound(`ไม่พบบิลเจ้าหนี้ ${no}`);
  const pays = await tx.query<{ no: string; date: string; amount: string }>(
    `select p.no, to_char(p.date,'YYYY-MM-DD') date, a.amount::text from ap_payment_allocs a join ap_payments p on p.id = a.payment_id where a.bill_id = $1 order by p.created_at`, [b.id]);
  const rets = await tx.query<{ no: string; date: string; total: string; ap_applied: string }>(
    `select r.no, to_char(r.date,'YYYY-MM-DD') date, r.total::text, r.ap_applied::text from vendor_returns r where r.ap_bill_id = $1 order by r.created_at`, [b.id]);
  return {
    ...toBill(b, deps.today()),
    payments: pays.rows.map((x) => ({ no: x.no, date: x.date, amount: money(x.amount) })),
    returns: rets.rows.map((x) => ({ no: x.no, date: x.date, total: money(x.total), apApplied: money(x.ap_applied) })),
  };
}

/** หมายเหตุ on an AP bill (the note copied from its goods receipt can be corrected later). */
export async function updateBill(tx: Tx, deps: Deps, ctx: Ctx, no: string, body: { note: string }): Promise<ApBillDetail> {
  requirePerm(ctx, 'fin.ap');
  const r = await tx.query<{ id: string; note: string }>(`select id, note from ap_bills where no = $1 for update`, [no]);
  const b = r.rows[0];
  if (!b) throw E.notFound(`ไม่พบบิลเจ้าหนี้ ${no}`);
  const note = body.note.trim();
  if (note !== b.note) {
    await tx.query(`update ap_bills set note = $2 where id = $1`, [b.id, note]);
    await writeAudit(tx, ctx, [{ action: 'update', object: 'ap-bill', ref: no, detail: `หมายเหตุ: ${b.note || '-'} → ${note || '-'}` }]);
  }
  return getBill(tx, deps, ctx, no);
}

export async function aging(tx: Tx, deps: Deps, ctx: Ctx) {
  requirePerm(ctx, 'fin.ap', { readOnly: true });
  const today = deps.today();
  const r = await tx.query<{ vendor_id: string; vendor_name: string; due: string; bal: string }>(
    `select b.vendor_id, v.name vendor_name, to_char(b.due_date,'YYYY-MM-DD') due, (b.total - b.paid - b.returned)::text bal
       from ap_bills b join vendors v on v.id = b.vendor_id where b.status = 'active' and b.total - b.paid - b.returned > 0`,
  );
  const buckets = agingSummary(r.rows.map((x) => ({ due: x.due, balance: x.bal })), today);
  const soon = r.rows.filter((x) => x.due >= today && x.due <= addDays(today, 7));
  const vendors = new Map<string, { vendorId: string; vendorName: string; balance: ReturnType<typeof d>; bills: number }>();
  for (const x of r.rows) {
    const v = vendors.get(x.vendor_id) ?? { vendorId: x.vendor_id, vendorName: x.vendor_name, balance: d(0), bills: 0 };
    v.balance = v.balance.plus(d(x.bal));
    v.bills++;
    vendors.set(x.vendor_id, v);
  }
  const disc = await tx.query<{ s: string | null }>(
    `select sum(discount)::text s from ap_bills where status = 'active' and discount_mode = 'sep' and date >= date_trunc('month', $1::date) and date <= $1::date`, [today]);
  return {
    asOf: today, buckets, total: money(sum(r.rows.map((x) => x.bal))),
    dueSoon: { days: 7, count: soon.length, amount: money(sum(soon.map((x) => x.bal))) },
    vendors: [...vendors.values()].sort((a, b) => a.vendorName.localeCompare(b.vendorName, 'th')).map((v) => ({ ...v, balance: money(v.balance) })),
    purchaseDiscountMonth: money(disc.rows[0]?.s ?? 0),
  };
}

export async function purchaseDiscounts(tx: Tx, ctx: Ctx, q: { limit: number; cursor?: string }) {
  requirePerm(ctx, 'fin.ap', { readOnly: true });
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where = [`b.status = 'active'`, `b.discount > 0`, `b.discount_mode = 'sep'`];
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(b.created_at, b.id) < ($1::timestamptz, $2::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<BillRow>(`${BILL_SELECT} where ${where.join(' and ')} order by b.created_at desc, b.id desc limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (x) => [x.created_at.toISOString(), x.id], (x) => ({ billNo: x.no, grNo: x.gr_no, date: x.date, vendorName: x.vendor_name, amount: money(x.discount), createdBy: x.created_by }));
}

// ---------- payment vouchers ----------
const METHOD_TH = { transfer: 'โอนเงิน', cheque: 'เช็ค', cash: 'เงินสด' } as const;

async function loadPayment(tx: Tx, where: string, arg: string): Promise<ApPayment | null> {
  const r = await tx.query<{ id: string; no: string; date: string; vendor_id: string; vendor_name: string; method: ApPayment['method']; ref: string | null; amount: string; wht_rate: string; wht: string; net: string; note: string | null; created_by: string }>(
    `select p.id, p.no, to_char(p.date,'YYYY-MM-DD') date, p.vendor_id, v.name vendor_name, p.method, p.ref, p.amount::text, p.wht_rate::text, p.wht::text, p.net::text, p.note, u.name created_by
       from ap_payments p join vendors v on v.id = p.vendor_id join users u on u.id = p.created_by where ${where}`, [arg]);
  const p = r.rows[0];
  if (!p) return null;
  const a = await tx.query<{ bill_id: string; no: string; vendor_invoice_no: string; amount: string }>(
    `select a.bill_id, b.no, b.vendor_invoice_no, a.amount::text from ap_payment_allocs a join ap_bills b on b.id = a.bill_id where a.payment_id = $1 order by b.no`, [p.id]);
  return {
    id: p.id, no: p.no, date: p.date, vendorId: p.vendor_id, vendorName: p.vendor_name, method: p.method, ref: p.ref, amount: money(p.amount),
    whtRate: qty4(p.wht_rate), wht: money(p.wht), net: money(p.net), note: p.note, createdBy: p.created_by,
    bills: a.rows.map((x) => ({ billId: x.bill_id, billNo: x.no, vendorInvoiceNo: x.vendor_invoice_no, amount: money(x.amount) })),
  };
}

export async function getPayment(tx: Tx, ctx: Ctx, no: string) {
  requirePerm(ctx, 'fin.ap', { readOnly: true });
  const p = await loadPayment(tx, 'p.no = $1', no);
  if (!p) throw E.notFound(`ไม่พบใบสำคัญจ่าย ${no}`);
  return p;
}

export async function listPayments(tx: Tx, ctx: Ctx, q: { q?: string; limit: number; cursor?: string }) {
  requirePerm(ctx, 'fin.ap', { readOnly: true });
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  for (const w of words(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(p.no ilike $${params.length} or v.name ilike $${params.length} or coalesce(p.ref,'') ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(p.created_at, p.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<{ id: string; no: string; created_at: Date }>(
    `select p.id, p.no, p.created_at from ap_payments p join vendors v on v.id = p.vendor_id ${where.length ? 'where ' + where.join(' and ') : ''}
      order by p.created_at desc, p.id desc limit $${params.length}`, params);
  const pg = pageOf(r.rows, q.limit, (x) => [x.created_at.toISOString(), x.id], (x) => x.id);
  const items: ApPayment[] = [];
  for (const id of pg.items) items.push((await loadPayment(tx, 'p.id = $1', id))!);
  return { items, nextCursor: pg.nextCursor };
}

export async function createPayment(
  tx: Tx, deps: Deps, ctx: Ctx,
  req: { vendorId: string; method: ApPayment['method']; ref?: string; whtRate: 0 | 1 | 3; allocations: { billId: string; amount: string }[]; note?: string },
): Promise<ApPayment> {
  requirePerm(ctx, 'fin.ap');
  if (!isUuid(req.vendorId)) throw E.validation('Unknown vendor');
  const ids = req.allocations.map((a) => a.billId);
  if (ids.some((i) => !isUuid(i))) throw E.validation('Unknown bill');
  if (new Set(ids).size !== ids.length) throw E.validation('A bill appears twice in the payment');
  if (req.method === 'cheque' && !req.ref?.trim()) throw E.validation('กรอกเลขที่เช็ค');
  // Lock the bills (ordered by id) so two payments cannot overpay the same bill.
  const bills = await tx.query<{ id: string; no: string; vendor_id: string; status: string; total: string; paid: string; returned: string }>(
    `select id, no, vendor_id, status, total::text, paid::text, returned::text from ap_bills where id = any($1::uuid[]) order by id for update`, [ids]);
  const byId = new Map(bills.rows.map((b) => [b.id, b]));
  for (const id of ids) {
    const b = byId.get(id);
    if (!b || b.status !== 'active') throw E.validation('Unknown bill');
    if (b.vendor_id !== req.vendorId) throw E.validation(`${b.no} belongs to another vendor`);
  }
  const problem = checkAllocations(req.allocations.map((a) => { const b = byId.get(a.billId)!; return { billNo: b.no, amount: a.amount, balance: balanceOf(b) }; }));
  if (problem) throw E.validation(problem);
  const shop = await tx.query<{ vat_registered: boolean }>(`select vat_registered from tenants where id = $1`, [ctx.tenantId]);
  const amount = money(sum(req.allocations.map((a) => a.amount)));
  const wht = whtAmount(amount, req.whtRate, shop.rows[0]?.vat_registered ?? true);
  const net = money(d(amount).minus(d(wht)));
  const no = await nextDocNo(tx, ctx.tenantId, 'PV', deps.today());
  const ins = await tx.query<{ id: string }>(
    `insert into ap_payments (tenant_id, no, date, vendor_id, method, ref, amount, wht_rate, wht, net, note, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [ctx.tenantId, no, deps.today(), req.vendorId, req.method, req.ref?.trim() || null, amount, req.whtRate, wht, net, req.note?.trim() || null, ctx.userId]);
  for (const a of req.allocations) {
    await tx.query(`insert into ap_payment_allocs (tenant_id, payment_id, bill_id, amount) values ($1,$2,$3,$4)`, [ctx.tenantId, ins.rows[0]!.id, a.billId, money(a.amount)]);
    await tx.query(`update ap_bills set paid = paid + $1 where id = $2`, [money(a.amount), a.billId]);
  }
  await deps.hooks.beforeCommit?.('apPayment', tx);
  await writeAudit(tx, ctx, [{
    action: 'pay', object: 'payment-voucher', ref: no,
    detail: `${req.allocations.map((a) => byId.get(a.billId)!.no).join(', ')} · ฿${fmtTHB(amount)} · ${METHOD_TH[req.method]}${req.whtRate ? ` · หัก ณ ที่จ่าย ${req.whtRate}% ฿${fmtTHB(wht)}` : ''} · จ่ายจริง ฿${fmtTHB(net)}`,
  }]);
  return (await loadPayment(tx, 'p.id = $1', ins.rows[0]!.id))!;
}

// ---------- vendor returns ----------
async function loadReturn(tx: Tx, ctx: Ctx, where: string, arg: string): Promise<VendorReturn | null> {
  const r = await tx.query<{ id: string; no: string; date: string; vendor_id: string; vendor_name: string; gr_no: string; ap_no: string | null; reason: string; vendor_cn_no: string | null; base: string; vat: string; total: string; ap_applied: string; unapplied: string; cogs: string; created_by: string; note: string }>(
    `select r.id, r.no, to_char(r.date,'YYYY-MM-DD') date, r.vendor_id, v.name vendor_name, r.gr_no, b.no ap_no, r.reason, r.vendor_cn_no, r.base::text, r.vat::text, r.total::text,
            r.ap_applied::text, r.unapplied::text, r.cogs::text, u.name created_by, r.note
       from vendor_returns r join vendors v on v.id = r.vendor_id left join ap_bills b on b.id = r.ap_bill_id join users u on u.id = r.created_by where ${where}`, [arg]);
  const x = r.rows[0];
  if (!x) return null;
  const l = await tx.query<{ product_id: string; name: string; unit_name: string; qty: string; unit_price: string; amount: string }>(
    `select l.product_id, p.name, g.unit_name, l.qty::text, l.unit_price::text, l.amount::text
       from vendor_return_lines l join products p on p.id = l.product_id join gr_lines g on g.id = l.gr_line_id where l.return_id = $1 order by g.line_no`, [x.id]);
  return {
    id: x.id, no: x.no, date: x.date, vendorId: x.vendor_id, vendorName: x.vendor_name, grNo: x.gr_no, apBillNo: x.ap_no, reason: x.reason, vendorCnNo: x.vendor_cn_no,
    base: money(x.base), vat: money(x.vat), total: money(x.total), apApplied: money(x.ap_applied), unapplied: money(x.unapplied),
    cogs: seeCost(ctx) ? money(x.cogs) : null, createdBy: x.created_by, note: x.note,
    lines: l.rows.map((y) => ({ productId: y.product_id, name: y.name, unitName: y.unit_name, qty: qty4(y.qty), unitPrice: qty4(y.unit_price), amount: money(y.amount) })),
  };
}

export async function getReturn(tx: Tx, ctx: Ctx, no: string) {
  requirePerm(ctx, 'fin.ap', { readOnly: true });
  const r = await loadReturn(tx, ctx, 'r.no = $1', no);
  if (!r) throw E.notFound(`ไม่พบใบส่งคืน ${no}`);
  return r;
}

export async function listReturns(tx: Tx, ctx: Ctx, q: { q?: string; limit: number; cursor?: string }) {
  requirePerm(ctx, 'fin.ap', { readOnly: true });
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  for (const w of words(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(r.no ilike $${params.length} or v.name ilike $${params.length} or r.gr_no ilike $${params.length} or coalesce(r.vendor_cn_no,'') ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(r.created_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<{ id: string; created_at: Date }>(
    `select r.id, r.created_at from vendor_returns r join vendors v on v.id = r.vendor_id ${where.length ? 'where ' + where.join(' and ') : ''}
      order by r.created_at desc, r.id desc limit $${params.length}`, params);
  const pg = pageOf(r.rows, q.limit, (x) => [x.created_at.toISOString(), x.id], (x) => x.id);
  const items: VendorReturn[] = [];
  for (const id of pg.items) items.push((await loadReturn(tx, ctx, 'r.id = $1', id))!);
  return { items, nextCursor: pg.nextCursor };
}

export async function createReturn(
  tx: Tx, deps: Deps, ctx: Ctx, req: { grNo: string; lines: { grLineId: string; qty: string }[]; reason: string; vendorCnNo?: string; note?: string },
): Promise<VendorReturn> {
  requirePerm(ctx, 'fin.ap');
  const gr = await tx.query<{ id: string; no: string; vendor_id: string | null }>(`select id, no, vendor_id from stock_docs where type = 'GR' and no = $1`, [req.grNo]);
  const g = gr.rows[0];
  if (!g || !g.vendor_id) throw E.notFound(`ไม่พบใบรับสินค้า ${req.grNo}`);
  if (req.lines.some((l) => !isUuid(l.grLineId))) throw E.validation('Unknown GR line');
  if (new Set(req.lines.map((l) => l.grLineId)).size !== req.lines.length) throw E.validation('A GR line appears twice');
  // Lock the GR lines first (returned quantity), then the bill, then the lots (global lot order inside lockLots).
  const gl = await tx.query<{ id: string; product_id: string; warehouse_id: string; unit_factor: string; base_qty: string; returned_base_qty: string; unit_price: string; lot_id: string; name: string; unit_name: string }>(
    `select g.id, g.product_id, g.warehouse_id, g.unit_factor::text, g.base_qty::text, g.returned_base_qty::text, g.unit_price::text, g.lot_id::text, p.name, g.unit_name
       from gr_lines g join products p on p.id = g.product_id where g.gr_doc_id = $1 order by g.line_no for update of g`, [g.id]);
  const byId = new Map(gl.rows.map((l) => [l.id, l]));
  const lines = req.lines.filter((l) => d(l.qty).gt(0)).map((l) => {
    const row = byId.get(l.grLineId);
    if (!row) throw E.validation('The line is not on this goods receipt');
    const baseQty = qty4(d(l.qty).times(d(row.unit_factor)));
    const left = d(row.base_qty).minus(d(row.returned_base_qty));
    if (d(baseQty).gt(left)) throw E.validation(`${row.name}: คืนได้ไม่เกิน ${qty4(left.div(d(row.unit_factor)))} ${row.unit_name} (รับ − คืนแล้ว)`, { grLineId: row.id, max: qty4(left.div(d(row.unit_factor))) });
    return { req: l, row, baseQty };
  });
  if (!lines.length) throw E.validation('ใส่จำนวนคืนอย่างน้อย 1 รายการ');
  const bill = await tx.query<{ id: string; no: string; total: string; paid: string; returned: string }>(
    `select id, no, total::text, paid::text, returned::text from ap_bills where gr_doc_id = $1 and status = 'active' for update`, [g.id]);
  const b = bill.rows[0];
  const shop = await tx.query<{ vat_registered: boolean }>(`select vat_registered from tenants where id = $1`, [ctx.tenantId]);
  const amt = vendorReturnAmounts(lines.map((l) => ({ qty: l.req.qty, unitPrice: l.row.unit_price })), shop.rows[0]?.vat_registered ?? true, b ? balanceOf(b) : '0');
  const no = await nextDocNo(tx, ctx.tenantId, 'PR', deps.today());
  const retId = (await tx.query<{ id: string }>(`select gen_random_uuid() id`)).rows[0]!.id;

  // Stock out per warehouse: this GR's own lot first (its cost), then the warehouse's other lots FIFO (BR-07 / BR-21).
  const byWh = new Map<string, typeof lines>();
  for (const l of lines) byWh.set(l.row.warehouse_id, [...(byWh.get(l.row.warehouse_id) ?? []), l]);
  const cogsByLine = new Map<string, string>();
  for (const [wh, ls] of byWh) {
    const locked = await lockLots(tx, wh, ls.map((l) => l.row.product_id));
    // core.takeLots consumes oldest first: date the GR's own lot first in this in-memory plan only.
    for (const l of ls) for (const x of locked.get(l.row.product_id) ?? []) if (x.id === l.row.lot_id) x.receivedAt = '0000-00-00T00:00:00';
    const plans = planTakes(locked, wh, ls.map((l) => ({ productId: l.row.product_id, qty: l.baseQty })));
    for (const [i, pl] of plans.entries()) {
      await applyOut(tx, ctx, wh, pl, { docType: 'PR', docNo: no, docId: retId, docLineId: ls[i]!.row.id, note: `ส่งคืนผู้ขาย · ${g.no}` });
      cogsByLine.set(ls[i]!.row.id, pl.cogs);
    }
  }
  const cogs = money(sum([...cogsByLine.values()]));
  await tx.query(
    `insert into vendor_returns (id, tenant_id, no, date, vendor_id, gr_doc_id, gr_no, ap_bill_id, reason, vendor_cn_no, base, vat, total, ap_applied, unapplied, cogs, created_by, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [retId, ctx.tenantId, no, deps.today(), g.vendor_id, g.id, g.no, b?.id ?? null, req.reason, req.vendorCnNo?.trim() || null, amt.base, amt.vat, amt.total, amt.applied, amt.unapplied, cogs, ctx.userId, req.note?.trim() ?? '']);
  for (const l of lines) {
    await tx.query(
      `insert into vendor_return_lines (tenant_id, return_id, gr_line_id, product_id, qty, base_qty, unit_price, amount, cogs) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ctx.tenantId, retId, l.row.id, l.row.product_id, l.req.qty, l.baseQty, l.row.unit_price, money(d(l.req.qty).times(d(l.row.unit_price))), money(cogsByLine.get(l.row.id) ?? 0)]);
    await tx.query(`update gr_lines set returned_base_qty = returned_base_qty + $1 where id = $2`, [l.baseQty, l.row.id]);
  }
  if (b && d(amt.applied).gt(0)) await tx.query(`update ap_bills set returned = returned + $1 where id = $2`, [amt.applied, b.id]);
  await deps.hooks.beforeCommit?.('vendorReturn', tx);
  await writeAudit(tx, ctx, [{
    action: 'create', object: 'vendor-return', ref: no,
    detail: `อ้างอิง ${g.no} · ฿${fmtTHB(amt.total)} · ${req.reason}${req.vendorCnNo ? ` · ใบลดหนี้ผู้ขาย ${req.vendorCnNo}` : ''}${b ? ` · ลดเจ้าหนี้ ${b.no} ฿${fmtTHB(amt.applied)}` : ''}`,
  }]);
  return (await loadReturn(tx, ctx, 'r.id = $1', retId))!;
}
