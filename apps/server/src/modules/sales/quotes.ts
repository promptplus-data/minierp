/**
 * Quotations (REQ-M08-01/08/09): no stock, free-text lines, revisions, statuses, BR-22 void.
 * BR-05 price per line (source stored), price below the list / discount over the cap needs a manager PIN, BR-16
 * below cost needs the owner (same gates as the sales order; free-text lines have no cost and are not checked).
 */
import type { Tx } from '@erp/db';
import type { SalesPageQuery, SalesQuote, SalesQuoteReq, SalesQuoteStatus, SalesQuoteSummary } from '@erp/contracts';
import { addDays, d, fmtTHB } from '@erp/core';
import { writeAudit } from '../../lib/audit';
import { can, requirePerm, type Ctx, type Deps } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E, isUuid } from '../../lib/errors';
import {
  authorizeVoid, belowCostGate, buildLines, discAmt, giveawayAudits, haystack, lineJson, loadCustomer, pageNewest, partyCols, partyOf, peekUnitCosts, priceGate, profitOf, requireUser,
  resolveVatMode, storedLines, TOTAL_COLS, totalsJson, totalsOf, userRef, voidedJson, type BuiltLine, type LineRowBase, type PartyCols, type VoidBody,
} from './common';
import { makePricer } from './pricing';
import type { AuditInput } from '../../lib/audit';
import { posFromSource } from '../purchasing/po';

interface QuoteRow extends PartyCols {
  id: string; no: string; date: string; valid_until: string; customer_id: string; attn: string; vat_mode: SalesQuote['vatMode']; term: SalesQuote['term'];
  salesperson_id: string | null; sp_name: string | null; sp_phone: string | null; note: string; bill_disc: string; gross: string; line_disc: string;
  base7: string; exempt: string; vat: string; total: string; status: 'draft' | 'sent' | 'accepted' | 'lost' | 'void'; revision: number;
  created_by_name: string; void_by_name: string | null; void_at: Date | null; void_reason: string | null;
  below_cost_approval: { by: string; detail: string } | null; price_approval: { name: string; detail: string } | null;
}

const SELECT = `select x.id, x.no, x.date::text, x.valid_until::text, x.customer_id, x.attn, x.vat_mode, x.term, x.salesperson_id, sp.name sp_name, sp.phone sp_phone,
  x.note, x.bill_disc::text, ${TOTAL_COLS('x')}, x.status, x.revision, cu.name created_by_name, vu.name void_by_name, x.void_at, x.void_reason,
  x.below_cost_approval, x.price_approval, ${partyCols}
  from sales_quotes x join customers c on c.id = x.customer_id join users cu on cu.id = x.created_by
  left join users sp on sp.id = x.salesperson_id left join users vu on vu.id = x.void_by`;

/** Stored status plus expiry: a draft / sent quotation past its validity is 'expired'. */
export const effectiveStatus = (status: QuoteRow['status'], validUntil: string, today: string): SalesQuoteStatus =>
  (status === 'draft' || status === 'sent') && validUntil < today ? 'expired' : status;

export async function quoteRow(tx: Tx, no: string, forUpdate = false): Promise<QuoteRow> {
  if (forUpdate) await tx.query(`select id from sales_quotes where no = $1 for update`, [no]);
  const r = await tx.query<QuoteRow>(`${SELECT} where x.no = $1`, [no]);
  if (!r.rows[0]) throw E.notFound(`Quotation ${no} not found`);
  return r.rows[0];
}

export interface QuoteLineRow extends LineRowBase { unit_factor: string; product_kind: string | null }
export async function quoteLines(tx: Tx, quoteId: string, revision: number): Promise<QuoteLineRow[]> {
  const r = await tx.query<QuoteLineRow>(
    `select l.id, l.line_no, l.product_id, l.unit_idx, p.sku, l.name, l.unit_name, l.unit_factor::text, l.qty::text, l.unit_price::text, l.discount,
            l.disc_amt::text, l.net::text, l.vat, p.kind product_kind, l.list_price::text, l.price_source, l.price_ref, l.free
       from sales_quote_lines l left join products p on p.id = l.product_id where l.quote_id = $1 and l.revision = $2 order by l.line_no`,
    [quoteId, revision],
  );
  return r.rows;
}

async function activeOrders(tx: Tx, quoteId: string) {
  const r = await tx.query<{ no: string; date: string; status: 'active' | 'void' }>(`select no, date::text, status from sales_orders where quote_id = $1 order by created_at`, [quoteId]);
  return r.rows;
}

