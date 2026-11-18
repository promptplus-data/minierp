/**
 * มัดจำซื้อ and รับวางบิลซื้อ (M18 additions).
 *  - A purchase deposit is money paid to a vendor before the goods / bill (optionally for one PO). A payment voucher
 *    uses it later (ap_deposit_allocs): the bills are settled in full, the deposit part is not paid again. What is not
 *    used can be marked refunded by the vendor, or the deposit voided while nothing of it is used.
 *  - A vendor billing note (ใบรับวางบิล) records the vendor's billing of several open AP bills with the agreed payment
 *    date; a bill is on at most one active note. The note is paid when every bill on it is settled.
 */
import type { Tx } from '@erp/db';
import type { ApBillingNote, ApDeposit } from '@erp/contracts';
import { apDaysOverdue, d, fmtTHB, money, sum, searchTokens } from '@erp/core';
import { writeAudit } from '../../lib/audit';
import { requirePerm, type Ctx, type Deps } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E, isUuid } from '../../lib/errors';
import { decodeCursor, likeEscape, pageOf } from '../../lib/paging';

const METHOD_TH = { transfer: 'โอนเงิน', cheque: 'เช็ค', cash: 'เงินสด' } as const;

// ---------- deposits ----------
const DEP_SELECT = `
  select dp.id, dp.no, to_char(dp.date,'YYYY-MM-DD') date, dp.vendor_id, v.name vendor_name, po.no po_no, dp.method, dp.ref, dp.amount::text, dp.status,
         dp.closed_amount::text, dp.closed_note, dp.note, u.name created_by, dp.created_at,
         coalesce((select sum(a.amount) from ap_deposit_allocs a join ap_payments p on p.id = a.payment_id where a.deposit_id = dp.id and p.status = 'active'), 0)::text used
    from ap_deposits dp join vendors v on v.id = dp.vendor_id left join purchase_orders po on po.id = dp.po_id join users u on u.id = dp.created_by`;
interface DepRow {
  id: string; no: string; date: string; vendor_id: string; vendor_name: string; po_no: string | null; method: ApDeposit['method']; ref: string | null; amount: string;
  status: ApDeposit['status']; closed_amount: string; closed_note: string | null; note: string; created_by: string; created_at: Date; used: string;
}
const remainingOf = (x: Pick<DepRow, 'amount' | 'used' | 'closed_amount' | 'status'>) =>
  x.status === 'active' ? money(d(x.amount).minus(d(x.used)).minus(d(x.closed_amount))) : '0.00';

async function toDeposit(tx: Tx, x: DepRow): Promise<ApDeposit> {
  const pays = await tx.query<{ no: string; date: string; amount: string }>(
    `select p.no, to_char(p.date,'YYYY-MM-DD') date, a.amount::text from ap_deposit_allocs a join ap_payments p on p.id = a.payment_id where a.deposit_id = $1 and p.status = 'active' order by p.created_at`, [x.id]);
  return {
    id: x.id, no: x.no, date: x.date, vendorId: x.vendor_id, vendorName: x.vendor_name, poNo: x.po_no, method: x.method, ref: x.ref, amount: money(x.amount),
    used: money(x.used), remaining: remainingOf(x), status: x.status, closedAmount: money(x.closed_amount), closedNote: x.closed_note, note: x.note,
    payments: pays.rows.map((p) => ({ no: p.no, date: p.date, amount: money(p.amount) })), createdBy: x.created_by,
  };
}

