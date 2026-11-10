/**
 * Receivables (M10): billing notes over several invoices (REQ-M10-01), receipts settling several invoices or part of one
 * with withholding tax 1 % / 3 % or a typed amount and the 50 ทวิ number (REQ-M10-02/03), aging buckets (REQ-M10-04),
 * the home-page due / overdue card (REQ-M10-05), customer statement. Balances are docs.ar_balance of active B2B
 * invoices: total, minus receipts, minus credit notes with a credit refund (net of credit notes).
 */
import type { Tx } from '@erp/db';
import type { ArAging, ArBillingNote, ArBillingNoteSummary, ArOpenInvoice, ArReceipt, ArReceiptReq, ArReceiptSummary, ArStatement, SalesPageQuery } from '@erp/contracts';
import { addDays, agingBucket, AGING_BUCKETS, d, daysOverdue, fmtTHB, money, receiptTotals, sum, WhtError, type AgingBucket , searchTokens } from '@erp/core';
import type { z } from 'zod';
import type { ArAgingQuery, ArBillingNoteReq, ArInvoicesQuery } from '@erp/contracts';
import { writeAudit } from '../../lib/audit';
import { requirePerm, type Ctx, type Deps } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E, isUuid } from '../../lib/errors';
import { decodeCursor, pageOf } from '../../lib/paging';
import { haystack, loadCustomer, pageNewest, party, partyCols, partyOf, voidedJson, type PartyCols } from './common';

const METHOD_TH: Record<string, string> = { cash: 'เงินสด', transfer: 'โอนเงิน', cheque: 'เช็ค', promptpay: 'พร้อมเพย์', card: 'บัตร' };

/** Open (unpaid) invoices of one customer, locked for the caller's transaction. */
interface InvLock { id: string; no: string; date: string; customer_id: string | null; status: string; total: string; vat: string; ar_balance: string; due_date: string | null }
async function lockInvoices(tx: Tx, nos: string[]): Promise<Map<string, InvLock>> {
  await tx.query(`select id from docs where no = any($1::text[]) and type = 'INV' order by id for update`, [nos]);
  const r = await tx.query<InvLock>(
    `select x.id, x.no, x.date::text, x.customer_id, x.status, x.total::text, x.vat::text, x.ar_balance::text, si.due_date::text
       from docs x left join sales_invoices si on si.doc_id = x.id where x.no = any($1::text[]) and x.type = 'INV'`,
    [nos],
  );
  const m = new Map(r.rows.map((x) => [x.no, x]));
  const missing = nos.filter((n) => !m.has(n));
  if (missing.length) throw E.notFound(`Invoice ${missing.join(', ')} not found`);
  return m;
}

function checkOpen(inv: InvLock, customerId: string): void {
  if (inv.status !== 'active') throw E.conflict(`${inv.no} is void`);
  if (!inv.due_date) throw E.validation(`${inv.no} is not a receivable invoice`);
  if (inv.customer_id !== customerId) throw E.validation(`${inv.no} belongs to another customer`);
  if (!d(inv.ar_balance).gt(0)) throw E.conflict(`${inv.no} has no outstanding balance`);
}

