/** Sales orders (REQ-M08-02/03/10): direct or from a quotation, BR-08 credit approval, BR-16 below cost, projects (BR-23). */
import type { Tx } from '@erp/db';
import type { SalesOrder, SalesOrderReq, SalesOrderSummary, SalesPageQuery } from '@erp/contracts';
import { d, fmtTHB, money, qty4, sum } from '@erp/core';
import { writeAudit, type AuditInput } from '../../lib/audit';
import { can, requirePerm, type Ctx, type Deps } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E, isUuid } from '../../lib/errors';
import { requireWarehouse } from '../../services/master';
import {
  authorizeVoid, belowCostGate, buildLines, creditGate, discAmt, haystack, lineJson, loadCustomer, pageNewest, partyCols, partyOf, peekUnitCosts, priceGate, profitOf,
  requireUser, resolveVatMode, storedLines, TOTAL_COLS, totalsJson, totalsOf, userRef, voidedJson, type LineRowBase, type PartyCols, type VoidBody,
} from './common';
import { makePricer } from './pricing';
import { createProjectForOrder } from './projects';
import { scgfCartOf, scgfCouponValue, scgfDocCoupon, scgfRedeemOnDoc, scgfReturnOnVoid } from '../../services/scgfamily';
import { effectiveStatus, quoteLines, quoteRow } from './quotes';
import { posFromSource } from '../purchasing/po';

interface OrderRow extends PartyCols {
  id: string; no: string; date: string; customer_id: string; quote_no: string | null; project_id: string | null; pj_no: string | null; pj_name: string | null;
  pj_status: string | null; pj_main: string | null; warehouse_id: string | null; vat_mode: SalesOrder['vatMode']; term: SalesOrder['term']; salesperson_id: string | null;
  sp_name: string | null; sp_phone: string | null; ship_to: string; note: string; bill_disc: string; gross: string; line_disc: string; base7: string; exempt: string;
  vat: string; total: string; dlv_status: SalesOrder['dlvStatus']; status: 'active' | 'void'; credit_approval: { name: string; detail: string } | null;
  below_cost_approval: { by: string; detail: string } | null; created_by_name: string; void_by_name: string | null; void_at: Date | null; void_reason: string | null;
  price_approval: { name: string; detail: string } | null;
}

const SELECT = `select x.id, x.no, x.date::text, x.customer_id, q.no quote_no, x.project_id, pj.no pj_no, pj.name pj_name, pj.status pj_status, pj.main_so_id pj_main,
  x.warehouse_id, x.vat_mode, x.term, x.salesperson_id, sp.name sp_name, sp.phone sp_phone, x.ship_to, x.note, x.bill_disc::text, ${TOTAL_COLS('x')},
  x.dlv_status, x.status, x.credit_approval, x.below_cost_approval, x.price_approval, cu.name created_by_name, vu.name void_by_name, x.void_at, x.void_reason, ${partyCols}
  from sales_orders x join customers c on c.id = x.customer_id join users cu on cu.id = x.created_by left join sales_quotes q on q.id = x.quote_id
  left join sales_projects pj on pj.id = x.project_id left join users sp on sp.id = x.salesperson_id left join users vu on vu.id = x.void_by`;

export async function orderRow(tx: Tx, no: string, forUpdate = false): Promise<OrderRow> {
  if (forUpdate) await tx.query(`select id from sales_orders where no = $1 for update`, [no]);
  const r = await tx.query<OrderRow>(`${SELECT} where x.no = $1`, [no]);
  if (!r.rows[0]) throw E.notFound(`Sales order ${no} not found`);
  return r.rows[0];
}

export interface OrderLineRow extends LineRowBase {
  unit_factor: string; base_qty: string; net_after_bill: string; quote_line_id: string | null; delivered: string; delivered_value: string; product_kind: 'stock' | 'service';
}

/** Lines with what active delivery orders already took (qty and value). */
export async function orderLines(tx: Tx, soId: string): Promise<OrderLineRow[]> {
  const r = await tx.query<OrderLineRow>(
    `select l.id, l.line_no, l.product_id, l.unit_idx, p.sku, l.name, l.unit_name, l.unit_factor::text, l.qty::text, l.base_qty::text, l.unit_price::text, l.discount,
            l.disc_amt::text, l.net::text, l.net_after_bill::text, l.vat, l.quote_line_id, p.kind product_kind, l.list_price::text, l.price_source, l.price_ref,
            coalesce((select sum(dl.qty) from sales_delivery_lines dl join sales_deliveries dv on dv.id = dl.delivery_id where dl.so_line_id = l.id and dv.status = 'active'), 0)::text delivered,
            coalesce((select sum(dl.value) from sales_delivery_lines dl join sales_deliveries dv on dv.id = dl.delivery_id where dl.so_line_id = l.id and dv.status = 'active'), 0)::text delivered_value
       from sales_order_lines l join products p on p.id = l.product_id where l.so_id = $1 order by l.line_no`,
    [soId],
  );
  return r.rows;
}

