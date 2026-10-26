/** POS sale, sales documents, void (M07, M08). */
import type { Tx } from '@erp/db';
import type { DocSummary, PageQuery, PosSaleReq, SalesDoc } from '@erp/contracts';
import {
  approverRoles, calcDoc, checkBelowCost, d, discountPct, exceedsCap, fmtTHB, lineDiscount, money, netUnitPricesExVat, qty4, sum, type DocLine as CoreLine,
} from '@erp/core';
import { verifyApproval } from '../lib/approval';
import { writeAudit, type AuditInput } from '../lib/audit';
import { can, requirePerm, type Ctx, type Deps } from '../lib/context';
import { nextDocNo } from '../lib/docno';
import { E, isUuid } from '../lib/errors';
import { decodeCursor, likeEscape, pageOf } from '../lib/paging';
import { applyOut, lockLots, planTakes, reverseOuts } from '../lib/stock';
import { loadProducts, requireWarehouse, unitOf } from './master';

export const SALE_TYPES = ['ABB', 'INV', 'RC'] as const;

interface DocRow {
  id: string; no: string; type: SalesDoc['type']; date: string; customer_id: string | null; customer_name: string; customer_phone: string | null;
  vat_mode: SalesDoc['vatMode']; warehouse_id: string | null; shift_id: string | null; gross: string; line_disc: string; bill_disc: string; base7: string;
  exempt: string; vat: string; total: string; ar_balance: string; payments: SalesDoc['payments']; status: SalesDoc['status']; void_by_name: string | null;
  void_at: Date | null; void_reason: string | null; created_by_name: string; ref_no: string | null; ref_doc_id: string | null; created_at: Date;
}
interface LineRow {
  id: string; product_id: string; name: string; unit_name: string; unit_factor: string; qty: string; base_qty: string; unit_price: string;
  discount: string; net: string; net_after_bill: string; vat: 'v7' | 'exempt'; returned_qty: string; cogs: string | null; src_line_id: string | null;
}

const DOC_SELECT = `select d.id, d.no, d.type, d.date, d.customer_id, d.customer_name, d.customer_phone, d.vat_mode, d.warehouse_id, d.shift_id,
  d.gross::text, d.line_disc::text, d.bill_disc::text, d.base7::text, d.exempt::text, d.vat::text, d.total::text, d.ar_balance::text, d.payments,
  d.status, vu.name as void_by_name, d.void_at, d.void_reason, cu.name as created_by_name, d.ref_no, d.ref_doc_id, d.created_at
  from docs d join users cu on cu.id = d.created_by left join users vu on vu.id = d.void_by`;

export async function getDocRow(tx: Tx, no: string, opts: { forUpdate?: boolean } = {}): Promise<DocRow> {
  if (opts.forUpdate) await tx.query(`select id from docs where no = $1 for update`, [no]);
  const r = await tx.query<DocRow>(`${DOC_SELECT} where d.no = $1`, [no]);
  if (!r.rows[0]) throw E.notFound(`Document ${no} not found`);
  return r.rows[0];
}

export async function getLines(tx: Tx, docId: string): Promise<LineRow[]> {
  const r = await tx.query<LineRow>(
    `select id, product_id, name, unit_name, unit_factor::text, qty::text, base_qty::text, unit_price::text, discount::text, net::text,
            net_after_bill::text, vat, returned_qty::text, cogs::text, src_line_id
       from doc_lines where doc_id = $1 order by line_no`,
    [docId],
  );
  return r.rows;
}