// ---------- billing notes ----------
export async function createBillingNote(tx: Tx, deps: Deps, ctx: Ctx, req: z.infer<typeof ArBillingNoteReq>): Promise<ArBillingNote> {
  requirePerm(ctx, 'fin.ar');
  const customer = await loadCustomer(tx, req.customerId);
  const nos = [...new Set(req.invoiceNos)];
  if (nos.length !== req.invoiceNos.length) throw E.validation('An invoice appears twice');
  const invs = await lockInvoices(tx, nos);
  for (const n of nos) checkOpen(invs.get(n)!, customer.id);
  const inBn = await tx.query<{ inv: string; bn: string }>(
    `select x.no inv, b.no bn from ar_billing_note_lines l join ar_billing_notes b on b.id = l.bn_id join docs x on x.id = l.invoice_doc_id
      where l.invoice_doc_id = any($1::uuid[]) and b.status = 'active'`, [nos.map((n) => invs.get(n)!.id)]);
  if (inBn.rowCount) throw E.conflict(`Already on a billing note: ${inBn.rows.map((r) => `${r.inv} (${r.bn})`).join(', ')}`);
  const date = req.date ?? deps.today();
  if (req.collectDate && req.collectDate < date) throw E.validation('The collection date must not be before the billing note date');
  const lines = nos.map((n) => invs.get(n)!).sort((a, b) => (a.due_date! < b.due_date! ? -1 : a.due_date! > b.due_date! ? 1 : a.no < b.no ? -1 : 1));
  const total = money(sum(lines.map((l) => l.ar_balance)));
  const no = await nextDocNo(tx, ctx.tenantId, 'BN', date);
  const id = (await tx.query<{ id: string }>(
    `insert into ar_billing_notes (tenant_id, no, date, customer_id, collect_date, note, total, created_by, search_text) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [ctx.tenantId, no, date, customer.id, req.collectDate ?? null, req.note, total, ctx.userId, haystack(no, customer, lines.map((l) => l.no), total)],
  )).rows[0]!.id;
  for (const [i, l] of lines.entries()) {
    await tx.query(`insert into ar_billing_note_lines (tenant_id, bn_id, line_no, invoice_doc_id, amount, due_date) values ($1,$2,$3,$4,$5,$6)`,
      [ctx.tenantId, id, i + 1, l.id, l.ar_balance, l.due_date]);
  }
  await writeAudit(tx, ctx, [{ action: 'create', object: 'BN', ref: no, detail: `${customer.name} · ${lines.length} ใบกำกับ · ฿${fmtTHB(total)}${req.collectDate ? ` · นัดรับเช็ค ${req.collectDate}` : ''}` }]);
  return getBillingNote(tx, no);
}

export async function getBillingNote(tx: Tx, no: string): Promise<ArBillingNote> {
  const r = await tx.query<PartyCols & { id: string; no: string; date: string; collect_date: string | null; note: string; total: string; status: 'active' | 'void'; created_by_name: string; void_by_name: string | null; void_at: Date | null; void_reason: string | null }>(
    `select x.id, x.no, x.date::text, x.collect_date::text, x.note, x.total::text, x.status, cu.name created_by_name, vu.name void_by_name, x.void_at, x.void_reason, ${partyCols}
       from ar_billing_notes x join customers c on c.id = x.customer_id join users cu on cu.id = x.created_by left join users vu on vu.id = x.void_by where x.no = $1`, [no]);
  const x = r.rows[0];
  if (!x) throw E.notFound(`Billing note ${no} not found`);
  const lines = await tx.query<{ no: string; date: string; due_date: string; total: string; amount: string }>(
    `select v.no, v.date::text, l.due_date::text, v.total::text, l.amount::text from ar_billing_note_lines l join docs v on v.id = l.invoice_doc_id where l.bn_id = $1 order by l.line_no`, [x.id]);
  return {
    id: x.id, no: x.no, date: x.date, customer: partyOf(x), collectDate: x.collect_date, note: x.note, total: x.total, status: x.status, createdBy: x.created_by_name,
    voided: voidedJson(x), lines: lines.rows.map((l) => ({ invoiceNo: l.no, invoiceDate: l.date, dueDate: l.due_date, invoiceTotal: l.total, amount: l.amount })),
  };
}

export async function voidBillingNote(tx: Tx, ctx: Ctx, no: string, reason: string): Promise<ArBillingNote> {
  requirePerm(ctx, 'fin.ar');
  await tx.query(`select id from ar_billing_notes where no = $1 for update`, [no]);
  const bn = await getBillingNote(tx, no);
  if (bn.status === 'void') throw E.conflict(`${no} is already void`);
  await tx.query(`update ar_billing_notes set status = 'void', void_by = $2, void_at = now(), void_reason = $3 where id = $1`, [bn.id, ctx.userId, reason]);
  await writeAudit(tx, ctx, [{ action: 'void', object: 'BN', ref: no, detail: `${reason} · ฿${fmtTHB(bn.total)}` }]);
  return getBillingNote(tx, no);
}

export async function listBillingNotes(tx: Tx, q: SalesPageQuery) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.customerId) {
    if (!isUuid(q.customerId)) throw E.validation('Unknown customer');
    params.push(q.customerId);
    where.push(`x.customer_id = $${params.length}`);
  }
  if (q.status === 'active' || q.status === 'void') {
    params.push(q.status);
    where.push(`x.status = $${params.length}`);
  }
  return pageNewest<{ id: string; no: string; date: string; customer_id: string; c_name: string; collect_date: string | null; total: string; count: number; status: 'active' | 'void'; created_at: Date }, ArBillingNoteSummary>(
    tx, `x.id, x.no, x.date::text, x.customer_id, c.name c_name, x.collect_date::text, x.total::text, (select count(*)::int from ar_billing_note_lines l where l.bn_id = x.id) count, x.status, x.created_at`,
    `ar_billing_notes x join customers c on c.id = x.customer_id`, where, params, q,
    (r) => ({ id: r.id, no: r.no, date: r.date, customer: { id: r.customer_id, name: r.c_name }, collectDate: r.collect_date, total: r.total, count: r.count, status: r.status }),
  );
}

// ---------- receipts ----------
export async function createReceipt(tx: Tx, deps: Deps, ctx: Ctx, req: ArReceiptReq): Promise<ArReceipt> {
  requirePerm(ctx, 'fin.ar');
  const customer = await loadCustomer(tx, req.customerId);
  const nos = req.lines.map((l) => l.invoiceNo);
  if (new Set(nos).size !== nos.length) throw E.validation('An invoice appears twice');
  if (req.method === 'cheque' && !req.cheque) throw E.validation('A cheque payment needs the cheque number, bank and date');
  const invs = await lockInvoices(tx, nos);
  for (const l of req.lines) {
    const inv = invs.get(l.invoiceNo)!;
    checkOpen(inv, customer.id);
    if (!d(l.amount).gt(0)) throw E.validation(`${l.invoiceNo}: amount must be > 0`);
    if (d(l.amount).gt(d(inv.ar_balance))) throw E.conflict(`${l.invoiceNo}: ${money(l.amount)} is more than the outstanding ${inv.ar_balance}`, { invoiceNo: l.invoiceNo, arBalance: inv.ar_balance });
  }
  let t;
  try {
    t = receiptTotals(req.lines.map((l) => ({ settled: l.amount, invoiceTotal: invs.get(l.invoiceNo)!.total, invoiceVat: invs.get(l.invoiceNo)!.vat })),
      req.wht.mode === 'rate' ? { mode: 'rate', rate: req.wht.rate } : req.wht.mode === 'amount' ? { mode: 'amount', amount: req.wht.amount } : { mode: 'none' });
  } catch (e) {
    if (e instanceof WhtError) throw E.validation(e.message);
    throw e;
  }
  const date = req.date ?? deps.today();
  const no = await nextDocNo(tx, ctx.tenantId, 'RE', date);
  const certNo = req.whtCertNo?.trim() || null;
  const id = (await tx.query<{ id: string }>(
    `insert into ar_receipts (tenant_id, no, date, customer_id, method, cheque, settled, wht_rate, wht, wht_cert_no, cash, note, created_by, search_text)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [ctx.tenantId, no, date, customer.id, req.method, req.cheque ? JSON.stringify(req.cheque) : null, t.settled, req.wht.mode === 'rate' ? req.wht.rate : null, t.wht,
      certNo, t.cash, req.note, ctx.userId, haystack(no, customer, nos, t.settled, [certNo ?? '', req.cheque?.no ?? ''])],
  )).rows[0]!.id;
  for (const [i, l] of req.lines.entries()) {
    const inv = invs.get(l.invoiceNo)!;
    await tx.query(`insert into ar_receipt_lines (tenant_id, receipt_id, line_no, invoice_doc_id, settled, wht_base, wht) values ($1,$2,$3,$4,$5,$6,$7)`,
      [ctx.tenantId, id, i + 1, inv.id, money(l.amount), t.lines[i]!.whtBase, t.lines[i]!.wht]);
    await tx.query(`update docs set ar_balance = ar_balance - $2 where id = $1`, [inv.id, money(l.amount)]);
  }
  await writeAudit(tx, ctx, [{
    action: 'create', object: 'RE', ref: no,
    detail: `${customer.name} · ตัดหนี้ ฿${fmtTHB(t.settled)} (${nos.join(', ')}) · รับ ${METHOD_TH[req.method]} ฿${fmtTHB(t.cash)}${d(t.wht).gt(0) ? ` · หัก ณ ที่จ่าย ฿${fmtTHB(t.wht)}${certNo ? ` 50 ทวิ ${certNo}` : ''}` : ''}`,
  }]);
  return getReceipt(tx, no);
}