/** open / partial / delivered from the active delivery orders. */
export async function refreshDlvStatus(tx: Tx, soId: string): Promise<void> {
  const lines = await orderLines(tx, soId);
  const any = lines.some((l) => d(l.delivered).gt(0));
  const all = lines.every((l) => d(l.delivered).gte(d(l.qty)));
  await tx.query(`update sales_orders set dlv_status = $2 where id = $1`, [soId, all ? 'delivered' : any ? 'partial' : 'open']);
}

export async function getOrder(tx: Tx, ctx: Ctx, no: string): Promise<SalesOrder> {
  const o = await orderRow(tx, no);
  const lines = await orderLines(tx, o.id);
  // cost / profit for data.cost users: the FIFO cost the lines would take from the order's warehouse now
  let profit: ReturnType<typeof profitOf> | null = null;
  if (can(ctx, 'data.cost') === 1) {
    const built = await storedLines(tx, lines);
    profit = profitOf(built, o.vat_mode, o.bill_disc, await peekUnitCosts(tx, o.warehouse_id, built));
  }
  const dlv = await tx.query<{ no: string; date: string; status: 'active' | 'void'; invoice_no: string | null }>(
    `select dv.no, dv.date::text, dv.status,
            (select string_agg(dd.no, ', ') from sales_invoice_deliveries sid join docs dd on dd.id = sid.invoice_doc_id where sid.delivery_id = dv.id and dd.status = 'active') invoice_no
       from sales_deliveries dv where dv.so_id = $1 order by dv.created_at`,
    [o.id],
  );
  const inv = await tx.query<{ no: string; date: string; status: 'active' | 'void' }>(
    `select distinct dd.no, dd.date::text, dd.status, dd.created_at from docs dd
       join sales_invoice_deliveries sid on sid.invoice_doc_id = dd.id join sales_deliveries dv on dv.id = sid.delivery_id
      where dv.so_id = $1 order by dd.created_at`,
    [o.id],
  );
  return {
    id: o.id, no: o.no, date: o.date, customer: partyOf(o), quoteNo: o.quote_no,
    project: o.project_id && o.pj_status === 'active' ? { id: o.project_id, no: o.pj_no!, name: o.pj_name!, isMain: o.pj_main === o.id } : null,
    warehouseId: o.warehouse_id, vatMode: o.vat_mode, term: o.term, salesperson: userRef(o.salesperson_id, o.sp_name, o.sp_phone), shipTo: o.ship_to, note: o.note,
    billDiscount: o.bill_disc, totals: totalsJson(o), dlvStatus: o.dlv_status, status: o.status,
    lines: lines.map((l, i) => ({
      ...lineJson(l), ...(profit?.lines[i] ?? {}), productId: l.product_id!, unitIdx: l.unit_idx!, baseQty: qty4(l.base_qty), netAfterBill: money(l.net_after_bill), deliveredQty: qty4(l.delivered),
      remainingQty: qty4(d(l.qty).minus(d(l.delivered))), quoteLineId: l.quote_line_id,
    })),
    creditApproval: o.credit_approval ? { by: o.credit_approval.name, detail: o.credit_approval.detail } : null,
    belowCostApproval: o.below_cost_approval ? { by: o.below_cost_approval.by, detail: o.below_cost_approval.detail } : null,
    priceApproval: o.price_approval ? { by: o.price_approval.name, detail: o.price_approval.detail } : null, profit: profit?.total ?? null,
    deliveries: dlv.rows.map((x) => ({ no: x.no, date: x.date, status: x.status, invoiceNo: x.invoice_no })),
    invoices: inv.rows.map((x) => ({ no: x.no, date: x.date, status: x.status })),
    createdBy: o.created_by_name, voided: voidedJson(o), purchaseOrders: await posFromSource(tx, o.no),
    ...(process.env.EDITION === 'cloud' ? { coupon: await scgfDocCoupon(tx, 'sales_orders', o.id) } : {}),
  };
}