export async function listDeposits(tx: Tx, ctx: Ctx, q: { q?: string; limit: number; cursor?: string; vendorId?: string; status: 'open' | 'all' }) {
  requirePerm(ctx, 'fin.ap', { readOnly: true });
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.vendorId) {
    if (!isUuid(q.vendorId)) throw E.validation('Unknown vendor');
    params.push(q.vendorId);
    where.push(`x.vendor_id = $${params.length}`);
  }
  if (q.status === 'open') where.push(`x.status = 'active' and x.amount::numeric - x.used::numeric - x.closed_amount::numeric > 0`);
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(x.no ilike $${params.length} or x.vendor_name ilike $${params.length} or coalesce(x.po_no,'') ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(x.created_at, x.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<DepRow>(`select * from (${DEP_SELECT}) x ${where.length ? 'where ' + where.join(' and ') : ''} order by x.created_at desc, x.id desc limit $${params.length}`, params);
  const pg = pageOf(r.rows, q.limit, (x) => [x.created_at.toISOString(), x.id], (x) => x);
  return { items: await Promise.all(pg.items.map((x) => toDeposit(tx, x))), nextCursor: pg.nextCursor };
}

export async function getDeposit(tx: Tx, ctx: Ctx, no: string): Promise<ApDeposit> {
  requirePerm(ctx, 'fin.ap', { readOnly: true });
  const r = await tx.query<DepRow>(`${DEP_SELECT} where dp.no = $1`, [no]);
  if (!r.rows[0]) throw E.notFound(`ไม่พบใบมัดจำซื้อ ${no}`);
  return toDeposit(tx, r.rows[0]);
}

export async function createDeposit(tx: Tx, deps: Deps, ctx: Ctx, req: { vendorId: string; poNo?: string; method: ApDeposit['method']; ref?: string; amount: string; date?: string; note: string }): Promise<ApDeposit> {
  requirePerm(ctx, 'fin.ap');
  if (!isUuid(req.vendorId)) throw E.validation('Unknown vendor');
  const v = await tx.query<{ name: string }>(`select name from vendors where id = $1`, [req.vendorId]);
  if (!v.rows[0]) throw E.validation('Unknown vendor');
  if (!d(req.amount).gt(0)) throw E.validation('ยอดมัดจำต้องมากกว่า 0');
  if (req.method === 'cheque' && !req.ref?.trim()) throw E.validation('กรอกเลขที่เช็ค');
  let poId: string | null = null;
  if (req.poNo) {
    const po = await tx.query<{ id: string; vendor_id: string; status: string }>(`select id, vendor_id, status from purchase_orders where no = $1`, [req.poNo]);
    if (!po.rows[0]) throw E.notFound(`ไม่พบใบสั่งซื้อ ${req.poNo}`);
    if (po.rows[0].vendor_id !== req.vendorId) throw E.validation(`${req.poNo} เป็นของผู้ขายรายอื่น`);
    if (po.rows[0].status === 'void') throw E.conflict(`${req.poNo} ถูกยกเลิกแล้ว`);
    poId = po.rows[0].id;
  }
  const date = req.date ?? deps.today();
  const no = await nextDocNo(tx, ctx.tenantId, 'PD', date);
  await tx.query(
    `insert into ap_deposits (tenant_id, no, date, vendor_id, po_id, method, ref, amount, note, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [ctx.tenantId, no, date, req.vendorId, poId, req.method, req.ref?.trim() || null, money(req.amount), req.note.trim(), ctx.userId]);
  await writeAudit(tx, ctx, [{ action: 'pay', object: 'ap-deposit', ref: no, detail: `มัดจำซื้อ ${v.rows[0].name}${req.poNo ? ` · ${req.poNo}` : ''} · ฿${fmtTHB(req.amount)} · ${METHOD_TH[req.method]}` }]);
  return getDeposit(tx, ctx, no);
}

/** refund: the vendor gave back what is not used; void: a deposit recorded by mistake (nothing used yet). */
export async function closeDeposit(tx: Tx, ctx: Ctx, no: string, body: { action: 'refund' | 'void'; reason: string }): Promise<ApDeposit> {
  requirePerm(ctx, 'fin.ap');
  await tx.query(`select id from ap_deposits where no = $1 for update`, [no]);
  const r = await tx.query<DepRow>(`${DEP_SELECT} where dp.no = $1`, [no]);
  const x = r.rows[0];
  if (!x) throw E.notFound(`ไม่พบใบมัดจำซื้อ ${no}`);
  if (x.status !== 'active') throw E.conflict(`${no} ปิดไปแล้ว`);
  const left = remainingOf(x);
  if (body.action === 'void' && d(x.used).gt(0)) throw E.conflict(`${no} ถูกใช้หักในใบสำคัญจ่ายแล้ว ยกเลิกไม่ได้ (บันทึกรับคืนส่วนที่เหลือแทน)`);
  if (body.action === 'refund' && !d(left).gt(0)) throw E.conflict(`${no} ไม่มียอดคงเหลือให้รับคืน`);
  await tx.query(`update ap_deposits set status = $2, closed_amount = $3, closed_note = $4, closed_by = $5, closed_at = now() where id = $1`,
    [x.id, body.action === 'void' ? 'void' : 'refunded', body.action === 'void' ? '0' : left, body.reason, ctx.userId]);
  await writeAudit(tx, ctx, [{ action: body.action === 'void' ? 'void' : 'update', object: 'ap-deposit', ref: no, detail: `${body.action === 'void' ? 'ยกเลิก' : `รับคืนมัดจำ ฿${fmtTHB(left)}`} · ${body.reason}` }]);
  return getDeposit(tx, ctx, no);
}

/** Used by createPayment: locks the deposits and checks vendor and remaining amount. */
export async function takeDeposits(tx: Tx, vendorId: string, uses: { depositId: string; amount: string }[]) {
  const ids = uses.map((u) => u.depositId);
  if (ids.some((i) => !isUuid(i))) throw E.validation('Unknown deposit');
  if (new Set(ids).size !== ids.length) throw E.validation('ใบมัดจำซ้ำในใบสำคัญจ่าย');
  await tx.query(`select id from ap_deposits where id = any($1::uuid[]) order by id for update`, [ids]);
  const r = await tx.query<DepRow>(`${DEP_SELECT} where dp.id = any($1::uuid[])`, [ids]);
  const byId = new Map(r.rows.map((x) => [x.id, x]));
  return uses.filter((u) => d(u.amount).gt(0)).map((u) => {
    const x = byId.get(u.depositId);
    if (!x || x.status !== 'active') throw E.validation('Unknown deposit');
    if (x.vendor_id !== vendorId) throw E.validation(`${x.no} เป็นมัดจำของผู้ขายรายอื่น`);
    if (d(u.amount).gt(d(remainingOf(x)))) throw E.conflict(`${x.no} เหลือใช้ได้ ฿${fmtTHB(remainingOf(x))}`, { remaining: remainingOf(x) });
    return { id: x.id, no: x.no, amount: money(u.amount) };
  });
}

// ---------- vendor billing notes ----------
const BN_SELECT = `
  select n.id, n.no, to_char(n.date,'YYYY-MM-DD') date, n.vendor_id, v.name vendor_name, n.vendor_doc_no, to_char(n.due_date,'YYYY-MM-DD') due_date, n.total::text,
         n.status, n.note, n.void_reason, u.name created_by, n.created_at,
         coalesce((select sum(b.total - b.paid - b.returned) from ap_billing_note_lines l join ap_bills b on b.id = l.bill_id where l.bn_id = n.id), 0)::text balance
    from ap_billing_notes n join vendors v on v.id = n.vendor_id join users u on u.id = n.created_by`;
interface BnRow { id: string; no: string; date: string; vendor_id: string; vendor_name: string; vendor_doc_no: string; due_date: string; total: string; status: ApBillingNote['status']; note: string; void_reason: string | null; created_by: string; created_at: Date; balance: string }

async function toBn(tx: Tx, x: BnRow, today: string): Promise<ApBillingNote> {
  const lines = await tx.query<{ bill_id: string; no: string; vendor_invoice_no: string; date: string; due_date: string; amount: string; balance: string }>(
    `select b.id bill_id, b.no, b.vendor_invoice_no, to_char(b.date,'YYYY-MM-DD') date, to_char(b.due_date,'YYYY-MM-DD') due_date, l.amount::text, (b.total - b.paid - b.returned)::text balance
       from ap_billing_note_lines l join ap_bills b on b.id = l.bill_id where l.bn_id = $1 order by b.due_date, b.no`, [x.id]);
  const pays = await tx.query<{ no: string; date: string; amount: string }>(
    `select p.no, to_char(p.date,'YYYY-MM-DD') date, p.amount::text from ap_payments p where p.billing_note_id = $1 and p.status = 'active' order by p.created_at`, [x.id]);
  const paid = d(x.balance).lte(0);
  return {
    id: x.id, no: x.no, date: x.date, vendorId: x.vendor_id, vendorName: x.vendor_name, vendorDocNo: x.vendor_doc_no, dueDate: x.due_date, total: money(x.total), balance: money(x.balance),
    status: x.status, paid, overdueDays: x.status === 'active' && !paid ? Math.max(0, apDaysOverdue(x.due_date, today)) : 0, note: x.note, voidReason: x.void_reason,
    bills: lines.rows.map((l) => ({ billId: l.bill_id, billNo: l.no, vendorInvoiceNo: l.vendor_invoice_no, date: l.date, dueDate: l.due_date, amount: money(l.amount), balance: money(l.balance) })),
    payments: pays.rows.map((p) => ({ no: p.no, date: p.date, amount: money(p.amount) })), createdBy: x.created_by,
  };
}

export async function listBillingNotes(tx: Tx, deps: Deps, ctx: Ctx, q: { q?: string; limit: number; cursor?: string; status: 'open' | 'all' }) {
  requirePerm(ctx, 'fin.ap', { readOnly: true });
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.status === 'open') where.push(`x.status = 'active' and x.balance::numeric > 0`);
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(x.no ilike $${params.length} or x.vendor_name ilike $${params.length} or x.vendor_doc_no ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(x.created_at, x.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<BnRow>(`select * from (${BN_SELECT}) x ${where.length ? 'where ' + where.join(' and ') : ''} order by x.created_at desc, x.id desc limit $${params.length}`, params);
  const pg = pageOf(r.rows, q.limit, (x) => [x.created_at.toISOString(), x.id], (x) => x);
  return { items: await Promise.all(pg.items.map((x) => toBn(tx, x, deps.today()))), nextCursor: pg.nextCursor };
}

export async function getBillingNote(tx: Tx, deps: Deps, ctx: Ctx, no: string): Promise<ApBillingNote> {
  requirePerm(ctx, 'fin.ap', { readOnly: true });
  const r = await tx.query<BnRow>(`${BN_SELECT} where n.no = $1`, [no]);
  if (!r.rows[0]) throw E.notFound(`ไม่พบใบรับวางบิล ${no}`);
  return toBn(tx, r.rows[0], deps.today());
}

export async function createBillingNote(tx: Tx, deps: Deps, ctx: Ctx, req: { vendorId: string; billIds: string[]; vendorDocNo: string; date?: string; dueDate: string; note: string }): Promise<ApBillingNote> {
  requirePerm(ctx, 'fin.ap');
  if (!isUuid(req.vendorId) || req.billIds.some((i) => !isUuid(i))) throw E.validation('Unknown vendor or bill');
  if (new Set(req.billIds).size !== req.billIds.length) throw E.validation('บิลซ้ำในใบรับวางบิล');
  const bills = await tx.query<{ id: string; no: string; vendor_id: string; status: string; balance: string; bn: string | null }>(
    `select b.id, b.no, b.vendor_id, b.status, (b.total - b.paid - b.returned)::text balance,
            (select n.no from ap_billing_note_lines l join ap_billing_notes n on n.id = l.bn_id where l.bill_id = b.id and n.status = 'active' limit 1) bn
       from ap_bills b where b.id = any($1::uuid[]) order by b.id for update of b`, [req.billIds]);
  if (bills.rows.length !== req.billIds.length) throw E.validation('Unknown bill');
  for (const b of bills.rows) {
    if (b.status !== 'active') throw E.validation(`${b.no} ถูกยกเลิก`);
    if (b.vendor_id !== req.vendorId) throw E.validation(`${b.no} เป็นของผู้ขายรายอื่น`);
    if (!d(b.balance).gt(0)) throw E.conflict(`${b.no} จ่ายครบแล้ว`);
    if (b.bn) throw E.conflict(`${b.no} อยู่ในใบรับวางบิล ${b.bn} แล้ว`);
  }
  const date = req.date ?? deps.today();
  if (req.dueDate < date) throw E.validation('วันนัดจ่ายต้องไม่ก่อนวันรับวางบิล');
  const total = money(sum(bills.rows.map((b) => b.balance)));
  const no = await nextDocNo(tx, ctx.tenantId, 'VB', date);
  const id = (await tx.query<{ id: string }>(
    `insert into ap_billing_notes (tenant_id, no, date, vendor_id, vendor_doc_no, due_date, total, note, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [ctx.tenantId, no, date, req.vendorId, req.vendorDocNo.trim(), req.dueDate, total, req.note.trim(), ctx.userId])).rows[0]!.id;
  for (const b of bills.rows) await tx.query(`insert into ap_billing_note_lines (tenant_id, bn_id, bill_id, amount) values ($1,$2,$3,$4)`, [ctx.tenantId, id, b.id, b.balance]);
  await writeAudit(tx, ctx, [{ action: 'create', object: 'ap-billing-note', ref: no, detail: `รับวางบิล ${bills.rows.map((b) => b.no).join(', ')} · ฿${fmtTHB(total)} · นัดจ่าย ${req.dueDate}${req.vendorDocNo ? ` · ใบวางบิลผู้ขาย ${req.vendorDocNo}` : ''}` }]);
  return getBillingNote(tx, deps, ctx, no);
}

export async function voidBillingNote(tx: Tx, deps: Deps, ctx: Ctx, no: string, reason: string): Promise<ApBillingNote> {
  requirePerm(ctx, 'fin.ap');
  const r = await tx.query<{ id: string; status: string }>(`select id, status from ap_billing_notes where no = $1 for update`, [no]);
  const n = r.rows[0];
  if (!n) throw E.notFound(`ไม่พบใบรับวางบิล ${no}`);
  if (n.status !== 'active') throw E.conflict(`${no} ถูกยกเลิกแล้ว`);
  await tx.query(`update ap_billing_notes set status = 'void', void_reason = $2, void_by = $3, void_at = now() where id = $1`, [n.id, reason, ctx.userId]);
  await writeAudit(tx, ctx, [{ action: 'void', object: 'ap-billing-note', ref: no, detail: reason }]);
  return getBillingNote(tx, deps, ctx, no);
}

/** Used by createPayment: the voucher pays bills of this active note only. */
export async function billingNoteFor(tx: Tx, no: string, vendorId: string, billIds: string[]): Promise<string> {
  const r = await tx.query<{ id: string; vendor_id: string; status: string }>(`select id, vendor_id, status from ap_billing_notes where no = $1`, [no]);
  const n = r.rows[0];
  if (!n || n.status !== 'active') throw E.validation(`ไม่พบใบรับวางบิล ${no}`);
  if (n.vendor_id !== vendorId) throw E.validation(`${no} เป็นของผู้ขายรายอื่น`);
  const on = new Set((await tx.query<{ bill_id: string }>(`select bill_id from ap_billing_note_lines where bn_id = $1`, [n.id])).rows.map((x) => x.bill_id));
  if (billIds.some((b) => !on.has(b))) throw E.validation(`จ่ายได้เฉพาะบิลในใบรับวางบิล ${no}`);
  return n.id;
}