export async function getReceipt(tx: Tx, no: string): Promise<ArReceipt> {
  const r = await tx.query<PartyCols & { id: string; no: string; date: string; method: ArReceipt['method']; cheque: ArReceipt['cheque']; settled: string; wht_rate: string | null; wht: string; wht_cert_no: string | null; cash: string; note: string; status: 'active' | 'void'; created_by_name: string; void_by_name: string | null; void_at: Date | null; void_reason: string | null }>(
    `select x.id, x.no, x.date::text, x.method, x.cheque, x.settled::text, x.wht_rate::text, x.wht::text, x.wht_cert_no, x.cash::text, x.note, x.status, cu.name created_by_name,
            vu.name void_by_name, x.void_at, x.void_reason, ${partyCols}
       from ar_receipts x join customers c on c.id = x.customer_id join users cu on cu.id = x.created_by left join users vu on vu.id = x.void_by where x.no = $1`, [no]);
  const x = r.rows[0];
  if (!x) throw E.notFound(`Receipt ${no} not found`);
  const lines = await tx.query<{ no: string; date: string; total: string; settled: string; wht_base: string; wht: string }>(
    `select v.no, v.date::text, v.total::text, l.settled::text, l.wht_base::text, l.wht::text from ar_receipt_lines l join docs v on v.id = l.invoice_doc_id where l.receipt_id = $1 order by l.line_no`, [x.id]);
  return {
    id: x.id, no: x.no, date: x.date, customer: partyOf(x), method: x.method, cheque: x.cheque, settled: x.settled, whtRate: x.wht_rate ? d(x.wht_rate).toFixed() : null,
    wht: x.wht, whtCertNo: x.wht_cert_no, cash: x.cash, note: x.note, status: x.status, createdBy: x.created_by_name, voided: voidedJson(x),
    lines: lines.rows.map((l) => ({ invoiceNo: l.no, invoiceDate: l.date, invoiceTotal: l.total, settled: l.settled, whtBase: l.wht_base, wht: l.wht })),
  };
}