/** Default delivery warehouse: the first active non-POS warehouse (the back store), else the POS one. */
export async function defaultWarehouse(tx: Tx): Promise<string | null> {
  const r = await tx.query<{ id: string }>(`select id from warehouses where active and kind = 'normal' order by is_pos, code limit 1`);
  return r.rows[0]?.id ?? null;
}

export async function createOrder(tx: Tx, deps: Deps, ctx: Ctx, req: SalesOrderReq): Promise<SalesOrder> {
  requirePerm(ctx, 'sales.doc');
  if (req.project) requirePerm(ctx, 'sales.project');
  const customer = await loadCustomer(tx, req.customerId);
  const audits: AuditInput[] = [];

  // From a quotation: same customer, still open; quotation lines map onto real products (REQ-M08-09).
  let quote: Awaited<ReturnType<typeof quoteRow>> | null = null;
  let qLines = new Map<string, Awaited<ReturnType<typeof quoteLines>>[number]>();
  if (req.quoteNo) {
    quote = await quoteRow(tx, req.quoteNo, true);
    const st = effectiveStatus(quote.status, quote.valid_until, deps.today());
    if (st === 'void' || st === 'lost' || st === 'expired') throw E.conflict(`Quotation ${quote.no} is ${st}`);
    if (quote.customer_id !== customer.id) throw E.validation('The sales order customer must be the quotation customer');
    qLines = new Map((await quoteLines(tx, quote.id, quote.revision)).map((l) => [l.id, l]));
    const seen = new Set<string>();
    for (const l of req.lines) {
      if (!l.quoteLineId) continue;
      if (seen.has(l.quoteLineId)) throw E.validation(`Quotation line ${l.quoteLineId} appears twice`);
      seen.add(l.quoteLineId);
      if (!qLines.has(l.quoteLineId)) throw E.validation(`Line ${l.quoteLineId} is not on ${quote.no} (revision ${quote.revision})`);
    }
  } else if (req.lines.some((l) => l.quoteLineId)) {
    throw E.validation('quoteLineId needs quoteNo');
  }

  const vatMode = quote ? quote.vat_mode : await resolveVatMode(tx, ctx, req.vatMode);
  if (quote && req.vatMode && req.vatMode !== quote.vat_mode) throw E.validation('A converted sales order keeps the quotation VAT mode');
  const lines = await buildLines(tx, req.lines, { allowFree: false });
  let totals = totalsOf(lines, vatMode, req.billDiscount);
  let coupon: { cart: ReturnType<typeof scgfCartOf>; value: { amount: string; title: string } } | null = null;
  if (process.env.EDITION === 'cloud') {
    // SCG Family coupon (cloud only): value from the provider for this order's cart, never the client's amount.
    if (deps.edition === 'cloud' && req.coupon) {
      const cart = scgfCartOf(lines.map((l) => ({ productId: l.product!.id, sku: l.product!.sku, name: l.name, isScg: l.product!.is_scg, qty: l.qty, unitPrice: l.unitPrice })), totals, vatMode);
      coupon = { cart, value: await scgfCouponValue(tx, req.coupon, cart) };
      totals = totalsOf(lines, vatMode, req.billDiscount, coupon.value.amount);
    }
  }
  const term = req.term ?? quote?.term ?? customer.term;
  const salesperson = await requireUser(tx, req.salespersonId ?? quote?.salesperson_id ?? ctx.userId);
  const warehouseId = req.warehouseId ? (await requireWarehouse(tx, req.warehouseId)).id : await defaultWarehouse(tx);
  const date = req.date ?? deps.today();

  // BR-05: a quotation line keeps its quoted price (QT → SO); other lines get the order's price (valid quote → lists → promo → retail).
  const pricer = await makePricer(tx, { customerId: customer.id, date, vatMode, doc: 'order' });
  const preApproved = new Set<number>();
  for (const [i, l] of lines.entries()) {
    const ql = req.lines[i]!.quoteLineId ? qLines.get(req.lines[i]!.quoteLineId!) : undefined;
    if (ql && quote) {
      Object.assign(l, { listPrice: qty4(ql.unit_price), priceSource: 'quote', priceRef: quote.no });
      // carried unchanged (price, discount, bill discount not larger): the quotation's below-cost approval still holds
      const sameDisc = JSON.stringify(ql.discount ? { kind: ql.discount.kind, value: d(ql.discount.value).toFixed() } : null) === JSON.stringify(l.discount ? { kind: l.discount.kind, value: d(l.discount.value).toFixed() } : null);
      if (quote.below_cost_approval && d(l.unitPrice).eq(d(ql.unit_price)) && sameDisc && d(totals.billDisc).lte(d(quote.bill_disc))) preApproved.add(i);
      continue;
    }
    const r = await pricer(l.product!, l.unitIdx!, l.qty);
    Object.assign(l, { listPrice: r.unitPrice, priceSource: r.source, priceRef: r.ref });
  }
  const pg = await priceGate(tx, deps, ctx, lines, totals, req.priceApproval, `ใบสั่งขาย ${customer.name}`);
  audits.push(...pg.audit);
  // BR-16 on the sales order (lines approved below cost on the quotation and carried unchanged keep that approval).
  const bc = await belowCostGate(tx, deps, ctx, lines, vatMode, totals.billDisc, await peekUnitCosts(tx, warehouseId, lines), req.belowCostApproval, 'ใบสั่งขาย',
    quote?.below_cost_approval ? { lines: preApproved, by: `${quote.below_cost_approval.by} (${quote.no})` } : undefined);
  if (bc.audit) audits.push(bc.audit);
  // BR-08 / REQ-M08-03.
  const cr = await creditGate(tx, deps, ctx, customer, term, totals.total, req.creditApproval, `ใบสั่งขาย ${customer.name}`);
  if (cr.audit) audits.push(cr.audit);

  let projectId: string | null = null;
  if (req.project?.mode === 'existing') {
    if (!isUuid(req.project.projectId)) throw E.validation('Unknown project');
    const pj = await tx.query<{ id: string; customer_id: string; status: string; no: string }>(`select id, customer_id, status, no from sales_projects where id = $1 for update`, [req.project.projectId]);
    const p = pj.rows[0];
    if (!p || p.status !== 'active') throw E.validation('Unknown project');
    if (p.customer_id !== customer.id) throw E.validation('A variation order must be for the project customer');
    projectId = p.id;
  }

  const no = await nextDocNo(tx, ctx.tenantId, 'SO', date);
  const id = (await tx.query<{ id: string }>(
    `insert into sales_orders (tenant_id, no, date, customer_id, quote_id, project_id, warehouse_id, vat_mode, term, salesperson_id, ship_to, note, bill_disc,
       gross, line_disc, base7, exempt, vat, total, credit_approval, below_cost_approval, created_by, search_text, price_approval)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) returning id`,
    [ctx.tenantId, no, date, customer.id, quote?.id ?? null, projectId, warehouseId, vatMode, JSON.stringify(term), salesperson, req.shipTo, req.note,
      totals.billDisc, totals.gross, totals.lineDisc, totals.base7, totals.exempt, totals.vat, totals.total,
      cr.approval ? JSON.stringify(cr.approval) : null, bc.approval ? JSON.stringify(bc.approval) : null, ctx.userId,
      haystack(no, customer, lines.map((l) => `${l.name} ${l.product?.sku ?? ''}`), totals.total, [quote?.no ?? '', req.shipTo, req.note]),
      pg.approval ? JSON.stringify(pg.approval) : null],
  )).rows[0]!.id;
  for (const [i, l] of lines.entries()) {
    await tx.query(
      `insert into sales_order_lines (tenant_id, so_id, line_no, product_id, unit_idx, name, unit_name, unit_factor, qty, base_qty, unit_price, discount, disc_amt, net, net_after_bill, vat, quote_line_id,
         list_price, price_source, price_ref)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [ctx.tenantId, id, i + 1, l.product!.id, l.unitIdx, l.name, l.unitName, l.unitFactor, l.qty, l.baseQty, l.unitPrice, l.discount ? JSON.stringify(l.discount) : null,
        discAmt(l), totals.lines[i]!.net, totals.lines[i]!.after, l.vat, req.lines[i]!.quoteLineId ?? null, l.listPrice ?? null, l.priceSource ?? null, l.priceRef ?? null],
    );
  }
  if (quote) await tx.query(`update sales_quotes set status = 'accepted', updated_at = now() where id = $1`, [quote.id]);
  if (process.env.EDITION === 'cloud') {
    if (coupon && req.coupon) await scgfRedeemOnDoc(tx, 'sales_orders', id, no, req.coupon, coupon.value, coupon.cart);
  }

  let pjText = '';
  if (req.project?.mode === 'new') {
    const pj = await createProjectForOrder(tx, deps, ctx, { id, no, customerId: customer.id, date }, req.project);
    pjText = ` · โครงการใหม่ ${pj.no} ${req.project.name}`;
  } else if (projectId) {
    pjText = ` · งานเพิ่มเข้าโครงการ`;
  }
  audits.push({ action: 'create', object: 'SO', ref: no, detail: `${customer.name} · ฿${fmtTHB(totals.total)} · ${lines.length} รายการ${quote ? ` · จาก ${quote.no}` : ''}${pjText}` });
  await writeAudit(tx, ctx, audits.map((a) => ({ ref: no, ...a })));
  return getOrder(tx, ctx, no);
}

/** BR-22: delivery orders (and so their invoices) first; the main order of an active project needs the project voided first. */
export async function voidOrder(tx: Tx, deps: Deps, ctx: Ctx, no: string, body: VoidBody): Promise<SalesOrder> {
  const approvedBy = await authorizeVoid(tx, deps, ctx, body, no);
  const o = await orderRow(tx, no, true);
  if (o.status === 'void') throw E.conflict(`${no} is already void`);
  const dlv = await tx.query<{ no: string }>(`select no from sales_deliveries where so_id = $1 and status = 'active' order by created_at`, [o.id]);
  const down = dlv.rows.map((r) => r.no);
  if (o.project_id && o.pj_status === 'active' && o.pj_main === o.id) down.push((o.pj_no ?? '') + ' (โครงการ)');
  if (down.length) throw E.downstreamFirst(`${no} has downstream documents; void them first`, { docs: down });
  await tx.query(`update sales_orders set status = 'void', void_by = $2, void_at = now(), void_reason = $3 where id = $1`, [o.id, ctx.userId, body.reason]);
  if (process.env.EDITION === 'cloud') {
    if (deps.edition === 'cloud') await scgfReturnOnVoid(tx, 'sales_orders', o.id, o.no);
  }
  await writeAudit(tx, ctx, [{ action: 'void', object: 'SO', ref: no, detail: `${body.reason} · ฿${fmtTHB(o.total)}${approvedBy}` }]);
  return getOrder(tx, ctx, no);
}

export async function listOrders(tx: Tx, q: SalesPageQuery & { projectId?: string }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.customerId) {
    if (!isUuid(q.customerId)) throw E.validation('Unknown customer');
    params.push(q.customerId);
    where.push(`x.customer_id = $${params.length}`);
  }
  if (q.status === 'void') where.push(`x.status = 'void'`);
  else if (q.status === 'open') where.push(`x.status = 'active' and x.dlv_status <> 'delivered'`);
  else if (q.status) {
    params.push(q.status);
    where.push(`x.status = 'active' and x.dlv_status = $${params.length}`);
  }
  return pageNewest<{ id: string; no: string; date: string; customer_id: string; c_name: string; total: string; dlv_status: SalesOrder['dlvStatus']; status: 'active' | 'void'; quote_no: string | null; pj_name: string | null; created_at: Date; preview: string | null; created_by_name: string }, SalesOrderSummary>(
    tx,
    `x.id, x.no, x.date::text, x.customer_id, c.name c_name, x.total::text, x.dlv_status, x.status, q.no quote_no, case when pj.status = 'active' then pj.name end pj_name, x.created_at,
     cu.name created_by_name,
     (select string_agg(split_part(l.name, ' ', 1) || ' ×' || trim(trailing '.' from trim(trailing '0' from l.qty::text)), ', ' order by l.line_no)
        from (select * from sales_order_lines y where y.so_id = x.id order by y.line_no limit 3) l) preview`,
    `sales_orders x join customers c on c.id = x.customer_id join users cu on cu.id = x.created_by left join sales_quotes q on q.id = x.quote_id left join sales_projects pj on pj.id = x.project_id`,
    where, params, q,
    (r) => ({
      id: r.id, no: r.no, date: r.date, customer: { id: r.customer_id, name: r.c_name }, total: r.total, dlvStatus: r.dlv_status, status: r.status,
      quoteNo: r.quote_no, projectName: r.pj_name, itemsPreview: r.preview ?? '', createdBy: r.created_by_name,
    }),
  );
}

/** Total of a set of order values (VAT-inclusive basis = order totals). */
export const orderTotal = (rows: { total: string }[]) => money(sum(rows.map((r) => r.total)));