export async function getDoc(tx: Tx, ctx: Ctx, no: string): Promise<SalesDoc> {
  const row = await getDocRow(tx, no);
  const lines = await getLines(tx, row.id);
  const seeCost = can(ctx, 'data.cost') === 1;
  return {
    id: row.id, no: row.no, type: row.type, date: row.date,
    customer: { id: row.customer_id, name: row.customer_name, phone: row.customer_phone },
    vatMode: row.vat_mode,
    lines: lines.map((l) => ({
      id: l.id, productId: l.product_id, name: l.name, unitName: l.unit_name, qty: qty4(l.qty), unitPrice: qty4(l.unit_price), discount: money(l.discount),
      net: money(l.net), returnedQty: qty4(l.returned_qty), cogs: seeCost && l.cogs != null ? money(l.cogs) : null,
    })),
    totals: { gross: row.gross, lineDisc: row.line_disc, billDisc: row.bill_disc, base7: row.base7, exempt: row.exempt, vat: row.vat, total: row.total },
    payments: row.payments, status: row.status,
    voided: row.status === 'void' ? { by: row.void_by_name ?? '', at: row.void_at!.toISOString(), reason: row.void_reason ?? '' } : null,
    createdBy: row.created_by_name, ref: row.ref_no,
  };
}

/** Lower-cased haystack for the returns bill picker (REQ-M08-06): bill no, customer, member, products, amount. */
export function searchText(parts: { no: string; customer?: { name: string; code?: string | null; phone?: string | null; taxId?: string | null } | null; memberId?: string | null; products: { name: string; sku: string }[]; total: string }): string {
  const t = d(parts.total);
  return [
    parts.no, parts.customer?.name, parts.customer?.code, parts.customer?.phone, parts.customer?.phone?.replace(/\D/g, ''), parts.customer?.taxId, parts.memberId,
    ...parts.products.flatMap((p) => [p.name, p.sku]),
    money(t), fmtTHB(t), t.toDecimalPlaces(0).toFixed(0),
  ].filter(Boolean).join(' ').toLowerCase();
}

/** BR-20: the caller's own open shift. */
export async function requireOwnOpenShift(tx: Tx, ctx: Ctx, shiftId?: string): Promise<{ id: string; no: string; device_id: string }> {
  const r = shiftId
    ? isUuid(shiftId)
      ? await tx.query<{ id: string; no: string; device_id: string; user_id: string; closed_at: Date | null }>(`select id, no, device_id, user_id, closed_at from shifts where id = $1`, [shiftId])
      : { rows: [] }
    : await tx.query<{ id: string; no: string; device_id: string; user_id: string; closed_at: Date | null }>(`select id, no, device_id, user_id, closed_at from shifts where user_id = $1 and closed_at is null`, [ctx.userId]);
  const s = r.rows[0];
  if (!s || s.closed_at || s.user_id !== ctx.userId) throw E.shiftRequired();
  return s;
}

export interface SaleResult { doc: SalesDoc; replay: boolean }