/** Reverses a receipt (BR-22 "กลับรายการรับชำระ"): the invoices get their balances back. */
export async function voidReceipt(tx: Tx, ctx: Ctx, no: string, reason: string): Promise<ArReceipt> {
  requirePerm(ctx, 'fin.ar');
  await tx.query(`select id from ar_receipts where no = $1 for update`, [no]);
  const rc = await getReceipt(tx, no);
  if (rc.status === 'void') throw E.conflict(`${no} is already void`);
  const lines = await tx.query<{ invoice_doc_id: string; settled: string }>(`select invoice_doc_id, settled::text from ar_receipt_lines where receipt_id = $1 order by invoice_doc_id`, [rc.id]);
  await tx.query(`select id from docs where id = any($1::uuid[]) order by id for update`, [lines.rows.map((l) => l.invoice_doc_id)]);
  for (const l of lines.rows) await tx.query(`update docs set ar_balance = ar_balance + $2 where id = $1`, [l.invoice_doc_id, l.settled]);
  await tx.query(`update ar_receipts set status = 'void', void_by = $2, void_at = now(), void_reason = $3 where id = $1`, [rc.id, ctx.userId, reason]);
  await writeAudit(tx, ctx, [{ action: 'void', object: 'RE', ref: no, detail: `${reason} · คืนยอดค้าง ฿${fmtTHB(rc.settled)} (${rc.lines.map((l) => l.invoiceNo).join(', ')})` }]);
  return getReceipt(tx, no);
}

