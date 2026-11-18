/**
 * Customer deposits for any customer (projects keep their own pool in projects.ts) and ขอลดหนี้ขาย.
 *  - มัดจำ (guarantee): money held, no VAT yet; a later invoice uses it as part payment of its balance.
 *  - รับเงินล่วงหน้า (advance): a tax invoice is issued on receipt (BR-06); a later invoice deducts it, VAT included,
 *    so the sale is taxed once. Returning an advance is a credit note on its tax invoice.
 *  Applications (sales_deposit_applications) count while the invoice is active, so voiding an invoice frees the deposit.
 *  - ขอลดหนี้ขาย: a credit-note request (price reduction, no goods back) on an invoice; a manager / owner approves
 *    (never the requester, except the owner) and the credit note reduces what is still owed, the rest goes back to
 *    the customer by the chosen method.
 */
import type { Tx } from '@erp/db';
import type { CnRequest, CustomerDeposit } from '@erp/contracts';
import { approverRoles, d, fmtTHB, money, returnArSplit, searchTokens, splitInclusive, sum, type DocTotals } from '@erp/core';
import { verifyApproval, type Approval } from '../../lib/approval';
import { writeAudit } from '../../lib/audit';
import { can, requireAny, type Ctx, type Deps } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E, isUuid } from '../../lib/errors';
import { decodeCursor, likeEscape, pageOf } from '../../lib/paging';
import { getDocRow } from '../../services/sales';
import { authorizeVoid, loadCustomer, loadShop, lumpVatMode, type VoidBody } from './common';
import { insertInvoice } from './invoices';

const DEP_TH = { guarantee: 'รับเงินมัดจำ', advance: 'รับเงินล่วงหน้า' } as const;
const METHOD_TH: Record<string, string> = { cash: 'เงินสด', transfer: 'โอนเงิน', promptpay: 'พร้อมเพย์', card: 'บัตร', credit: 'เครดิตลูกค้า' };

const SELECT = `
  select dp.id, dp.no, dp.date::text, dp.type, dp.amount::text, dp.method, dp.status, dp.closed_amount::text, dp.refund, dp.note, dp.created_at,
         dp.customer_id, c.name customer_name, so.no so_no, pj.id pj_id, pj.no pj_no, pj.name pj_name, iv.no inv_no, fv.no forfeit_no, cn.no cn_no, u.name created_by,
         coalesce((select sum(a.amount) from sales_deposit_applications a join docs x on x.id = a.invoice_doc_id where a.deposit_id = dp.id and x.status = 'active'), 0)::text applied
    from sales_deposits dp join customers c on c.id = dp.customer_id left join sales_orders so on so.id = dp.so_id left join sales_projects pj on pj.id = dp.project_id
    left join docs iv on iv.id = dp.invoice_doc_id left join docs fv on fv.id = dp.forfeit_doc_id left join docs cn on cn.id = dp.refund_doc_id join users u on u.id = dp.created_by`;
interface Row {
  id: string; no: string; date: string; type: 'guarantee' | 'advance'; amount: string; method: string; status: CustomerDeposit['status']; closed_amount: string;
  refund: CustomerDeposit['refund']; note: string; created_at: Date; customer_id: string; customer_name: string; so_no: string | null; pj_id: string | null; pj_no: string | null;
  pj_name: string | null; inv_no: string | null; forfeit_no: string | null; cn_no: string | null; created_by: string; applied: string;
}
const remainingOf = (x: Pick<Row, 'amount' | 'applied' | 'closed_amount' | 'status'>) =>
  x.status === 'active' ? money(d(x.amount).minus(d(x.applied)).minus(d(x.closed_amount))) : '0.00';