export async function getQuote(tx: Tx, deps: Deps, ctx: Ctx, no: string): Promise<SalesQuote> {
  const q = await quoteRow(tx, no);
  const lines = await quoteLines(tx, q.id, q.revision);
  const orders = await activeOrders(tx, q.id);
  const status = effectiveStatus(q.status, q.valid_until, deps.today());
  // cost / profit for data.cost users: the FIFO cost the lines would take now (all warehouses)
  let profit: ReturnType<typeof profitOf> | null = null;
  if (can(ctx, 'data.cost') === 1) {
    const built = await storedLines(tx, lines);
    profit = profitOf(built, q.vat_mode, q.bill_disc, await peekUnitCosts(tx, null, built));
  }
  return {
    id: q.id, no: q.no, date: q.date, validUntil: q.valid_until, customer: partyOf(q), attn: q.attn, vatMode: q.vat_mode, term: q.term,
    salesperson: userRef(q.salesperson_id, q.sp_name, q.sp_phone), note: q.note, billDiscount: q.bill_disc,
    lines: lines.map((l, i) => ({ ...lineJson(l), ...(profit?.lines[i] ?? {}) })), totals: totalsJson(q),
    status, revision: q.revision, orders, editable: q.status !== 'void' && !orders.some((o) => o.status === 'active'),
    belowCostApproval: q.below_cost_approval ? { by: q.below_cost_approval.by, detail: q.below_cost_approval.detail } : null,
    priceApproval: q.price_approval ? { by: q.price_approval.name, detail: q.price_approval.detail } : null,
    profit: profit?.total ?? null,
    createdBy: q.created_by_name, voided: voidedJson(q), purchaseOrders: await posFromSource(tx, q.no),
  };
}