export async function listReceipts(tx: Tx, q: SalesPageQuery) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.customerId) {
    if (!isUuid(q.customerId)) throw E.validation('Unknown customer');
    params.push(q.customerId);
    where.push(`x.customer_id = $${params.length}`);
  }
  if (q.status === 'active' || q.status === 'void') {
    params.push(q.status);
    where.push(`x.status = $${params.length}`);
  } else if (q.status === 'wht') where.push(`x.status = 'active' and x.wht > 0`);
  return pageNewest<{ id: string; no: string; date: string; customer_id: string; c_name: string; method: ArReceiptSummary['method']; settled: string; wht: string; cash: string; invs: string | null; status: 'active' | 'void'; created_at: Date }, ArReceiptSummary>(
    tx, `x.id, x.no, x.date::text, x.customer_id, c.name c_name, x.method, x.settled::text, x.wht::text, x.cash::text, x.status, x.created_at,
         (select string_agg(v.no, ', ' order by l.line_no) from ar_receipt_lines l join docs v on v.id = l.invoice_doc_id where l.receipt_id = x.id) invs`,
    `ar_receipts x join customers c on c.id = x.customer_id`, where, params, q,
    (r) => ({ id: r.id, no: r.no, date: r.date, customer: { id: r.customer_id, name: r.c_name }, method: r.method, settled: r.settled, wht: r.wht, cash: r.cash, invoices: r.invs ?? '', status: r.status }),
  );
}

// ---------- aging / open invoices / due soon ----------
const OPEN = `x.type = 'INV' and x.status = 'active' and x.ar_balance > 0`;
const BUCKET_SQL = (asOf: string) => `case when si.due_date >= ${asOf} then 'notDue' when ${asOf} - si.due_date <= 30 then 'd1_30' when ${asOf} - si.due_date <= 60 then 'd31_60'
  when ${asOf} - si.due_date <= 90 then 'd61_90' else 'over90' end`;

type Buckets = Record<AgingBucket, string>;
const zeroBuckets = (): Buckets => Object.fromEntries(AGING_BUCKETS.map((b) => [b, '0.00'])) as Buckets;