export async function posSale(tx: Tx, deps: Deps, ctx: Ctx, req: PosSaleReq): Promise<SaleResult> {
  requirePerm(ctx, 'pos.sell');
  // Idempotency: a retried request returns the original bill, never a second one.
  const prior = await tx.query<{ no: string }>(`select no from docs where idempotency_key = $1`, [req.idempotencyKey]);
  if (prior.rows[0]) return { doc: await getDoc(tx, ctx, prior.rows[0].no), replay: true };

  const shift = await requireOwnOpenShift(tx, ctx, req.shiftId);
  const wh = await requireWarehouse(tx, req.warehouseId, { pos: true });
  const shop = (await tx.query<{ vat_registered: boolean }>(`select vat_registered from tenants where id = $1`, [ctx.tenantId])).rows[0]!;
  if (shop.vat_registered === (req.docKind === 'receipt')) {
    throw E.validation(shop.vat_registered ? 'VAT-registered shop issues abb or full tax invoices' : 'Non-VAT shop issues receipts only');
  }
  const type = req.docKind === 'abb' ? 'ABB' : req.docKind === 'full' ? 'INV' : 'RC';
  const vatMode = shop.vat_registered ? 'inc' : 'none';

  let customer: { id: string; name: string; code: string; phone: string | null; tax_id: string | null } | null = null;
  if (req.customerId) {
    if (!isUuid(req.customerId)) throw E.validation('Unknown customer');
    customer = (await tx.query(`select id, name, code, phone, tax_id from customers where id = $1`, [req.customerId])).rows[0] ?? null;
    if (!customer) throw E.validation('Unknown customer');
  }
  if (type === 'INV' && !customer?.tax_id) throw E.validation('A full tax invoice needs a customer with a tax ID');

  const products = await loadProducts(tx, req.lines.map((l) => l.productId));
  const audits: AuditInput[] = [];
  let priceChanged = false;
  const lines = req.lines.map((l, i) => {
    const p = products.get(l.productId)!;
    if (!p.active) throw E.validation(`Product ${p.sku} is inactive`);
    const u = unitOf(p, l.unitIdx);
    if (!d(l.qty).gt(0)) throw E.validation(`Line ${i + 1}: qty must be > 0`);
    const list = u.price != null ? d(u.price) : d(p.price).times(d(u.factor));
    if (!d(l.unitPrice).eq(list)) priceChanged = true;
    const core: CoreLine & { baseQty: string } = { qty: l.qty, unitPrice: l.unitPrice, discount: l.discount ?? null, vat: p.vat, baseQty: qty4(d(l.qty).times(d(u.factor))) };
    return { req: l, p, u, core };
  });
  const totals = calcDoc(lines.map((l) => l.core), vatMode, req.billDiscount);

  // Discount over the role cap (cashier 0, OQ-10) or a changed unit price needs a manager / owner PIN.
  const cap = can(ctx, 'pos.discCap');
  const pct = discountPct(totals.gross, d(totals.lineDisc).plus(d(totals.billDisc)));
  const overCap = exceedsCap(pct, typeof cap === 'number' ? cap : 0);
  const priceNeedsApproval = priceChanged && can(ctx, 'pos.price') !== 1;
  if (overCap || priceNeedsApproval) {
    const need = { pct, cap, priceChanged: priceNeedsApproval, need: 'discountApproval' };
    if (!req.discountApproval) throw E.forbidden(overCap ? `Discount ${pct}% is over your cap of ${cap}%` : 'Changing the unit price needs approval', need);
    const a = await verifyApproval(tx, req.discountApproval, approverRoles('pos.discCap'));
    if (!a.ok) throw E.forbidden('Discount approval rejected', { ...need, approvalError: a.reason });
    audits.push({ action: 'approve', object: 'discount', detail: `ส่วนลด ${pct}% (สิทธิ์ ${cap}%)${priceNeedsApproval ? ' · เปลี่ยนราคา' : ''} · อนุมัติโดย ${a.approver.name}` });
  }

  const paid = sum(req.payments.map((p) => p.amount));
  if (!paid.eq(d(totals.total))) throw E.validation(`Payments ${money(paid)} must equal the bill total ${totals.total}`, { total: totals.total, paid: money(paid) });
  if (req.payments.some((p) => !d(p.amount).gt(0))) throw E.validation('Payment amounts must be > 0');

  // Number first: it is row-locked until COMMIT and rolled back with everything else on failure (BR-04).
  const date = deps.today();
  const no = await nextDocNo(tx, ctx.tenantId, type, date, shift.device_id);

  // BR-07: lock the lots, plan FIFO per line; shortage -> 409 before anything is written.
  const stockLines = lines.filter((l) => l.p.kind === 'stock');
  const lots = await lockLots(tx, wh.id, stockLines.map((l) => l.p.id));
  const plans = planTakes(lots, wh.id, stockLines.map((l) => ({ productId: l.p.id, qty: l.core.baseQty })));
  const planOf = new Map(stockLines.map((l, i) => [l, plans[i]!]));

  // BR-16: net unit price ex VAT per base unit vs the FIFO cost of the lots this line consumes.
  const sell = netUnitPricesExVat(lines.map((l) => l.core), vatMode, totals.billDisc);
  const unitCosts = lines.map((l) => {
    const pl = planOf.get(l);
    return pl && d(pl.qty).gt(0) ? qty4(d(pl.cogs).div(d(pl.qty))) : null;
  });
  const below = checkBelowCost(lines.map((_, i) => ({ netUnitExVat: sell[i] ?? '0', unitCost: unitCosts[i] })));
  if (below.length) {
    const seeCost = can(ctx, 'data.cost') === 1;
    const detail = below.map((i) => ({ productId: lines[i]!.p.id, name: lines[i]!.p.name, ...(seeCost ? { sell: money(sell[i]!), cost: money(unitCosts[i]!) } : {}) }));
    const text = below.map((i) => `${lines[i]!.p.name} (ขาย ${money(sell[i]!)} < ทุน ${money(unitCosts[i]!)})`).join(', ');
    if (ctx.role === 'owner') {
      audits.push({ action: 'approve', object: 'below-cost', detail: `ขายต่ำกว่าทุน ${below.length} รายการ: ${text} · เจ้าของร้าน (ยืนยันเอง)` });
    } else if (req.belowCostApproval) {
      const a = await verifyApproval(tx, req.belowCostApproval, approverRoles('sales.belowCost'));
      if (!a.ok) throw E.belowCost('Below-cost sale needs the owner\'s PIN', { lines: detail, approvalError: a.reason });
      audits.push({ action: 'approve', object: 'below-cost', detail: `ขายต่ำกว่าทุน ${below.length} รายการ: ${text} · อนุมัติโดย ${a.approver.name}` });
    } else {
      throw E.belowCost(`${below.length} line(s) below cost`, { lines: detail });
    }
  }

  const docId = (await tx.query<{ id: string }>(
    `insert into docs (tenant_id, no, type, date, customer_id, customer_name, customer_phone, vat_mode, warehouse_id, shift_id, device_id,
       gross, line_disc, bill_disc, base7, exempt, vat, total, payments, created_by, idempotency_key, search_text)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) returning id`,
    [ctx.tenantId, no, type, date, customer?.id ?? null, customer?.name ?? 'ลูกค้าทั่วไป', customer?.phone ?? null, vatMode, wh.id, shift.id, shift.device_id,
      totals.gross, totals.lineDisc, totals.billDisc, totals.base7, totals.exempt, totals.vat, totals.total,
      JSON.stringify(req.payments.map((p) => ({ method: p.method, amount: money(p.amount) }))), ctx.userId, req.idempotencyKey,
      searchText({ no, customer: customer && { name: customer.name, code: customer.code, phone: customer.phone, taxId: customer.tax_id }, products: lines.map((l) => l.p), total: totals.total })],
  )).rows[0]!.id;

  for (const [i, l] of lines.entries()) {
    const pl = planOf.get(l);
    const lineId = (await tx.query<{ id: string }>(
      `insert into doc_lines (tenant_id, doc_id, line_no, product_id, name, unit_name, unit_factor, qty, base_qty, unit_price, discount, net, net_after_bill, vat, cogs)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [ctx.tenantId, docId, i + 1, l.p.id, l.p.name, l.u.name, l.u.factor, l.req.qty, l.core.baseQty, l.req.unitPrice,
        money(lineDiscount(l.core)),
        totals.lines[i]!.net, totals.lines[i]!.after, l.p.vat, pl ? pl.cogs : null],
    )).rows[0]!.id;
    if (pl) await applyOut(tx, ctx, wh.id, pl, { docType: type, docNo: no, docId, docLineId: lineId, note: 'ขายหน้าร้าน' });
  }

  await deps.hooks.beforeCommit?.('posSale', tx);
  audits.push({ action: 'create', object: type, ref: no, detail: `฿${fmtTHB(totals.total)} · ${lines.length} รายการ · ${req.payments.map((p) => p.method).join(' + ')} · กะ ${shift.no}` });
  await writeAudit(tx, ctx, audits);
  return { doc: await getDoc(tx, ctx, no), replay: false };
}

export async function listDocs(tx: Tx, q: PageQuery & { type?: string }) {
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.type) {
    params.push(q.type);
    where.push(`d.type = $${params.length}`);
  }
  for (const w of (q.q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(d.search_text like $${params.length} or lower(d.no) like $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(d.created_at, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  return summaries(tx, `${where.length ? 'where ' + where.join(' and ') : ''}`, params, q.limit);
}

/** DocSummary page; `where` may reference docs as d. Ordered newest first. */
export async function summaries(tx: Tx, where: string, params: unknown[], limit: number) {
  const r = await tx.query<{ id: string; no: string; type: DocSummary['type']; date: string; customer_id: string | null; customer_name: string; customer_phone: string | null; status: DocSummary['status']; total: string; created_at: Date; preview: string | null }>(
    `select d.id, d.no, d.type, d.date, d.customer_id, d.customer_name, d.customer_phone, d.status, d.total::text, d.created_at,
            (select string_agg(split_part(l.name, ' ', 1) || ' ×' || trim(trailing '.' from trim(trailing '0' from l.qty::text)), ', ' order by l.line_no)
               from (select * from doc_lines x where x.doc_id = d.id order by x.line_no limit 3) l) as preview
       from docs d ${where} order by d.created_at desc, d.id desc limit $${params.length}`,
    params,
  );
  return pageOf(r.rows, limit, (x) => [x.created_at.toISOString(), x.id], (x): DocSummary => ({
    id: x.id, no: x.no, type: x.type, date: x.date, customer: { id: x.customer_id, name: x.customer_name, phone: x.customer_phone },
    status: x.status, total: x.total, itemsPreview: x.preview ?? '',
  }));
}

/** BR-03/BR-22: void = status flag + stock back into the original lots; the number is kept. */
export async function voidDoc(tx: Tx, deps: Deps, ctx: Ctx, no: string, body: { reason: string; approverUserId?: string; pin?: string }): Promise<SalesDoc> {
  const p = can(ctx, 'sales.voidDoc');
  let approvedBy = '';
  if (p === 'apv') {
    if (!body.approverUserId || !body.pin) throw E.forbidden('Voiding needs a manager or owner PIN', { need: 'approval' });
    const a = await verifyApproval(tx, { approverUserId: body.approverUserId, pin: body.pin }, approverRoles('sales.voidDoc'));
    if (!a.ok) throw E.forbidden('Void approval rejected', { approvalError: a.reason });
    approvedBy = ` · อนุมัติโดย ${a.approver.name}`;
  } else if (p !== 1) {
    throw E.forbidden('Permission sales.voidDoc is required');
  }
  const doc = await getDocRow(tx, no, { forUpdate: true });
  if (doc.status === 'void') throw E.conflict(`${no} is already void`);
  if (doc.type === 'CN') throw E.conflict('Credit notes cannot be voided');
  const downstream = await tx.query<{ no: string }>(`select no from docs where ref_doc_id = $1 and status = 'active' order by created_at`, [doc.id]);
  const returned = await tx.query(`select 1 from doc_lines where doc_id = $1 and returned_qty > 0 limit 1`, [doc.id]);
  if (downstream.rowCount || returned.rowCount) {
    throw E.downstreamFirst(`${no} has downstream documents; handle them first`, { docs: downstream.rows.map((r) => r.no) });
  }
  await reverseOuts(tx, ctx, doc.id, { docType: doc.type, docNo: doc.no, docId: doc.id, note: `คืนสต็อก · ยกเลิก ${doc.no}` });
  await tx.query(`update docs set status = 'void', void_by = $2, void_at = now(), void_reason = $3 where id = $1`, [doc.id, ctx.userId, body.reason]);
  await deps.hooks.beforeCommit?.('voidDoc', tx);
  await writeAudit(tx, ctx, [{ action: 'void', object: doc.type, ref: doc.no, detail: `${body.reason} · ฿${fmtTHB(doc.total)}${approvedBy}` }]);
  return getDoc(tx, ctx, no);
}
