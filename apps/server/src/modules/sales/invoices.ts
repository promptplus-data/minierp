/**
 * B2B tax invoices (REQ-M08-05/10, M10): from delivery orders (several, one customer), direct (cuts stock now, optionally
 * "goods left at the shop" for a later delivery order), from a project installment / deposit (projects.ts), and a full
 * tax invoice issued later for a POS abbreviated invoice. Every invoice is a core `docs` row (type INV, so returns,
 * void, the document list and the sales-tax view keep working) plus a `sales_invoices` row with the B2B facts.
 * Receivable = docs.ar_balance: total for a credit invoice, reduced by receipts and credit-refund credit notes.
 */
import type { Tx } from '@erp/db';
import type { SalesCreditNoteSummary, SalesInvoice, SalesInvoiceReq, SalesInvoiceSummary, SalesPageQuery, SalesTerm } from '@erp/contracts';
import { calcDoc, d, daysOverdue, dueDate, fmtTHB, money, qty4, sum, type DocTotals, type VatMode } from '@erp/core';
import { writeAudit, type AuditInput } from '../../lib/audit';
import { can, requireAny, requirePerm, type Ctx, type Deps } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E, isUuid } from '../../lib/errors';
import { applyOut, lockLots, planTakes, type Planned } from '../../lib/stock';
import { requireWarehouse } from '../../services/master';
import { getDoc, getDocRow, getLines, registerVoidGuard } from '../../services/sales';
import {
  belowCostGate, buildLines, creditGate, discAmt, haystack, inSeq, loadCustomer, loadShop, pageNewest, partyCols, partyOf, planUnitCosts, requireUser, resolveVatMode,
  totalsOf, userRef, type BuiltLine, type CustomerRow, type PartyCols,
} from './common';

export interface InvoiceLineIn {
  productId: string; name: string; unitName: string; unitFactor: string; qty: string; baseQty: string; unitPrice: string; discount: string;
  net: string; after: string; vat: 'v7' | 'exempt'; cogs: string | null; srcLineId?: string | null;
}
export interface InvoiceExt {
  kind: 'credit' | 'cash'; source: SalesInvoice['source']; soId?: string | null; projectId?: string | null; installmentId?: string | null; depositId?: string | null;
  term: SalesTerm; dueDate: string; goodsLeft?: boolean; grossAmount?: string | null; depositDeduct?: string; depositType?: 'guarantee' | 'advance' | null;
  textLines?: { name: string; amount: string }[]; attn?: string; note?: string; salespersonId?: string | null;
}
export interface NewInvoice {
  date: string; customer: CustomerRow; vatMode: VatMode; totals: Pick<DocTotals, 'gross' | 'lineDisc' | 'billDisc' | 'base7' | 'exempt' | 'vat' | 'total'>;
  lines: InvoiceLineIn[]; payments: { method: string; amount: string }[]; arBalance: string; warehouseId?: string | null; shiftId?: string | null;
  refDocId?: string | null; refNo?: string | null; search: string[]; ext: InvoiceExt;
}