/** REQ-M10-04: per customer, keyset paged by customer code; totals over every customer. */
export async function aging(tx: Tx, deps: Deps, q: z.infer<typeof ArAgingQuery>): Promise<ArAging> {
  const asOf = q.asOf ?? deps.today();
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [asOf];
  const where = [OPEN];
  for (const w of searchTokens(q.q)) {
    params.push(`%${w.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
    where.push(`(lower(c.name) like $${params.length} or lower(c.code) like $${params.length})`);
  }
  const base = `from docs x join sales_invoices si on si.doc_id = x.id join customers c on c.id = x.customer_id where ${where.join(' and ')}`;
  const tot = await tx.query<{ b: AgingBucket; amt: string }>(`select ${BUCKET_SQL('$1::date')} b, sum(x.ar_balance)::text amt ${base} group by 1`, params);
  const totals = { ...zeroBuckets(), total: '0.00' };
  for (const r of tot.rows) totals[r.b] = money(r.amt);
  totals.total = money(sum(tot.rows.map((r) => r.amt)));
  const p2 = [...params];
  let keyset = '';
  if (cur) {
    p2.push(cur[0], cur[1]);
    keyset = `having (c.code, c.id) > ($${p2.length - 1}, $${p2.length}::uuid)`;
  }
  p2.push(q.limit + 1);
  const r = await tx.query<{ id: string; code: string; name: string; term: ArAging['items'][number]['term']; credit_limit: string; balance: string; invoices: number; overdue: number; notdue: string; d1_30: string; d31_60: string; d61_90: string; over90: string }>(
    `select c.id, c.code, c.name, c.term, c.credit_limit::text, sum(x.ar_balance)::text balance, count(*)::int invoices,
            count(*) filter (where si.due_date < $1::date)::int overdue,
            ${AGING_BUCKETS.map((b) => `coalesce(sum(x.ar_balance) filter (where ${BUCKET_SQL('$1::date')} = '${b}'), 0)::text ${b.toLowerCase()}`).join(', ')}
       ${base} group by c.id, c.code, c.name, c.term, c.credit_limit ${keyset} order by c.code, c.id limit $${p2.length}`,
    p2,
  );
  const limitDefault = await defaultCreditLimit(tx);
  const pg = pageOf(r.rows, q.limit, (x) => [x.code, x.id], (x) => ({
    customer: { id: x.id, code: x.code, name: x.name }, term: x.term, limit: d(x.credit_limit).gt(0) ? money(x.credit_limit) : limitDefault, balance: money(x.balance),
    buckets: { notDue: money(x.notdue), d1_30: money(x.d1_30), d31_60: money(x.d31_60), d61_90: money(x.d61_90), over90: money(x.over90) }, invoices: x.invoices, overdue: x.overdue,
  }));
  return { asOf, totals, items: pg.items, nextCursor: pg.nextCursor };
}

/** Shop default credit limit (REQ-M10-06: 50,000 unless set). */
export async function defaultCreditLimit(tx: Tx): Promise<string> {
  const r = await tx.query<{ v: string }>(`select default_credit_limit::text v from sales_settings`);
  return money(r.rows[0]?.v ?? '50000');
}

/** Open invoices ordered by due date (oldest first), keyset paged; picker for billing notes and receipts. */
export async function openInvoices(tx: Tx, deps: Deps, q: z.infer<typeof ArInvoicesQuery>) {
  const asOf = q.asOf ?? deps.today();
  const cur = decodeCursor(q.cursor, 3);
  const params: unknown[] = [];
  const where = [OPEN];
  if (q.customerId) {
    if (!isUuid(q.customerId)) throw E.validation('Unknown customer');
    params.push(q.customerId);
    where.push(`x.customer_id = $${params.length}`);
  }
  if (q.bucket) {
    params.push(asOf, q.bucket);
    where.push(`${BUCKET_SQL(`$${params.length - 1}::date`)} = $${params.length}`);
  }
  const bnSub = `(select b.no from ar_billing_note_lines l join ar_billing_notes b on b.id = l.bn_id where l.invoice_doc_id = x.id and b.status = 'active' limit 1)`;
  if (q.unbilled) where.push(`${bnSub} is null`);
  for (const w of searchTokens(q.q)) {
    params.push(`%${w.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
    where.push(`x.search_text like $${params.length}`);
  }
  if (cur) {
    params.push(cur[0], cur[1], cur[2]);
    where.push(`(si.due_date, x.no, x.id) > ($${params.length - 2}::date, $${params.length - 1}, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<{ id: string; no: string; date: string; due_date: string; customer_id: string; customer_name: string; total: string; vat: string; ar_balance: string; bn: string | null; pj_name: string | null }>(
    `select x.id, x.no, x.date::text, si.due_date::text, x.customer_id, x.customer_name, x.total::text, x.vat::text, x.ar_balance::text, ${bnSub} bn, pj.name pj_name
       from docs x join sales_invoices si on si.doc_id = x.id left join sales_projects pj on pj.id = si.project_id
      where ${where.join(' and ')} order by si.due_date, x.no, x.id limit $${params.length}`,
    params,
  );
  return pageOf(r.rows, q.limit, (x) => [x.due_date, x.no, x.id], (x): ArOpenInvoice => ({
    id: x.id, no: x.no, date: x.date, dueDate: x.due_date, customer: { id: x.customer_id, name: x.customer_name }, total: x.total, vat: x.vat, arBalance: x.ar_balance,
    overdueDays: daysOverdue(x.due_date, asOf), bucket: agingBucket(x.due_date, asOf), billingNoteNo: x.bn, projectName: x.pj_name,
  }));
}

/** REQ-M10-05 home card: due within `days` (not yet overdue) and overdue, amounts and how many customers / invoices. */
export async function dueSoon(tx: Tx, deps: Deps, days = 7) {
  const asOf = deps.today();
  const until = addDays(asOf, days);
  const r = await tx.query<{ k: 'soon' | 'over'; customers: number; invoices: number; amount: string }>(
    `select case when si.due_date < $1::date then 'over' else 'soon' end k, count(distinct x.customer_id)::int customers, count(*)::int invoices, sum(x.ar_balance)::text amount
       from docs x join sales_invoices si on si.doc_id = x.id where ${OPEN} and si.due_date <= $2::date group by 1`,
    [asOf, until],
  );
  const pick = (k: 'soon' | 'over') => {
    const x = r.rows.find((y) => y.k === k);
    return { customers: x?.customers ?? 0, invoices: x?.invoices ?? 0, amount: money(x?.amount ?? 0) };
  };
  return { asOf, days, dueSoon: pick('soon'), overdue: pick('over') };
}

/** Customer statement: invoices (debit), credit-refund credit notes, receipts and WHT (credit), with opening balance. */
export async function statement(tx: Tx, deps: Deps, q: { customerId: string; from?: string; to?: string }): Promise<ArStatement> {
  const customer = await loadCustomer(tx, q.customerId);
  const to = q.to ?? deps.today();
  const from = q.from ?? addDays(to, -90);
  type L = { date: string; no: string; kind: 'INV' | 'CN' | 'RC' | 'WHT'; ref: string | null; debit: string; credit: string; note: string; at: Date };
  const r = await tx.query<L>(
    `select x.date::text date, x.no, 'INV' kind, null ref, x.total::text debit, '0' credit, coalesce(si.attn, '') note, x.created_at at
       from docs x join sales_invoices si on si.doc_id = x.id where x.customer_id = $1 and x.status = 'active' and si.kind = 'credit' and x.date <= $2::date
     union all
     select c.date::text, c.no, 'CN', c.ref_no, '0', c.total::text, coalesce(c.reason, ''), c.created_at
       from docs c join sales_invoices si on si.doc_id = c.ref_doc_id where c.customer_id = $1 and c.type = 'CN' and c.status = 'active' and c.refund = 'credit' and c.date <= $2::date
     union all
     select rc.date::text, rc.no, 'RC', null, '0', rc.cash::text, rc.method, rc.created_at from ar_receipts rc where rc.customer_id = $1 and rc.status = 'active' and rc.date <= $2::date
     union all
     select rc.date::text, rc.no, 'WHT', rc.wht_cert_no, '0', rc.wht::text, 'ภาษีหัก ณ ที่จ่าย', rc.created_at from ar_receipts rc where rc.customer_id = $1 and rc.status = 'active' and rc.wht > 0 and rc.date <= $2::date
     order by date, at, no`,
    [customer.id, to],
  );
  let opening = d(0);
  let bal = d(0);
  const lines: ArStatement['lines'] = [];
  for (const l of r.rows) {
    const delta = d(l.debit).minus(d(l.credit));
    if (l.date < from) {
      opening = opening.plus(delta);
      bal = opening;
      continue;
    }
    bal = bal.plus(delta);
    lines.push({ date: l.date, no: l.no, kind: l.kind, ref: l.ref, debit: money(l.debit), credit: money(l.credit), balance: money(bal), note: l.note === 'cheque' || METHOD_TH[l.note] ? METHOD_TH[l.note]! : l.note });
  }
  const open = await openInvoices(tx, deps, { customerId: customer.id, limit: 100 });
  return { customer: party(customer), from, to, opening: money(opening), closing: money(lines.length ? bal : opening), lines, open: open.items };
}