async function insertLines(tx: Tx, ctx: Ctx, quoteId: string, revision: number, lines: BuiltLine[], nets: string[]): Promise<void> {
  for (const [i, l] of lines.entries()) {
    await tx.query(
      `insert into sales_quote_lines (tenant_id, quote_id, revision, line_no, product_id, unit_idx, name, unit_name, unit_factor, qty, unit_price, discount, disc_amt, net, vat,
         list_price, price_source, price_ref, free)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [ctx.tenantId, quoteId, revision, i + 1, l.product?.id ?? null, l.product ? l.unitIdx : null, l.name, l.unitName, l.unitFactor, l.qty, l.unitPrice,
        l.discount ? JSON.stringify(l.discount) : null, discAmt(l), nets[i], l.vat, l.listPrice ?? null, l.priceSource ?? null, l.priceRef ?? null, l.giveaway === true],
    );
  }
}

async function snapshot(tx: Tx, ctx: Ctx, quoteId: string, revision: number, data: unknown): Promise<void> {
  await tx.query(`insert into sales_quote_revisions (tenant_id, quote_id, revision, snapshot, created_by) values ($1,$2,$3,$4,$5)`,
    [ctx.tenantId, quoteId, revision, JSON.stringify(data), ctx.userId]);
}

async function prepare(tx: Tx, deps: Deps, ctx: Ctx, req: SalesQuoteReq) {
  const customer = await loadCustomer(tx, req.customerId);
  const vatMode = await resolveVatMode(tx, ctx, req.vatMode);
  const lines = await buildLines(tx, req.lines, { allowFree: true });
  const totals = totalsOf(lines, vatMode, req.billDiscount);
  const salesperson = await requireUser(tx, req.salespersonId ?? ctx.userId);
  const date = req.date ?? deps.today();
  const valid = (await tx.query<{ quote_valid_days: number }>(`select quote_valid_days from sales_settings`)).rows[0]?.quote_valid_days ?? 15;
  const validUntil = req.validUntil ?? addDays(date, valid);
  if (validUntil < date) throw E.validation('validUntil must not be before the quotation date');
  const term = req.term ?? customer.term;
  // BR-05: the price each product line would get (quotation order: no quotation step)
  const pricer = await makePricer(tx, { customerId: customer.id, date, vatMode, doc: 'quote' });
  for (const l of lines) {
    if (!l.product) { l.priceSource = 'manual'; continue; }
    if (l.giveaway) continue; // ของแถม: price 0, no BR-05 price
    const r = await pricer(l.product, l.unitIdx!, l.qty);
    Object.assign(l, { listPrice: r.unitPrice, priceSource: r.source, priceRef: r.ref });
  }
  const what = `ใบเสนอราคา ${customer.name}`;
  const pg = await priceGate(tx, deps, ctx, lines, totals, req.priceApproval, what);
  const costs = await peekUnitCosts(tx, null, lines);
  const bc = await belowCostGate(tx, deps, ctx, lines, vatMode, totals.billDisc, costs, req.belowCostApproval, what);
  const audits: AuditInput[] = [...pg.audit, ...(bc.audit ? [bc.audit] : []),
    ...giveawayAudits(lines, 'QT', lines.map((l, i) => (costs[i] != null ? d(costs[i]!).times(d(l.baseQty)).toFixed(2) : null)))];
  return { customer, vatMode, lines, totals, salesperson, date, validUntil, term, priceApproval: pg.approval, belowCostApproval: bc.approval, audits };
}

export async function createQuote(tx: Tx, deps: Deps, ctx: Ctx, req: SalesQuoteReq): Promise<SalesQuote> {
  requirePerm(ctx, 'sales.doc');
  const x = await prepare(tx, deps, ctx, req);
  const no = await nextDocNo(tx, ctx.tenantId, 'QT', x.date);
  const id = (await tx.query<{ id: string }>(
    `insert into sales_quotes (tenant_id, no, date, valid_until, customer_id, attn, vat_mode, term, salesperson_id, note, bill_disc, gross, line_disc, base7, exempt, vat, total, status, created_by, search_text,
       price_approval, below_cost_approval)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) returning id`,
    [ctx.tenantId, no, x.date, x.validUntil, x.customer.id, req.attn, x.vatMode, JSON.stringify(x.term), x.salesperson, req.note, x.totals.billDisc,
      x.totals.gross, x.totals.lineDisc, x.totals.base7, x.totals.exempt, x.totals.vat, x.totals.total, req.status, ctx.userId,
      haystack(no, x.customer, x.lines.map((l) => `${l.name} ${l.product?.sku ?? ''}`), x.totals.total, [req.attn, req.note]),
      x.priceApproval ? JSON.stringify(x.priceApproval) : null, x.belowCostApproval ? JSON.stringify(x.belowCostApproval) : null],
  )).rows[0]!.id;
  await insertLines(tx, ctx, id, 1, x.lines, x.totals.lines.map((l) => l.net));
  await snapshot(tx, ctx, id, 1, { req, totals: x.totals });
  const free = x.lines.filter((l) => !l.product).length;
  await writeAudit(tx, ctx, [...x.audits.map((a) => ({ ...a, ref: no })), { action: 'create', object: 'QT', ref: no, detail: `${x.customer.name} · ฿${fmtTHB(x.totals.total)} · ${x.lines.length} รายการ${free ? ` (นอกระบบ ${free})` : ''} · ยืนราคาถึง ${x.validUntil}` }]);
  return getQuote(tx, deps, ctx, no);
}

/** REQ-M08-01: editable until converted into a sales order; every save is a new revision. */
export async function updateQuote(tx: Tx, deps: Deps, ctx: Ctx, no: string, req: SalesQuoteReq): Promise<SalesQuote> {
  requirePerm(ctx, 'sales.doc');
  const q = await quoteRow(tx, no, true);
  if (q.status === 'void') throw E.conflict(`${no} is void`);
  if ((await activeOrders(tx, q.id)).some((o) => o.status === 'active')) throw E.conflict(`${no} is already converted into a sales order and can no longer be edited`);
  const x = await prepare(tx, deps, ctx, { ...req, date: req.date ?? q.date });
  const rev = q.revision + 1;
  await tx.query(
    `update sales_quotes set date = $2, valid_until = $3, customer_id = $4, attn = $5, vat_mode = $6, term = $7, salesperson_id = $8, note = $9, bill_disc = $10,
       gross = $11, line_disc = $12, base7 = $13, exempt = $14, vat = $15, total = $16, revision = $17, status = case when status in ('accepted','lost') then status else $18 end,
       updated_at = now(), search_text = $19, price_approval = $20, below_cost_approval = $21 where id = $1`,
    [q.id, x.date, x.validUntil, x.customer.id, req.attn, x.vatMode, JSON.stringify(x.term), x.salesperson, req.note, x.totals.billDisc, x.totals.gross,
      x.totals.lineDisc, x.totals.base7, x.totals.exempt, x.totals.vat, x.totals.total, rev, req.status,
      haystack(no, x.customer, x.lines.map((l) => `${l.name} ${l.product?.sku ?? ''}`), x.totals.total, [req.attn, req.note]),
      x.priceApproval ? JSON.stringify(x.priceApproval) : null, x.belowCostApproval ? JSON.stringify(x.belowCostApproval) : null],
  );
  await insertLines(tx, ctx, q.id, rev, x.lines, x.totals.lines.map((l) => l.net));
  await snapshot(tx, ctx, q.id, rev, { req, totals: x.totals });
  await writeAudit(tx, ctx, [...x.audits.map((a) => ({ ...a, ref: no })), { action: 'update', object: 'QT', ref: no, detail: `แก้ไขครั้งที่ ${rev - 1} · ฿${fmtTHB(q.total)} → ฿${fmtTHB(x.totals.total)}` }]);
  return getQuote(tx, deps, ctx, no);
}

const STATUS_TH: Record<string, string> = { draft: 'ร่าง', sent: 'ส่งแล้ว', accepted: 'ลูกค้ายอมรับ', lost: 'ไม่ได้งาน', expired: 'หมดอายุ', void: 'ยกเลิก' };

export async function setQuoteStatus(tx: Tx, deps: Deps, ctx: Ctx, no: string, status: 'draft' | 'sent' | 'accepted' | 'lost'): Promise<SalesQuote> {
  requirePerm(ctx, 'sales.doc');
  const q = await quoteRow(tx, no, true);
  if (q.status === 'void') throw E.conflict(`${no} is void`);
  if ((await activeOrders(tx, q.id)).some((o) => o.status === 'active') && status !== 'accepted') throw E.conflict(`${no} is converted into a sales order`);
  if ((status === 'sent' || status === 'accepted') && q.valid_until < deps.today()) throw E.conflict(`${no} expired on ${q.valid_until}; extend the validity first`);
  await tx.query(`update sales_quotes set status = $2, updated_at = now() where id = $1`, [q.id, status]);
  await writeAudit(tx, ctx, [{ action: 'update', object: 'QT', ref: no, detail: `สถานะ ${STATUS_TH[q.status]} → ${STATUS_TH[status]}` }]);
  return getQuote(tx, deps, ctx, no);
}

/** BR-22: an active sales order made from the quotation must be voided first. */
export async function voidQuote(tx: Tx, deps: Deps, ctx: Ctx, no: string, body: VoidBody): Promise<SalesQuote> {
  const approvedBy = await authorizeVoid(tx, deps, ctx, body, no);
  const q = await quoteRow(tx, no, true);
  if (q.status === 'void') throw E.conflict(`${no} is already void`);
  const live = (await activeOrders(tx, q.id)).filter((o) => o.status === 'active');
  if (live.length) throw E.downstreamFirst(`${no} has sales orders; void them first`, { docs: live.map((o) => o.no) });
  await tx.query(`update sales_quotes set status = 'void', void_by = $2, void_at = now(), void_reason = $3 where id = $1`, [q.id, ctx.userId, body.reason]);
  await writeAudit(tx, ctx, [{ action: 'void', object: 'QT', ref: no, detail: `${body.reason} · ฿${fmtTHB(q.total)}${approvedBy}` }]);
  return getQuote(tx, deps, ctx, no);
}

export async function listQuotes(tx: Tx, deps: Deps, q: SalesPageQuery) {
  const where: string[] = [];
  const params: unknown[] = [];
  const today = deps.today();
  if (q.customerId) {
    if (!isUuid(q.customerId)) throw E.validation('Unknown customer');
    params.push(q.customerId);
    where.push(`x.customer_id = $${params.length}`);
  }
  if (q.status === 'expired') {
    params.push(today);
    where.push(`x.status in ('draft','sent') and x.valid_until < $${params.length}::date`);
  } else if (q.status === 'open') {
    params.push(today);
    where.push(`x.status in ('draft','sent') and x.valid_until >= $${params.length}::date`);
  } else if (q.status) {
    params.push(q.status);
    where.push(`x.status = $${params.length}`);
  }
  return pageNewest<QuoteRow & { created_at: Date; free_lines: number }, SalesQuoteSummary>(
    tx,
    `x.id, x.no, x.date::text, x.valid_until::text, x.customer_id, c.name c_name, x.total::text, x.status, x.revision, x.created_at, cu.name created_by_name,
     (select count(*)::int from sales_quote_lines l where l.quote_id = x.id and l.revision = x.revision and l.product_id is null) free_lines`,
    `sales_quotes x join customers c on c.id = x.customer_id join users cu on cu.id = x.created_by`,
    where, params, q,
    (r) => ({
      id: r.id, no: r.no, date: r.date, validUntil: r.valid_until, customer: { id: r.customer_id, name: r.c_name ?? '' }, total: r.total,
      status: effectiveStatus(r.status, r.valid_until, today), revision: r.revision, freeLines: r.free_lines, createdBy: r.created_by_name,
    }),
  );
}