/** Inserts docs + doc_lines + sales_invoices. Returns the doc id, number and line ids (in order). */
export async function insertInvoice(tx: Tx, ctx: Ctx, inv: NewInvoice, no?: string): Promise<{ id: string; no: string; lineIds: string[] }> {
  const docNo = no ?? (await nextDocNo(tx, ctx.tenantId, 'INV', inv.date));
  const t = inv.totals;
  const id = (await tx.query<{ id: string }>(
    `insert into docs (tenant_id, no, type, date, customer_id, customer_name, customer_phone, vat_mode, warehouse_id, shift_id, gross, line_disc, bill_disc, base7, exempt,
       vat, total, ar_balance, payments, created_by, ref_doc_id, ref_no, search_text)
     values ($1,$2,'INV',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) returning id`,
    [ctx.tenantId, docNo, inv.date, inv.customer.id, inv.customer.name, inv.customer.phone, inv.vatMode, inv.warehouseId ?? null, inv.shiftId ?? null,
      t.gross, t.lineDisc, t.billDisc, t.base7, t.exempt, t.vat, t.total, inv.arBalance, JSON.stringify(inv.payments), ctx.userId, inv.refDocId ?? null,
      inv.refNo ?? null, haystack(docNo, inv.customer, inv.search, t.total)],
  )).rows[0]!.id;
  const lineIds: string[] = [];
  for (const [i, l] of inv.lines.entries()) {
    lineIds.push((await tx.query<{ id: string }>(
      `insert into doc_lines (tenant_id, doc_id, line_no, product_id, name, unit_name, unit_factor, qty, base_qty, unit_price, discount, net, net_after_bill, vat, cogs, src_line_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
      [ctx.tenantId, id, i + 1, l.productId, l.name, l.unitName, l.unitFactor, l.qty, l.baseQty, l.unitPrice, l.discount, l.net, l.after, l.vat, l.cogs, l.srcLineId ?? null],
    )).rows[0]!.id);
  }
  const e = inv.ext;
  await tx.query(
    `insert into sales_invoices (doc_id, tenant_id, kind, source, so_id, project_id, installment_id, deposit_id, term, due_date, goods_left, gross_amount, deposit_deduct,
       deposit_type, text_lines, attn, note, salesperson_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [id, ctx.tenantId, e.kind, e.source, e.soId ?? null, e.projectId ?? null, e.installmentId ?? null, e.depositId ?? null, JSON.stringify(e.term), e.dueDate,
      e.goodsLeft ?? false, e.grossAmount ?? null, e.depositDeduct ?? '0', e.depositType ?? null, JSON.stringify(e.textLines ?? []), e.attn ?? '', e.note ?? '',
      e.salespersonId ?? null],
  );
  return { id, no: docNo, lineIds };
}

/** Cash invoice when payments are given (they must add up to the total), else a credit invoice (receivable). */
function settleMode(payments: { method: string; amount: string }[] | undefined, total: string): { kind: 'credit' | 'cash'; payments: { method: string; amount: string }[]; arBalance: string } {
  const p = (payments ?? []).filter((x) => d(x.amount).gt(0));
  if (!p.length) return { kind: 'credit', payments: [], arBalance: total };
  const paid = sum(p.map((x) => x.amount));
  if (!paid.eq(d(total))) throw E.validation(`Payments ${money(paid)} must equal the invoice total ${total}`, { total, paid: money(paid) });
  return { kind: 'cash', payments: p.map((x) => ({ method: x.method, amount: money(x.amount) })), arBalance: '0.00' };
}

async function requireTaxId(tx: Tx, ctx: Ctx, c: CustomerRow): Promise<void> {
  if ((await loadShop(tx, ctx)).vat_registered && !c.tax_id) throw E.validation('A full tax invoice needs a customer with a tax ID');
}

export async function createInvoice(tx: Tx, deps: Deps, ctx: Ctx, req: SalesInvoiceReq): Promise<SalesInvoice> {
  requirePerm(ctx, 'sales.doc');
  return req.source === 'delivery' ? fromDeliveries(tx, deps, ctx, req) : direct(tx, deps, ctx, req);
}

async function fromDeliveries(tx: Tx, deps: Deps, ctx: Ctx, req: Extract<SalesInvoiceReq, { source: 'delivery' }>): Promise<SalesInvoice> {
  const nos = [...new Set(req.deliveryNos)];
  await tx.query(`select id from sales_deliveries where no = any($1::text[]) order by id for update`, [nos]);
  const r = await tx.query<{ id: string; no: string; status: string; customer_id: string | null; so_id: string | null; project_id: string | null; vat_mode: VatMode | null; term: SalesTerm | null; salesperson_id: string | null; so_no: string | null; billed: string | null }>(
    `select dv.id, dv.no, dv.status, dv.customer_id, dv.so_id, dv.project_id, so.vat_mode, so.term, so.salesperson_id, so.no so_no,
            (select string_agg(dd.no, ', ') from sales_invoice_deliveries sid join docs dd on dd.id = sid.invoice_doc_id where sid.delivery_id = dv.id and dd.status = 'active') billed
       from sales_deliveries dv left join sales_orders so on so.id = dv.so_id where dv.no = any($1::text[]) order by dv.created_at`,
    [nos],
  );
  const missing = nos.filter((n) => !r.rows.some((x) => x.no === n));
  if (missing.length) throw E.notFound(`Delivery order ${missing.join(', ')} not found`);
  for (const x of r.rows) {
    if (x.status !== 'active') throw E.conflict(`${x.no} is void`);
    if (!x.so_id) throw E.validation(`${x.no} delivers goods of an invoice that is already issued`);
    if (x.billed) throw E.conflict(`${x.no} is already invoiced (${x.billed})`);
    if (x.project_id) throw E.validation(`${x.no} belongs to a project: bill it by installment on the project page`);
  }
  const first = r.rows[0]!;
  if (r.rows.some((x) => x.customer_id !== first.customer_id)) throw E.validation('All delivery orders on one invoice must be for the same customer');
  if (r.rows.some((x) => x.vat_mode !== first.vat_mode)) throw E.validation('All delivery orders on one invoice must have the same VAT mode');
  const customer = await loadCustomer(tx, first.customer_id);
  await requireTaxId(tx, ctx, customer);
  const vatMode = first.vat_mode!;

  const dl = await tx.query<{ id: string; product_id: string; name: string; unit_name: string; unit_factor: string; qty: string; base_qty: string; value: string; cogs: string | null; vat: 'v7' | 'exempt'; dno: string }>(
    `select dl.id, dl.product_id, dl.name, dl.unit_name, dl.unit_factor::text, dl.qty::text, dl.base_qty::text, dl.value::text, dl.cogs::text, sol.vat, dv.no dno
       from sales_delivery_lines dl join sales_deliveries dv on dv.id = dl.delivery_id join sales_order_lines sol on sol.id = dl.so_line_id
      where dl.delivery_id = any($1::uuid[]) order by dv.created_at, dl.line_no`,
    [r.rows.map((x) => x.id)],
  );
  const totals = calcDoc(dl.rows.map((l) => ({ qty: 1, unitPrice: l.value, vat: l.vat })), vatMode);
  const settle = settleMode(req.payments, totals.total);
  const date = req.date ?? deps.today();
  const term = settle.kind === 'cash' ? { t: 'cash' as const } : first.term ?? customer.term;
  const inv = await insertInvoice(tx, ctx, {
    date, customer, vatMode, totals, payments: settle.payments, arBalance: settle.arBalance,
    lines: dl.rows.map((l) => ({
      productId: l.product_id, name: l.name, unitName: l.unit_name, unitFactor: l.unit_factor, qty: l.qty, baseQty: l.base_qty,
      unitPrice: qty4(d(l.value).div(d(l.qty))), discount: '0', net: l.value, after: l.value, vat: l.vat, cogs: l.cogs,
    })),
    search: [...dl.rows.map((l) => l.name), ...r.rows.map((x) => `${x.no} ${x.so_no ?? ''}`)],
    ext: { kind: settle.kind, source: 'delivery', soId: r.rows.length === 1 || r.rows.every((x) => x.so_id === first.so_id) ? first.so_id : null, term, dueDate: dueDate(date, term), attn: req.attn, note: req.note, salespersonId: first.salesperson_id },
  });
  for (const x of r.rows) await tx.query(`insert into sales_invoice_deliveries (tenant_id, invoice_doc_id, delivery_id) values ($1,$2,$3)`, [ctx.tenantId, inv.id, x.id]);
  await writeAudit(tx, ctx, [{ action: 'create', object: 'INV', ref: inv.no, detail: `${customer.name} · ฿${fmtTHB(totals.total)} · จาก ${r.rows.map((x) => x.no).join(', ')} · ${settle.kind === 'cash' ? 'เงินสด' : `ครบกำหนด ${dueDate(date, term)}`}` }]);
  return getInvoice(tx, deps, ctx, inv.no);
}

async function direct(tx: Tx, deps: Deps, ctx: Ctx, req: Extract<SalesInvoiceReq, { source: 'direct' }>): Promise<SalesInvoice> {
  const customer = await loadCustomer(tx, req.customerId);
  await requireTaxId(tx, ctx, customer);
  const vatMode = await resolveVatMode(tx, ctx, req.vatMode);
  const lines = await buildLines(tx, req.lines, { allowFree: false });
  const totals = totalsOf(lines, vatMode, req.billDiscount);
  const settle = settleMode(req.payments, totals.total);
  const term: SalesTerm = settle.kind === 'cash' ? { t: 'cash' } : req.term ?? customer.term;
  const wh = await requireWarehouse(tx, req.warehouseId);
  const salesperson = await requireUser(tx, req.salespersonId ?? ctx.userId);
  const date = req.date ?? deps.today();
  const audits: AuditInput[] = [];

  const no = await nextDocNo(tx, ctx.tenantId, 'INV', date);
  // BR-07 / BR-21: lock and plan FIFO now (the invoice cuts stock even when the goods stay at the shop).
  const stock = lines.filter((l) => l.product!.kind === 'stock');
  const lots = await lockLots(tx, wh.id, stock.map((l) => l.product!.id));
  const plans = planTakes(lots, wh.id, stock.map((l) => ({ productId: l.product!.id, qty: l.baseQty })));
  const planOf = new Map<BuiltLine, Planned>(stock.map((l, i) => [l, plans[i]!]));
  const bc = await belowCostGate(tx, deps, ctx, lines, vatMode, totals.billDisc, planUnitCosts(lines, planOf), req.belowCostApproval, `ใบกำกับ ${no}`);
  if (bc.audit) audits.push(bc.audit);
  if (settle.kind === 'credit') {
    const cr = await creditGate(tx, deps, ctx, customer, term, totals.total, req.creditApproval, `ใบกำกับ ${no} ${customer.name}`);
    if (cr.audit) audits.push(cr.audit);
  }
  const inv = await insertInvoice(tx, ctx, {
    date, customer, vatMode, totals, payments: settle.payments, arBalance: settle.arBalance, warehouseId: wh.id,
    lines: lines.map((l, i) => ({
      productId: l.product!.id, name: l.name, unitName: l.unitName, unitFactor: l.unitFactor, qty: l.qty, baseQty: l.baseQty, unitPrice: l.unitPrice,
      discount: discAmt(l), net: totals.lines[i]!.net, after: totals.lines[i]!.after, vat: l.vat, cogs: planOf.get(l)?.cogs ?? null,
    })),
    search: lines.map((l) => `${l.name} ${l.product!.sku}`),
    ext: { kind: settle.kind, source: 'direct', term, dueDate: dueDate(date, term), goodsLeft: req.goodsLeft, attn: req.attn, note: req.note, salespersonId: salesperson },
  }, no);
  for (const [i, l] of lines.entries()) {
    const pl = planOf.get(l);
    if (pl) await applyOut(tx, ctx, wh.id, pl, { docType: 'INV', docNo: no, docId: inv.id, docLineId: inv.lineIds[i]!, note: req.goodsLeft ? 'ขายเชื่อ · ลูกค้าฝากของไว้ที่ร้าน' : 'ขายส่ง / เงินเชื่อ' });
  }
  audits.push({ action: 'create', object: 'INV', ref: no, detail: `${customer.name} · ฿${fmtTHB(totals.total)} · ${lines.length} รายการ · ${wh.name}${req.goodsLeft ? ' · ฝากของไว้ที่ร้าน' : ''} · ${settle.kind === 'cash' ? 'เงินสด' : `ครบกำหนด ${dueDate(date, term)}`}` });
  await writeAudit(tx, ctx, audits);
  return getInvoice(tx, deps, ctx, no);
}

/**
 * A full tax invoice for a POS abbreviated invoice, issued later at the customer's request. The ABB is voided with a
 * reason that names the new invoice and the INV refers to the ABB (BR-03 "ออกใหม่ต้องอ้างเลขเดิม"); the goods,
 * stock moves, payments and shift of the sale stay as they are, so no stock is reversed.
 */
export async function invoiceFromAbb(tx: Tx, deps: Deps, ctx: Ctx, req: { abbNo: string; customerId: string }): Promise<SalesInvoice> {
  requireAny(ctx, ['sales.doc', 'pos.sell']);
  const abb = await getDocRow(tx, req.abbNo, { forUpdate: true });
  if (abb.type !== 'ABB') throw E.validation(`${abb.no} is not an abbreviated tax invoice`);
  if (abb.status !== 'active') throw E.conflict(`${abb.no} is void`);
  const lines = await getLines(tx, abb.id);
  if (lines.some((l) => d(l.returned_qty).gt(0))) throw E.conflict(`${abb.no} has returns; issue the full tax invoice before any return`);
  const down = await tx.query<{ no: string }>(`select no from docs where ref_doc_id = $1 and status = 'active'`, [abb.id]);
  if (down.rowCount) throw E.conflict(`${abb.no} already has ${down.rows.map((x) => x.no).join(', ')}`);
  const customer = await loadCustomer(tx, req.customerId);
  if (!customer.tax_id) throw E.validation('A full tax invoice needs a customer with a tax ID');
  const date = deps.today();
  const inv = await insertInvoice(tx, ctx, {
    date, customer, vatMode: abb.vat_mode, warehouseId: abb.warehouse_id, shiftId: abb.shift_id, refDocId: abb.id, refNo: abb.no,
    totals: { gross: abb.gross, lineDisc: abb.line_disc, billDisc: abb.bill_disc, base7: abb.base7, exempt: abb.exempt, vat: abb.vat, total: abb.total },
    payments: abb.payments, arBalance: '0.00',
    lines: lines.map((l) => ({
      productId: l.product_id, name: l.name, unitName: l.unit_name, unitFactor: l.unit_factor, qty: l.qty, baseQty: l.base_qty, unitPrice: l.unit_price,
      discount: l.discount, net: l.net, after: l.net_after_bill, vat: l.vat, cogs: l.cogs, srcLineId: l.id,
    })),
    search: [...lines.map((l) => l.name), abb.no],
    ext: { kind: 'cash', source: 'abb', term: { t: 'cash' }, dueDate: date },
  });
  await tx.query(`update docs set status = 'void', void_by = $2, void_at = now(), void_reason = $3 where id = $1`,
    [abb.id, ctx.userId, `ออกใบกำกับภาษีเต็มรูป ${inv.no} แทน (ลูกค้าขอใบกำกับเต็มรูป)`]);
  await writeAudit(tx, ctx, [
    { action: 'create', object: 'INV', ref: inv.no, detail: `ใบกำกับเต็มรูปแทน ${abb.no} · ${customer.name} · ฿${fmtTHB(abb.total)}` },
    { action: 'void', object: 'ABB', ref: abb.no, detail: `ออกใบกำกับภาษีเต็มรูป ${inv.no} แทน · ฿${fmtTHB(abb.total)}` },
  ]);
  return getInvoice(tx, deps, ctx, inv.no);
}

// ---------- read ----------
interface InvRow extends PartyCols {
  id: string; no: string; customer_name: string; kind: 'credit' | 'cash'; source: SalesInvoice['source']; term: SalesTerm; due_date: string; ar_balance: string;
  goods_left: boolean; so_no: string | null; project_id: string | null; pj_no: string | null; pj_name: string | null; inst_n: number | null; inst_label: string | null;
  inst_pct: string | null; gross_amount: string | null; deposit_deduct: string; deposit_type: 'guarantee' | 'advance' | null; text_lines: { name: string; amount: string }[];
  attn: string; note: string; salesperson_id: string | null; sp_name: string | null; sp_phone: string | null;
}

export async function getInvoice(tx: Tx, _deps: Deps, ctx: Ctx, no: string): Promise<SalesInvoice> {
  const r = await tx.query<InvRow>(
    `select x.id, x.no, x.customer_name, si.kind, si.source, si.term, si.due_date::text, x.ar_balance::text, si.goods_left, so.no so_no, si.project_id, pj.no pj_no, pj.name pj_name,
            ins.n inst_n, ins.label inst_label, ins.pct::text inst_pct, si.gross_amount::text, si.deposit_deduct::text, si.deposit_type, si.text_lines, si.attn, si.note,
            si.salesperson_id, sp.name sp_name, sp.phone sp_phone, ${partyCols}
       from docs x join sales_invoices si on si.doc_id = x.id left join customers c on c.id = x.customer_id left join sales_orders so on so.id = si.so_id
       left join sales_projects pj on pj.id = si.project_id left join sales_project_installments ins on ins.id = si.installment_id left join users sp on sp.id = si.salesperson_id
      where x.no = $1`,
    [no],
  );
  const x = r.rows[0];
  if (!x) throw E.notFound(`Invoice ${no} not found`);
  const doc = await getDoc(tx, ctx, no);
  const [dlv, later, bns, rcs, cns] = await inSeq([
    () => tx.query<{ no: string }>(`select dv.no from sales_invoice_deliveries sid join sales_deliveries dv on dv.id = sid.delivery_id where sid.invoice_doc_id = $1 order by dv.created_at`, [x.id]),
    () => tx.query<{ no: string; date: string; status: 'active' | 'void' }>(`select no, date::text, status from sales_deliveries where inv_doc_id = $1 order by created_at`, [x.id]),
    () => tx.query<{ no: string; date: string; status: 'active' | 'void' }>(`select distinct b.no, b.date::text, b.status, b.created_at from ar_billing_note_lines l join ar_billing_notes b on b.id = l.bn_id where l.invoice_doc_id = $1 order by b.created_at`, [x.id]),
    () => tx.query<{ no: string; date: string; status: 'active' | 'void'; settled: string; wht: string }>(
      `select r.no, r.date::text, r.status, l.settled::text, l.wht::text from ar_receipt_lines l join ar_receipts r on r.id = l.receipt_id where l.invoice_doc_id = $1 order by r.created_at`, [x.id]),
    () => tx.query<{ no: string; date: string; status: 'active' | 'void'; total: string; refund: string | null }>(`select no, date::text, status, total::text, refund from docs where ref_doc_id = $1 and type = 'CN' order by created_at`, [x.id]),
  ]);
  const undelivered: Record<string, string> = {};
  if (x.goods_left) {
    const u = await tx.query<{ id: string; rest: string }>(
      `select l.id, (l.qty - l.returned_qty - coalesce((select sum(dl.qty) from sales_delivery_lines dl join sales_deliveries dv on dv.id = dl.delivery_id where dl.inv_line_id = l.id and dv.status = 'active'), 0))::text rest
         from doc_lines l where l.doc_id = $1`, [x.id]);
    for (const row of u.rows) undelivered[row.id] = qty4(row.rest);
  }
  const live = <T extends { status: string }>(rows: T[]) => rows.filter((y) => y.status === 'active');
  return {
    doc, customer: partyOf(x, x.customer_name), kind: x.kind, source: x.source, term: x.term, dueDate: x.due_date, arBalance: doc.status === 'void' ? '0.00' : money(x.ar_balance),
    settled: money(sum(live(rcs.rows).map((y) => y.settled))), credited: money(sum(live(cns.rows).filter((y) => y.refund === 'credit').map((y) => y.total))),
    goodsLeft: x.goods_left, soNo: x.so_no, project: x.project_id ? { id: x.project_id, no: x.pj_no!, name: x.pj_name! } : null,
    installment: x.inst_n != null ? { n: x.inst_n, label: x.inst_label ?? '', pct: x.inst_pct! } : null,
    grossAmount: x.gross_amount, depositDeduct: money(x.deposit_deduct), depositType: x.deposit_type, textLines: x.text_lines, attn: x.attn, note: x.note,
    salesperson: userRef(x.salesperson_id, x.sp_name, x.sp_phone), deliveries: dlv.rows.map((y) => y.no), laterDeliveries: later.rows,
    billingNotes: bns.rows.map((y) => ({ no: y.no, date: y.date, status: y.status })),
    receipts: rcs.rows.map((y) => ({ no: y.no, date: y.date, status: y.status, settled: money(y.settled), wht: money(y.wht) })),
    creditNotes: cns.rows.map((y) => ({ no: y.no, date: y.date, status: y.status, total: money(y.total), refund: y.refund })),
    undelivered,
  };
}

export async function listInvoices(tx: Tx, deps: Deps, q: SalesPageQuery & { projectId?: string }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.customerId) {
    if (!isUuid(q.customerId)) throw E.validation('Unknown customer');
    params.push(q.customerId);
    where.push(`x.customer_id = $${params.length}`);
  }
  if (q.status === 'void') where.push(`x.status = 'void'`);
  else if (q.status === 'open') where.push(`x.status = 'active' and x.ar_balance > 0`);
  else if (q.status === 'paid') where.push(`x.status = 'active' and x.ar_balance = 0`);
  else if (q.status === 'goodsLeft') where.push(`x.status = 'active' and si.goods_left`);
  const today = deps.today();
  return pageNewest<{ id: string; no: string; date: string; customer_id: string | null; customer_name: string; total: string; ar_balance: string; kind: 'credit' | 'cash'; source: SalesInvoice['source']; due_date: string; status: 'active' | 'void'; pj_name: string | null; created_at: Date }, SalesInvoiceSummary>(
    tx,
    `x.id, x.no, x.date::text, x.customer_id, x.customer_name, x.total::text, x.ar_balance::text, si.kind, si.source, si.due_date::text, x.status, pj.name pj_name, x.created_at`,
    `docs x join sales_invoices si on si.doc_id = x.id left join sales_projects pj on pj.id = si.project_id`,
    where, params, q,
    (r) => ({
      id: r.id, no: r.no, date: r.date, customer: { id: r.customer_id, name: r.customer_name }, total: r.total, arBalance: r.status === 'void' ? '0.00' : r.ar_balance,
      kind: r.kind, source: r.source, dueDate: r.due_date, overdueDays: r.status === 'active' && d(r.ar_balance).gt(0) ? daysOverdue(r.due_date, today) : 0,
      status: r.status, projectName: r.pj_name,
    }),
  );
}

/** Credit notes issued against B2B invoices (returns with stock, price corrections, credit refunds reducing AR). */
export async function listCreditNotes(tx: Tx, q: SalesPageQuery) {
  const where = [`x.type = 'CN'`, `exists (select 1 from sales_invoices si where si.doc_id = x.ref_doc_id)`];
  const params: unknown[] = [];
  if (q.customerId) {
    if (!isUuid(q.customerId)) throw E.validation('Unknown customer');
    params.push(q.customerId);
    where.push(`x.customer_id = $${params.length}`);
  }
  return pageNewest<{ id: string; no: string; date: string; customer_id: string | null; customer_name: string; total: string; vat: string; ref_no: string | null; refund: string | null; reason: string | null; status: 'active' | 'void'; created_at: Date }, SalesCreditNoteSummary>(
    tx, `x.id, x.no, x.date::text, x.customer_id, x.customer_name, x.total::text, x.vat::text, x.ref_no, x.refund, x.reason, x.status, x.created_at`, `docs x`, where, params, q,
    (r) => ({ id: r.id, no: r.no, date: r.date, customer: { id: r.customer_id, name: r.customer_name }, total: r.total, vat: r.vat, refNo: r.ref_no, refund: r.refund, reason: r.reason, status: r.status }),
  );
}

/**
 * BR-22 for invoices voided through the core document void (POST /api/sales/docs/:no/void): receipts, billing notes and
 * later delivery orders go first; a deposit invoice is voided with its deposit; an INV that replaced an ABB is
 * corrected with a credit note (the sale's stock moves belong to the ABB).
 */
registerVoidGuard(async (tx, doc) => {
  if (doc.type !== 'INV') return [];
  const r = await tx.query<{ no: string }>(
    `select r.no from ar_receipt_lines l join ar_receipts r on r.id = l.receipt_id where l.invoice_doc_id = $1 and r.status = 'active'
     union select b.no from ar_billing_note_lines l join ar_billing_notes b on b.id = l.bn_id where l.invoice_doc_id = $1 and b.status = 'active'
     union select no from sales_deliveries where inv_doc_id = $1 and status = 'active'
     union select dp.no || ' (มัดจำ: ยกเลิกที่ใบรับมัดจำ)' from sales_invoices si join sales_deposits dp on dp.id = si.deposit_id where si.doc_id = $1 and si.source = 'deposit' and dp.status <> 'void'
     union select x.ref_no || ' (ใบกำกับอย่างย่อเดิม: ทำใบลดหนี้แทนการยกเลิก)' from sales_invoices si join docs x on x.id = si.doc_id where si.doc_id = $1 and si.source = 'abb'`,
    [doc.id],
  );
  return r.rows.map((x) => x.no);
});

/** True when the caller may read invoices (sales docs or AR, read-only included). */
export const canReadSales = (ctx: Ctx) => !!can(ctx, 'sales.doc') || !!can(ctx, 'fin.ar') || !!can(ctx, 'pos.sell');