async function toDeposit(tx: Tx, x: Row): Promise<CustomerDeposit> {
  const apps = await tx.query<{ no: string; date: string; amount: string }>(
    `select x.no, x.date::text, a.amount::text from sales_deposit_applications a join docs x on x.id = a.invoice_doc_id where a.deposit_id = $1 and x.status = 'active' order by a.created_at`, [x.id]);
  return {
    id: x.id, no: x.no, date: x.date, type: x.type, amount: money(x.amount), method: x.method, applied: money(x.applied), remaining: remainingOf(x), status: x.status,
    invoiceNo: x.inv_no, forfeitNo: x.forfeit_no, refund: x.refund, note: x.note, customer: { id: x.customer_id, name: x.customer_name }, soNo: x.so_no,
    project: x.pj_id ? { id: x.pj_id, no: x.pj_no!, name: x.pj_name! } : null, applications: apps.rows.map((a) => ({ invoiceNo: a.no, date: a.date, amount: money(a.amount) })),
    refundCnNo: x.cn_no, createdBy: x.created_by,
  };
}

const readDeposits = (ctx: Ctx) => requireAny(ctx, ['sales.doc', 'fin.ar', 'sales.project'], { readOnly: true });

export async function listDeposits(tx: Tx, ctx: Ctx, q: { q?: string; limit: number; cursor?: string; customerId?: string; status: 'open' | 'all' }) {
  readDeposits(ctx);
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.customerId) {
    if (!isUuid(q.customerId)) throw E.validation('Unknown customer');
    params.push(q.customerId);
    where.push(`x.customer_id = $${params.length}`);
  }
  // open = usable on a new invoice: active, not a project deposit, something left
  if (q.status === 'open') where.push(`x.status = 'active' and x.pj_id is null and x.amount::numeric - x.applied::numeric - x.closed_amount::numeric > 0`);
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(x.no ilike $${params.length} or x.customer_name ilike $${params.length} or coalesce(x.so_no,'') ilike $${params.length} or coalesce(x.inv_no,'') ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(x.created_at, x.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<Row>(`select * from (${SELECT}) x ${where.length ? 'where ' + where.join(' and ') : ''} order by x.created_at desc, x.id desc limit $${params.length}`, params);
  const pg = pageOf(r.rows, q.limit, (x) => [x.created_at.toISOString(), x.id], (x) => x);
  return { items: await Promise.all(pg.items.map((x) => toDeposit(tx, x))), nextCursor: pg.nextCursor };
}

export async function getDeposit(tx: Tx, ctx: Ctx, no: string): Promise<CustomerDeposit> {
  readDeposits(ctx);
  const r = await tx.query<Row>(`${SELECT} where dp.no = $1`, [no]);
  if (!r.rows[0]) throw E.notFound(`Deposit ${no} not found`);
  return toDeposit(tx, r.rows[0]);
}

/** Project deposits keep their own forfeit / refund / void rules (projects.ts). */
export async function isProjectDeposit(tx: Tx, no: string): Promise<boolean> {
  const r = await tx.query<{ project_id: string | null }>(`select project_id from sales_deposits where no = $1`, [no]);
  if (!r.rows[0]) throw E.notFound(`Deposit ${no} not found`);
  return !!r.rows[0].project_id;
}

export async function createDeposit(tx: Tx, deps: Deps, ctx: Ctx, req: { customerId: string; soNo?: string; type: 'guarantee' | 'advance'; amount: string; method: string; date?: string; note: string }): Promise<CustomerDeposit> {
  requireAny(ctx, ['sales.doc', 'fin.ar']);
  const customer = await loadCustomer(tx, req.customerId);
  if (!d(req.amount).gt(0)) throw E.validation('ยอดเงินต้องมากกว่า 0');
  let soId: string | null = null;
  if (req.soNo) {
    const so = await tx.query<{ id: string; customer_id: string; status: string; project_id: string | null }>(`select id, customer_id, status, project_id from sales_orders where no = $1`, [req.soNo]);
    const s = so.rows[0];
    if (!s) throw E.notFound(`ไม่พบใบสั่งขาย ${req.soNo}`);
    if (s.customer_id !== customer.id) throw E.validation(`${req.soNo} เป็นของลูกค้ารายอื่น`);
    if (s.status !== 'active') throw E.conflict(`${req.soNo} ถูกยกเลิกแล้ว`);
    if (s.project_id) throw E.validation(`${req.soNo} อยู่ในโครงการ: รับมัดจำที่หน้าโครงการ`);
    soId = s.id;
  }
  const date = req.date ?? deps.today();
  const no = await nextDocNo(tx, ctx.tenantId, 'DP', date);
  let invoiceId: string | null = null;
  let invNo = '';
  if (req.type === 'advance') {
    // BR-06: an advance is taxed when received: a tax invoice / receipt for it now.
    if ((await loadShop(tx, ctx)).vat_registered && !customer.tax_id) throw E.validation('รับเงินล่วงหน้าต้องออกใบกำกับภาษี: ลูกค้าต้องมีเลขผู้เสียภาษี');
    const mode = await lumpVatMode(tx, ctx);
    const split = splitInclusive(money(req.amount), mode);
    const inv = await insertInvoice(tx, ctx, {
      date, customer, vatMode: mode, totals: { gross: split.total, lineDisc: '0.00', billDisc: '0.00', base7: split.base7, exempt: split.exempt, vat: split.vat, total: split.total },
      lines: [], payments: [{ method: req.method, amount: split.total }], arBalance: '0.00', search: [no, req.soNo ?? ''],
      ext: { kind: 'cash', source: 'deposit', soId, term: { t: 'cash' }, dueDate: date, textLines: [{ name: `รับเงินล่วงหน้าค่าสินค้า${req.soNo ? ` ตามใบสั่งขาย ${req.soNo}` : ''} (${no})`, amount: split.total }], note: req.note },
    });
    invoiceId = inv.id;
    invNo = inv.no;
  }
  const id = (await tx.query<{ id: string }>(
    `insert into sales_deposits (tenant_id, no, date, project_id, so_id, customer_id, type, amount, method, invoice_doc_id, created_by, note) values ($1,$2,$3,null,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [ctx.tenantId, no, date, soId, customer.id, req.type, money(req.amount), req.method, invoiceId, ctx.userId, req.note.trim()])).rows[0]!.id;
  if (invoiceId) await tx.query(`update sales_invoices set deposit_id = $2 where doc_id = $1`, [invoiceId, id]);
  await writeAudit(tx, ctx, [{ action: 'create', object: 'deposit', ref: no, detail: `${DEP_TH[req.type]} · ${customer.name}${req.soNo ? ` · ${req.soNo}` : ''} · ฿${fmtTHB(req.amount)} · ${METHOD_TH[req.method] ?? req.method}${invNo ? ` · ใบกำกับ ${invNo}` : ' · ยังไม่เกิด VAT'}` }]);
  return getDeposit(tx, ctx, no);
}

/** sales.return rules: 1 = allowed, 'apv' = a manager / owner PIN. Returns " · อนุมัติโดย X" or ''. */
async function approveMoneyBack(tx: Tx, deps: Deps, ctx: Ctx, approval: Approval | undefined, what: string): Promise<string> {
  const p = can(ctx, 'sales.return');
  if (p === 1) return '';
  if (p !== 'apv') throw E.forbidden('Permission sales.return is required', { perm: 'sales.return' });
  if (!approval) throw E.forbidden(`${what} needs a manager or owner PIN`, { need: 'approval' });
  const a = await verifyApproval(tx, deps.pool, ctx, approval, approverRoles('sales.return'), what);
  if (!a.ok) throw E.forbidden('Approval rejected', { approvalError: a.reason });
  return ` · อนุมัติโดย ${a.approver.name}`;
}

/**
 * A credit note without goods on `src` for `amount` (VAT in the same proportion as the source document): what is still
 * owed on src is reduced first, the rest goes back by `method` ('credit' keeps it as a customer credit).
 */
export async function insertLumpCreditNote(tx: Tx, deps: Deps, ctx: Ctx, srcNo: string, amount: string, method: string, reason: string, note = ''): Promise<{ id: string; no: string; srcNo: string; toAr: string; refunded: string; credit: string }> {
  const src = await getDocRow(tx, srcNo, { forUpdate: true });
  if (src.status !== 'active') throw E.conflict(`${src.no} is void`);
  const credited = await tx.query<{ t: string | null }>(`select sum(total)::text t from docs where ref_doc_id = $1 and type = 'CN' and status = 'active'`, [src.id]);
  const room = d(src.total).minus(d(credited.rows[0]?.t ?? 0));
  if (d(amount).gt(room)) throw E.conflict(`ลดหนี้ได้ไม่เกิน ฿${fmtTHB(money(room))} (ยอดเอกสารหักใบลดหนี้เดิมแล้ว)`, { max: money(room) });
  const ratio = d(amount).div(d(src.total));
  const base7 = money(d(src.base7).times(ratio));
  const vat = money(d(src.vat).times(ratio));
  const exempt = money(d(amount).minus(d(base7)).minus(d(vat)));
  const totals: Pick<DocTotals, 'gross' | 'base7' | 'exempt' | 'vat' | 'total'> = { gross: money(amount), base7, exempt, vat, total: money(amount) };
  const split = returnArSplit(totals.total, src.ar_balance);
  const refundMoney = method === 'credit' ? '0.00' : split.over;
  const payments = d(refundMoney).gt(0) ? [{ method, amount: refundMoney }] : [];
  const date = deps.today();
  const no = await nextDocNo(tx, ctx.tenantId, 'CN', date);
  const id = (await tx.query<{ id: string }>(
    `insert into docs (tenant_id, no, type, date, customer_id, customer_name, customer_phone, vat_mode, gross, line_disc, bill_disc, base7, exempt, vat, total, payments,
       created_by, ref_doc_id, ref_no, refund, reason, search_text, note, ar_applied)
     values ($1,$2,'CN',$3,$4,$5,$6,$7,$8,'0','0',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) returning id`,
    [ctx.tenantId, no, date, src.customer_id, src.customer_name, src.customer_phone, src.vat_mode, totals.gross, totals.base7, totals.exempt, totals.vat, totals.total,
      JSON.stringify(payments), ctx.userId, src.id, src.no, method, reason, `${no} ${src.no} ${src.customer_name ?? ''} ${totals.total}`.toLowerCase(), note, split.toAr],
  )).rows[0]!.id;
  if (d(split.toAr).gt(0)) await tx.query(`update docs set ar_balance = ar_balance - $1 where id = $2`, [split.toAr, src.id]);
  return { id, no, srcNo: src.no, toAr: split.toAr, refunded: refundMoney, credit: method === 'credit' ? split.over : '0.00' };
}

/** Return what is left of a deposit: a guarantee is paid back; an advance gets a credit note on its tax invoice. */
export async function refundDeposit(tx: Tx, deps: Deps, ctx: Ctx, no: string, req: { method?: string; approval?: Approval; reason: string }): Promise<CustomerDeposit> {
  requireAny(ctx, ['sales.doc', 'fin.ar']);
  await tx.query(`select id from sales_deposits where no = $1 for update`, [no]);
  const r = await tx.query<Row>(`${SELECT} where dp.no = $1`, [no]);
  const x = r.rows[0];
  if (!x) throw E.notFound(`Deposit ${no} not found`);
  if (x.status !== 'active') throw E.conflict(`${no} is ${x.status}`);
  const left = remainingOf(x);
  if (!d(left).gt(0)) throw E.conflict(`${no} ไม่มียอดเหลือให้คืน`);
  if (!req.reason.trim()) throw E.validation('ระบุเหตุผลการคืนเงิน');
  const by = await approveMoneyBack(tx, deps, ctx, req.approval, `คืนเงิน ${no}`);
  const method = req.method ?? x.method;
  let cnId: string | null = null;
  let cnNo = '';
  if (x.type === 'advance') {
    if (!x.inv_no) throw E.conflict(`${no} has no tax invoice`);
    const cn = await insertLumpCreditNote(tx, deps, ctx, x.inv_no, left, method, `คืนเงินรับล่วงหน้า ${no} · ${req.reason}`);
    cnId = cn.id;
    cnNo = cn.no;
  }
  const refund = { amount: left, method, date: deps.today(), by: by ? by.replace(' · อนุมัติโดย ', '') : ctx.name };
  await tx.query(`update sales_deposits set status = 'refunded', closed_amount = $2, refund = $3, refund_doc_id = $4 where id = $1`, [x.id, left, JSON.stringify(refund), cnId]);
  await writeAudit(tx, ctx, [{ action: 'update', object: 'deposit', ref: no, detail: `คืน${x.type === 'advance' ? 'เงินรับล่วงหน้า' : 'มัดจำ'} ฿${fmtTHB(left)} · ${METHOD_TH[method] ?? method}${cnNo ? ` · ใบลดหนี้ ${cnNo}` : ''} · ${req.reason}${by}` }]);
  return getDeposit(tx, ctx, no);
}

/** A deposit recorded by mistake: only while no invoice uses it; an advance voids its tax invoice too. */
export async function voidDeposit(tx: Tx, deps: Deps, ctx: Ctx, no: string, body: VoidBody): Promise<CustomerDeposit> {
  const approvedBy = await authorizeVoid(tx, deps, ctx, body, no);
  await tx.query(`select id from sales_deposits where no = $1 for update`, [no]);
  const r = await tx.query<Row & { invoice_doc_id: string | null }>(`select x.*, dp2.invoice_doc_id from (${SELECT}) x join sales_deposits dp2 on dp2.id = x.id where x.no = $1`, [no]);
  const x = r.rows[0];
  if (!x) throw E.notFound(`Deposit ${no} not found`);
  if (x.status !== 'active') throw E.conflict(`${no} is ${x.status}`);
  if (d(x.applied).gt(0)) {
    const inv = await tx.query<{ no: string }>(`select x.no from sales_deposit_applications a join docs x on x.id = a.invoice_doc_id where a.deposit_id = $1 and x.status = 'active'`, [x.id]);
    throw E.downstreamFirst(`${no} ถูกใช้ในใบกำกับแล้ว ยกเลิกใบกำกับก่อน`, { docs: inv.rows.map((y) => y.no) });
  }
  if (x.invoice_doc_id) {
    const cn = await tx.query<{ no: string }>(`select no from docs where ref_doc_id = $1 and status = 'active'`, [x.invoice_doc_id]);
    if (cn.rowCount) throw E.downstreamFirst(`${no} has documents on its invoice`, { docs: cn.rows.map((y) => y.no) });
    await tx.query(`update docs set status = 'void', void_by = $2, void_at = now(), void_reason = $3 where id = $1`, [x.invoice_doc_id, ctx.userId, `ยกเลิกพร้อมใบรับเงิน ${no} · ${body.reason}`]);
  }
  await tx.query(`update sales_deposits set status = 'void', void_by = $2, void_at = now(), void_reason = $3 where id = $1`, [x.id, ctx.userId, body.reason]);
  await writeAudit(tx, ctx, [{ action: 'void', object: 'deposit', ref: no, detail: `${body.reason} · ฿${fmtTHB(x.amount)}${x.inv_no ? ` · ยกเลิกใบกำกับ ${x.inv_no}` : ''}${approvedBy}` }]);
  return getDeposit(tx, ctx, no);
}

// ---------- use on an invoice ----------
export interface DepositPlan {
  type: 'guarantee' | 'advance';
  uses: { id: string; no: string; amount: string }[];
  amount: string;
  /** advance: the invoice totals after the deduction (VAT of the advance taken off). */
  totals: Pick<DocTotals, 'gross' | 'lineDisc' | 'billDisc' | 'base7' | 'exempt' | 'vat' | 'total'>;
  textLine: { name: string; amount: string };
}

export async function planDeposits(tx: Tx, customerId: string, uses: { no: string; amount: string }[], totals: DepositPlan['totals']): Promise<DepositPlan | null> {
  const want = uses.filter((u) => d(u.amount).gt(0));
  if (!want.length) return null;
  const nos = want.map((u) => u.no);
  if (new Set(nos).size !== nos.length) throw E.validation('ใบมัดจำซ้ำ');
  await tx.query(`select id from sales_deposits where no = any($1::text[]) order by id for update`, [nos]);
  const r = await tx.query<Row & { inv_base7: string | null; inv_vat: string | null; inv_total: string | null }>(
    `select x.*, iv.base7::text inv_base7, iv.vat::text inv_vat, iv.total::text inv_total from (${SELECT}) x
       left join sales_deposits dp2 on dp2.id = x.id left join docs iv on iv.id = dp2.invoice_doc_id where x.no = any($1::text[])`, [nos]);
  const by = new Map(r.rows.map((x) => [x.no, x]));
  const rows = want.map((u) => {
    const x = by.get(u.no);
    if (!x) throw E.notFound(`ไม่พบใบรับเงิน ${u.no}`);
    if (x.customer_id !== customerId) throw E.validation(`${u.no} เป็นของลูกค้ารายอื่น`);
    if (x.pj_id) throw E.validation(`${u.no} เป็นมัดจำโครงการ: หักในงวดของโครงการ`);
    if (x.status !== 'active') throw E.conflict(`${u.no} is ${x.status}`);
    if (d(u.amount).gt(d(remainingOf(x)))) throw E.conflict(`${u.no} เหลือใช้ได้ ฿${fmtTHB(remainingOf(x))}`, { remaining: remainingOf(x) });
    return { x, amount: money(u.amount) };
  });
  const type = rows[0]!.x.type;
  if (rows.some((y) => y.x.type !== type)) throw E.validation('ใบกำกับหนึ่งใบใช้ได้ทั้งมัดจำหรือเงินล่วงหน้าอย่างใดอย่างหนึ่ง');
  const amount = money(sum(rows.map((y) => y.amount)));
  if (d(amount).gt(d(totals.total))) throw E.validation(`ยอดที่หัก ฿${fmtTHB(amount)} เกินยอดใบกำกับ ฿${fmtTHB(totals.total)}`);
  let after = totals;
  if (type === 'advance') {
    // The VAT of the advance was charged on its own tax invoice: take that share off this invoice's base and VAT.
    let b7 = d(0);
    let v = d(0);
    for (const y of rows) {
      const ratio = d(y.amount).div(d(y.x.inv_total ?? y.x.amount));
      b7 = b7.plus(d(money(d(y.x.inv_base7 ?? 0).times(ratio))));
      v = v.plus(d(money(d(y.x.inv_vat ?? 0).times(ratio))));
    }
    const ex = d(amount).minus(b7).minus(v);
    if (b7.gt(d(totals.base7)) || v.gt(d(totals.vat)) || ex.gt(d(totals.exempt))) throw E.validation('ยอดเงินล่วงหน้าเกินฐานภาษีของใบกำกับนี้');
    after = { ...totals, base7: money(d(totals.base7).minus(b7)), vat: money(d(totals.vat).minus(v)), exempt: money(d(totals.exempt).minus(ex)), total: money(d(totals.total).minus(d(amount))) };
  }
  const list = rows.map((y) => `${y.x.no}${y.x.inv_no ? ` (${y.x.inv_no})` : ''}`).join(', ');
  return {
    type, amount, totals: after, uses: rows.map((y) => ({ id: y.x.id, no: y.x.no, amount: y.amount })),
    textLine: { name: type === 'advance' ? `หักเงินรับล่วงหน้า ${list} (ออกใบกำกับแล้วตอนรับเงิน)` : `หักเงินมัดจำ ${list}`, amount: money(d(amount).neg()) },
  };
}

export async function recordApplications(tx: Tx, ctx: Ctx, invoiceId: string, plan: DepositPlan | null) {
  for (const u of plan?.uses ?? []) {
    await tx.query(`insert into sales_deposit_applications (tenant_id, deposit_id, invoice_doc_id, amount) values ($1,$2,$3,$4)`, [ctx.tenantId, u.id, invoiceId, u.amount]);
  }
}

// ---------- ขอลดหนี้ขาย ----------
const CR_SELECT = `
  select r.id, r.no, r.date::text, x.no inv_no, x.total::text inv_total, x.ar_balance::text inv_balance, x.customer_id, x.customer_name, r.amount::text, r.reason, r.note,
         r.refund_method, r.status, ru.name requested_by, du.name decided_by, r.decided_at, r.decide_note, cn.no cn_no, r.created_at, r.requested_by requester_id
    from ar_cn_requests r join docs x on x.id = r.invoice_doc_id join users ru on ru.id = r.requested_by left join users du on du.id = r.decided_by left join docs cn on cn.id = r.cn_doc_id`;
interface CrRow {
  id: string; no: string; date: string; inv_no: string; inv_total: string; inv_balance: string; customer_id: string | null; customer_name: string; amount: string; reason: string; note: string;
  refund_method: CnRequest['refundMethod']; status: CnRequest['status']; requested_by: string; decided_by: string | null; decided_at: Date | null; decide_note: string; cn_no: string | null;
  created_at: Date; requester_id: string;
}
const toCr = (x: CrRow): CnRequest => ({
  id: x.id, no: x.no, date: x.date, invoiceNo: x.inv_no, invoiceTotal: money(x.inv_total), invoiceBalance: money(x.inv_balance), customer: { id: x.customer_id, name: x.customer_name },
  amount: money(x.amount), reason: x.reason, note: x.note, refundMethod: x.refund_method, status: x.status, requestedBy: x.requested_by, decidedBy: x.decided_by,
  decidedAt: x.decided_at?.toISOString() ?? null, decideNote: x.decide_note, cnNo: x.cn_no, createdAt: x.created_at.toISOString(),
});
const readCr = (ctx: Ctx) => requireAny(ctx, ['sales.doc', 'fin.ar', 'sales.return'], { readOnly: true });

export async function listCnRequests(tx: Tx, ctx: Ctx, q: { q?: string; limit: number; cursor?: string; status: 'pending' | 'all' }) {
  readCr(ctx);
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.status === 'pending') where.push(`y.status = 'pending'`);
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(y.no ilike $${params.length} or y.inv_no ilike $${params.length} or y.customer_name ilike $${params.length} or y.reason ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(y.created_at, y.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<CrRow>(`select * from (${CR_SELECT}) y ${where.length ? 'where ' + where.join(' and ') : ''} order by y.created_at desc, y.id desc limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (x) => [x.created_at.toISOString(), x.id], toCr);
}

export async function getCnRequest(tx: Tx, ctx: Ctx, no: string): Promise<CnRequest> {
  readCr(ctx);
  const r = await tx.query<CrRow>(`${CR_SELECT} where r.no = $1`, [no]);
  if (!r.rows[0]) throw E.notFound(`ไม่พบคำขอลดหนี้ ${no}`);
  return toCr(r.rows[0]);
}

export async function createCnRequest(tx: Tx, deps: Deps, ctx: Ctx, req: { invoiceNo: string; amount: string; reason: string; note: string; refundMethod: 'cash' | 'transfer' | 'credit' }): Promise<CnRequest> {
  requireAny(ctx, ['sales.doc', 'fin.ar']);
  const src = await getDocRow(tx, req.invoiceNo);
  if (!['INV', 'ABB', 'RC'].includes(src.type)) throw E.validation(`${src.no} ไม่ใช่ใบกำกับขาย`);
  if (src.status !== 'active') throw E.conflict(`${src.no} ถูกยกเลิกแล้ว`);
  if (!d(req.amount).gt(0)) throw E.validation('ยอดลดหนี้ต้องมากกว่า 0');
  const used = await tx.query<{ t: string | null }>(
    `select (coalesce((select sum(total) from docs where ref_doc_id = $1 and type = 'CN' and status = 'active'), 0)
           + coalesce((select sum(amount) from ar_cn_requests where invoice_doc_id = $1 and status = 'pending'), 0))::text t`, [src.id]);
  const room = d(src.total).minus(d(used.rows[0]?.t ?? 0));
  if (d(req.amount).gt(room)) throw E.conflict(`ขอลดหนี้ได้ไม่เกิน ฿${fmtTHB(money(room))} (หักใบลดหนี้และคำขอที่รออยู่แล้ว)`, { max: money(room) });
  const no = await nextDocNo(tx, ctx.tenantId, 'CR', deps.today());
  await tx.query(
    `insert into ar_cn_requests (tenant_id, no, date, invoice_doc_id, customer_id, amount, reason, note, refund_method, requested_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [ctx.tenantId, no, deps.today(), src.id, src.customer_id, money(req.amount), req.reason.trim(), req.note.trim(), req.refundMethod, ctx.userId]);
  await writeAudit(tx, ctx, [{ action: 'create', object: 'cn-request', ref: no, detail: `ขอลดหนี้ ${src.no} · ${src.customer_name ?? ''} · ฿${fmtTHB(req.amount)} · ${req.reason}` }]);
  return getCnRequest(tx, ctx, no);
}

export async function decideCnRequest(tx: Tx, deps: Deps, ctx: Ctx, no: string, body: { approve: boolean; note: string }): Promise<CnRequest> {
  if (can(ctx, 'sales.return') !== 1) throw E.forbidden('อนุมัติลดหนี้ได้เฉพาะผู้จัดการหรือเจ้าของร้าน', { perm: 'sales.return' });
  const r = await tx.query<CrRow>(`${CR_SELECT} where r.no = $1 for update of r`, [no]);
  const x = r.rows[0];
  if (!x) throw E.notFound(`ไม่พบคำขอลดหนี้ ${no}`);
  if (x.status !== 'pending') throw E.conflict(`${no} ตัดสินแล้ว`);
  if (x.requester_id === ctx.userId && ctx.role !== 'owner') throw E.forbidden('อนุมัติคำขอของตัวเองไม่ได้');
  if (!body.approve) {
    await tx.query(`update ar_cn_requests set status = 'rejected', decided_by = $2, decided_at = now(), decide_note = $3 where id = $1`, [x.id, ctx.userId, body.note]);
    await writeAudit(tx, ctx, [{ action: 'reject', object: 'cn-request', ref: no, detail: body.note || 'ไม่อนุมัติ' }]);
    return getCnRequest(tx, ctx, no);
  }
  const cn = await insertLumpCreditNote(tx, deps, ctx, x.inv_no, x.amount, x.refund_method, `ลดหนี้ตามคำขอ ${no} · ${x.reason}`, x.note);
  await tx.query(`update ar_cn_requests set status = 'approved', decided_by = $2, decided_at = now(), decide_note = $3, cn_doc_id = $4 where id = $1`, [x.id, ctx.userId, body.note, cn.id]);
  await writeAudit(tx, ctx, [
    { action: 'approve', object: 'cn-request', ref: no, detail: `อนุมัติ · ใบลดหนี้ ${cn.no}${body.note ? ` · ${body.note}` : ''}` },
    { action: 'create', object: 'CN', ref: cn.no, detail: `ลดหนี้ ${x.inv_no} ฿${fmtTHB(x.amount)}${d(cn.toAr).gt(0) ? ` · ลดยอดค้าง ฿${fmtTHB(cn.toAr)}` : ''}${d(cn.refunded).gt(0) ? ` · คืนเงิน ${METHOD_TH[x.refund_method]} ฿${fmtTHB(cn.refunded)}` : ''}${d(cn.credit).gt(0) ? ` · เครดิตลูกค้า ฿${fmtTHB(cn.credit)}` : ''} · ${x.reason}` },
  ]);
  return getCnRequest(tx, ctx, no);
}

export async function cancelCnRequest(tx: Tx, ctx: Ctx, no: string): Promise<CnRequest> {
  const r = await tx.query<{ id: string; status: string; requested_by: string }>(`select id, status, requested_by from ar_cn_requests where no = $1 for update`, [no]);
  const x = r.rows[0];
  if (!x) throw E.notFound(`ไม่พบคำขอลดหนี้ ${no}`);
  if (x.status !== 'pending') throw E.conflict(`${no} ตัดสินแล้ว`);
  if (x.requested_by !== ctx.userId && can(ctx, 'sales.return') !== 1) throw E.forbidden('ยกเลิกได้เฉพาะผู้ขอหรือผู้อนุมัติ');
  await tx.query(`update ar_cn_requests set status = 'cancelled', decided_by = $2, decided_at = now() where id = $1`, [x.id, ctx.userId]);
  await writeAudit(tx, ctx, [{ action: 'void', object: 'cn-request', ref: no, detail: 'ยกเลิกคำขอ' }]);
  return getCnRequest(tx, ctx, no);
}
