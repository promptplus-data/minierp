/**
 * Delivery orders (REQ-M08-04/10, M09-02): partial deliveries from a sales order (cut stock FIFO at the delivery date,
 * BR-07 / BR-21) or from an invoice whose goods the customer left at the shop (stock already cut by the invoice).
 * Never more than ordered (or invoiced − returned); void = stock back into the original lots, invoices first (BR-22).
 */
import type { Tx } from '@erp/db';
import type { SalesDelivery, SalesDeliveryReq, SalesDeliverySource, SalesDeliverySummary, SalesPageQuery } from '@erp/contracts';
import { d, fmtTHB, money, qty4, sum, searchTokens } from '@erp/core';
import { writeAudit } from '../../lib/audit';
import { can, type Ctx, type Deps } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E, isUuid } from '../../lib/errors';
import { applyOut, lockLots, planTakes, reverseOuts } from '../../lib/stock';
import { requireWarehouse } from '../../services/master';
import { authorizeVoid, haystack, loadCustomer, pageNewest, partyCols, partyOf, share, voidedJson, type PartyCols, type VoidBody } from './common';
import { defaultWarehouse, orderLines, orderRow, refreshDlvStatus } from './orders';

/** Deliveries are made by sales (sales.doc) or the warehouse (inv.receive). */
function requireDeliver(ctx: Ctx): void {
  if (can(ctx, 'sales.doc') === 1 || can(ctx, 'inv.receive') === 1) return;
  throw E.forbidden('Permission sales.doc or inv.receive is required', { perms: ['sales.doc', 'inv.receive'] });
}

interface PlannedLine { productId: string; name: string; unitName: string; unitFactor: string; qty: string; baseQty: string; unitPrice: string; value: string; soLineId: string | null; invLineId: string | null; stock: boolean }

export async function createDelivery(tx: Tx, deps: Deps, ctx: Ctx, req: SalesDeliveryReq): Promise<SalesDelivery> {
  requireDeliver(ctx);
  const date = req.date ?? deps.today();
  const seen = new Set<string>();
  for (const l of req.lines) {
    if (seen.has(l.srcLineId)) throw E.validation(`Line ${l.srcLineId} appears twice`);
    seen.add(l.srcLineId);
    if (!d(l.qty).gt(0)) throw E.validation('Delivery qty must be > 0');
  }

  let header: { customerId: string | null; customerName: string; soId: string | null; invId: string | null; projectId: string | null; warehouseId: string | null; shipTo: string; ref: string };
  let lines: PlannedLine[];
  if (req.soNo) {
    const so = await orderRow(tx, req.soNo, true);
    if (so.status !== 'active') throw E.conflict(`${so.no} is void`);
    const ol = new Map((await orderLines(tx, so.id)).map((l) => [l.id, l]));
    lines = req.lines.map((r) => {
      const l = ol.get(r.srcLineId);
      if (!l) throw E.validation(`Line ${r.srcLineId} is not on ${so.no}`);
      const rest = d(l.qty).minus(d(l.delivered));
      if (d(r.qty).gt(rest)) throw E.conflict(`${l.name}: delivery ${qty4(r.qty)} is more than still to deliver (${qty4(rest)})`, { lineId: l.id, remaining: qty4(rest) });
      return {
        productId: l.product_id!, name: l.name, unitName: l.unit_name, unitFactor: l.unit_factor, qty: qty4(r.qty), baseQty: qty4(d(r.qty).times(d(l.unit_factor))),
        unitPrice: l.unit_price, value: share(l.net_after_bill, r.qty, l.qty, l.delivered, l.delivered_value), soLineId: l.id, invLineId: null, stock: l.product_kind === 'stock',
      };
    });
    const pj = so.project_id && so.pj_status === 'active' ? (await tx.query<{ site: string }>(`select site from sales_projects where id = $1`, [so.project_id])).rows[0] : undefined;
    const wh = req.warehouseId ? (await requireWarehouse(tx, req.warehouseId)).id : so.warehouse_id ?? (await defaultWarehouse(tx));
    header = { customerId: so.customer_id, customerName: so.c_name ?? '', soId: so.id, invId: null, projectId: pj ? so.project_id : null, warehouseId: wh, shipTo: req.shipTo || so.ship_to || pj?.site || '', ref: so.no };
  } else {
    await tx.query(`select id from docs where no = $1 for update`, [req.invoiceNo]);
    const inv = await tx.query<{ id: string; no: string; status: string; customer_id: string | null; customer_name: string; goods_left: boolean | null; project_id: string | null }>(
      `select x.id, x.no, x.status, x.customer_id, x.customer_name, si.goods_left, si.project_id from docs x left join sales_invoices si on si.doc_id = x.id where x.no = $1`, [req.invoiceNo]);
    const x = inv.rows[0];
    if (!x) throw E.notFound(`Invoice ${req.invoiceNo} not found`);
    if (x.status !== 'active') throw E.conflict(`${x.no} is void`);
    if (!x.goods_left) throw E.validation(`${x.no} was not marked "goods left at the shop"`);
    const il = await tx.query<{ id: string; product_id: string; name: string; unit_name: string; unit_factor: string; qty: string; returned_qty: string; unit_price: string; net_after_bill: string; delivered: string; delivered_value: string }>(
      `select l.id, l.product_id, l.name, l.unit_name, l.unit_factor::text, l.qty::text, l.returned_qty::text, l.unit_price::text, l.net_after_bill::text,
              coalesce((select sum(dl.qty) from sales_delivery_lines dl join sales_deliveries dv on dv.id = dl.delivery_id where dl.inv_line_id = l.id and dv.status = 'active'), 0)::text delivered,
              coalesce((select sum(dl.value) from sales_delivery_lines dl join sales_deliveries dv on dv.id = dl.delivery_id where dl.inv_line_id = l.id and dv.status = 'active'), 0)::text delivered_value
         from doc_lines l where l.doc_id = $1`, [x.id]);
    const byId = new Map(il.rows.map((l) => [l.id, l]));
    lines = req.lines.map((r) => {
      const l = byId.get(r.srcLineId);
      if (!l) throw E.validation(`Line ${r.srcLineId} is not on ${x.no}`);
      const rest = d(l.qty).minus(d(l.returned_qty)).minus(d(l.delivered));
      if (d(r.qty).gt(rest)) throw E.conflict(`${l.name}: delivery ${qty4(r.qty)} is more than still at the shop (${qty4(rest)})`, { lineId: l.id, remaining: qty4(rest) });
      return {
        productId: l.product_id, name: l.name, unitName: l.unit_name, unitFactor: l.unit_factor, qty: qty4(r.qty), baseQty: qty4(d(r.qty).times(d(l.unit_factor))),
        unitPrice: l.unit_price, value: share(l.net_after_bill, r.qty, l.qty, l.delivered, l.delivered_value), soLineId: null, invLineId: l.id, stock: false,
      };
    });
    header = { customerId: x.customer_id, customerName: x.customer_name, soId: null, invId: x.id, projectId: x.project_id, warehouseId: null, shipTo: req.shipTo, ref: x.no };
  }

  const no = await nextDocNo(tx, ctx.tenantId, 'DO', date);
  // BR-07: lock the lots and plan FIFO before writing anything; a shortage aborts with 409.
  if (header.soId && !header.warehouseId) throw E.validation('No warehouse to deliver from');
  const stock = header.warehouseId ? lines.filter((l) => l.stock) : [];
  const lots = header.warehouseId ? await lockLots(tx, header.warehouseId, stock.map((l) => l.productId)) : new Map();
  const plans = header.warehouseId ? planTakes(lots, header.warehouseId, stock.map((l) => ({ productId: l.productId, qty: l.baseQty }))) : [];
  const planOf = new Map(stock.map((l, i) => [l, plans[i]!]));
  const total = money(sum(lines.map((l) => l.value)));
  const customer = header.customerId ? await loadCustomer(tx, header.customerId) : null;
  const id = (await tx.query<{ id: string }>(
    `insert into sales_deliveries (tenant_id, no, date, customer_id, customer_name, so_id, inv_doc_id, project_id, warehouse_id, ship_to, vehicle, note, total, created_by, search_text)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
    [ctx.tenantId, no, date, header.customerId, header.customerName, header.soId, header.invId, header.projectId, header.warehouseId, header.shipTo, req.vehicle, req.note,
      total, ctx.userId, haystack(no, customer, lines.map((l) => l.name), total, [header.ref, header.shipTo, req.vehicle])],
  )).rows[0]!.id;
  for (const [i, l] of lines.entries()) {
    const pl = planOf.get(l);
    const lineId = (await tx.query<{ id: string }>(
      `insert into sales_delivery_lines (tenant_id, delivery_id, line_no, so_line_id, inv_line_id, product_id, name, unit_name, unit_factor, qty, base_qty, unit_price, value, cogs)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [ctx.tenantId, id, i + 1, l.soLineId, l.invLineId, l.productId, l.name, l.unitName, l.unitFactor, l.qty, l.baseQty, l.unitPrice, l.value, pl?.cogs ?? null],
    )).rows[0]!.id;
    if (pl) await applyOut(tx, ctx, header.warehouseId!, pl, { docType: 'DO', docNo: no, docId: id, docLineId: lineId, note: `ส่งของ · ${header.ref}${header.shipTo ? ' · ' + header.shipTo : ''}` });
  }
  if (header.soId) await refreshDlvStatus(tx, header.soId);
  await writeAudit(tx, ctx, [{ action: 'create', object: 'DO', ref: no, detail: `${header.customerName} · จาก ${header.ref} · ${lines.length} รายการ · ฿${fmtTHB(total)}${header.shipTo ? ' · ส่งที่ ' + header.shipTo : ''}${header.warehouseId ? '' : ' · ไม่ตัดสต็อก (ตัดแล้วตอนออกใบกำกับ)'}` }]);
  return getDelivery(tx, ctx, no);
}

interface DlvRow extends PartyCols {
  id: string; no: string; date: string; customer_name: string; so_no: string | null; inv_no: string | null; project_id: string | null; pj_no: string | null; pj_name: string | null;
  pj_site: string | null; warehouse_id: string | null; wh_name: string | null; ship_to: string; vehicle: string; note: string; total: string; status: 'active' | 'void';
  created_by_name: string; void_by_name: string | null; void_at: Date | null; void_reason: string | null;
}

export async function deliveryRow(tx: Tx, no: string, forUpdate = false): Promise<DlvRow> {
  if (forUpdate) await tx.query(`select id from sales_deliveries where no = $1 for update`, [no]);
  const r = await tx.query<DlvRow>(
    `select x.id, x.no, x.date::text, x.customer_name, so.no so_no, inv.no inv_no, x.project_id, pj.no pj_no, pj.name pj_name, pj.site pj_site, x.warehouse_id, w.name wh_name,
            x.ship_to, x.vehicle, x.note, x.total::text, x.status, cu.name created_by_name, vu.name void_by_name, x.void_at, x.void_reason, ${partyCols}
       from sales_deliveries x join users cu on cu.id = x.created_by left join customers c on c.id = x.customer_id left join sales_orders so on so.id = x.so_id
       left join docs inv on inv.id = x.inv_doc_id left join sales_projects pj on pj.id = x.project_id left join warehouses w on w.id = x.warehouse_id
       left join users vu on vu.id = x.void_by where x.no = $1`,
    [no],
  );
  if (!r.rows[0]) throw E.notFound(`Delivery order ${no} not found`);
  return r.rows[0];
}

export async function getDelivery(tx: Tx, ctx: Ctx, no: string): Promise<SalesDelivery> {
  const x = await deliveryRow(tx, no);
  const seeCost = can(ctx, 'data.cost') === 1;
  const lines = await tx.query<{ id: string; product_id: string; name: string; unit_name: string; qty: string; unit_price: string; value: string; cogs: string | null }>(
    `select id, product_id, name, unit_name, qty::text, unit_price::text, value::text, cogs::text from sales_delivery_lines where delivery_id = $1 order by line_no`, [x.id]);
  const inv = await tx.query<{ no: string }>(
    `select dd.no from sales_invoice_deliveries sid join docs dd on dd.id = sid.invoice_doc_id where sid.delivery_id = $1 and dd.status = 'active' order by dd.created_at`, [x.id]);
  return {
    id: x.id, no: x.no, date: x.date, customer: partyOf(x, x.customer_name), soNo: x.so_no, invoiceNo: x.inv_no,
    project: x.project_id ? { id: x.project_id, no: x.pj_no!, name: x.pj_name!, site: x.pj_site ?? '' } : null,
    warehouse: x.warehouse_id ? { id: x.warehouse_id, name: x.wh_name ?? '' } : null, cutsStock: !!x.warehouse_id, shipTo: x.ship_to, vehicle: x.vehicle, note: x.note,
    lines: lines.rows.map((l) => ({ id: l.id, productId: l.product_id, name: l.name, unitName: l.unit_name, qty: qty4(l.qty), unitPrice: qty4(l.unit_price), value: money(l.value), cogs: seeCost && l.cogs != null ? money(l.cogs) : null })),
    total: x.total, invoiceNos: inv.rows.map((r) => r.no), status: x.status, createdBy: x.created_by_name, voided: voidedJson(x),
  };
}

/** BR-22: an active invoice that billed this delivery goes first. Stock goes back into the original lots (BR-21). */
export async function voidDelivery(tx: Tx, deps: Deps, ctx: Ctx, no: string, body: VoidBody): Promise<SalesDelivery> {
  const approvedBy = await authorizeVoid(tx, deps, ctx, body, no);
  const x = await deliveryRow(tx, no, true);
  if (x.status === 'void') throw E.conflict(`${no} is already void`);
  const inv = await tx.query<{ no: string }>(
    `select dd.no from sales_invoice_deliveries sid join docs dd on dd.id = sid.invoice_doc_id where sid.delivery_id = $1 and dd.status = 'active'`, [x.id]);
  if (inv.rowCount) throw E.downstreamFirst(`${no} is invoiced; void the invoice first`, { docs: inv.rows.map((r) => r.no) });
  await reverseOuts(tx, ctx, x.id, { docType: 'DO', docNo: no, docId: x.id, note: `คืนสต็อก · ยกเลิก ${no}` });
  await tx.query(`update sales_deliveries set status = 'void', void_by = $2, void_at = now(), void_reason = $3 where id = $1`, [x.id, ctx.userId, body.reason]);
  const so = await tx.query<{ so_id: string | null }>(`select so_id from sales_deliveries where id = $1`, [x.id]);
  if (so.rows[0]?.so_id) await refreshDlvStatus(tx, so.rows[0].so_id);
  await writeAudit(tx, ctx, [{ action: 'void', object: 'DO', ref: no, detail: `${body.reason} · ฿${fmtTHB(x.total)}${x.warehouse_id ? ' · คืนสต็อก' : ''}${approvedBy}` }]);
  return getDelivery(tx, ctx, no);
}

export async function listDeliveries(tx: Tx, q: SalesPageQuery & { projectId?: string }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.customerId) {
    if (!isUuid(q.customerId)) throw E.validation('Unknown customer');
    params.push(q.customerId);
    where.push(`x.customer_id = $${params.length}`);
  }
  if (q.projectId) {
    if (!isUuid(q.projectId)) throw E.validation('Unknown project');
    params.push(q.projectId);
    where.push(`x.project_id = $${params.length}`);
  }
  const billed = `(select string_agg(dd.no, ', ') from sales_invoice_deliveries sid join docs dd on dd.id = sid.invoice_doc_id where sid.delivery_id = x.id and dd.status = 'active')`;
  if (q.status === 'void') where.push(`x.status = 'void'`);
  else if (q.status === 'unbilled') where.push(`x.status = 'active' and x.so_id is not null and x.project_id is null and ${billed} is null`);
  return pageNewest<{ id: string; no: string; date: string; customer_id: string | null; customer_name: string; so_no: string | null; inv_no: string | null; billed: string | null; pj_name: string | null; total: string; status: 'active' | 'void'; created_at: Date; preview: string | null; cash_sale: boolean }, SalesDeliverySummary>(
    tx,
    `x.id, x.no, x.date::text, x.customer_id, x.customer_name, so.no so_no, inv.no inv_no, ${billed} billed, pj.name pj_name, x.total::text, x.status, x.created_at, coalesce(so.term->>'t' = 'cash', false) cash_sale,
     (select string_agg(split_part(l.name, ' ', 1) || ' ×' || trim(trailing '.' from trim(trailing '0' from l.qty::text)), ', ' order by l.line_no)
        from (select * from sales_delivery_lines y where y.delivery_id = x.id order by y.line_no limit 3) l) preview`,
    `sales_deliveries x left join sales_orders so on so.id = x.so_id left join docs inv on inv.id = x.inv_doc_id left join sales_projects pj on pj.id = x.project_id`,
    where, params, q,
    (r) => ({
      id: r.id, no: r.no, date: r.date, customer: { id: r.customer_id, name: r.customer_name }, soNo: r.so_no, invoiceNo: r.inv_no, billedBy: r.billed,
      projectName: r.pj_name, total: r.total, status: r.status, itemsPreview: r.preview ?? '', cashSale: r.cash_sale,
    }),
  );
}

/** Open sales orders and goods-left invoices that still have something to deliver (the "new delivery" picker). */
export async function deliverySources(tx: Tx, q: SalesPageQuery) {
  const out: SalesDeliverySource[] = [];
  const params: unknown[] = [];
  let cust = '';
  if (q.customerId) {
    if (!isUuid(q.customerId)) throw E.validation('Unknown customer');
    params.push(q.customerId);
    cust = `and x.customer_id = $1`;
  }
  const words = searchTokens(q.q);
  const sos = await tx.query<{ id: string; no: string; date: string; customer_id: string; c_name: string; ship_to: string; project_id: string | null; pj_name: string | null; pj_site: string | null; pj_status: string | null; warehouse_id: string | null; search_text: string }>(
    `select x.id, x.no, x.date::text, x.customer_id, c.name c_name, x.ship_to, x.project_id, pj.name pj_name, pj.site pj_site, pj.status pj_status, x.warehouse_id, x.search_text
       from sales_orders x join customers c on c.id = x.customer_id left join sales_projects pj on pj.id = x.project_id
      where x.status = 'active' and x.dlv_status <> 'delivered' ${cust} order by x.created_at desc limit 50`, params);
  for (const s of sos.rows) {
    if (!words.every((w) => s.search_text.includes(w))) continue;
    const lines = (await orderLines(tx, s.id)).map((l) => ({ id: l.id, productId: l.product_id!, name: l.name, unitName: l.unit_name, qty: qty4(l.qty), delivered: qty4(l.delivered), remaining: qty4(d(l.qty).minus(d(l.delivered))) }));
    out.push({
      kind: 'SO', no: s.no, date: s.date, customer: { id: s.customer_id, name: s.c_name }, shipTo: s.ship_to || s.pj_site || '',
      project: s.project_id && s.pj_status === 'active' ? { id: s.project_id, name: s.pj_name!, site: s.pj_site ?? '' } : null, warehouseId: s.warehouse_id, lines,
    });
  }
  const invs = await tx.query<{ id: string; no: string; date: string; customer_id: string | null; customer_name: string; search_text: string }>(
    `select x.id, x.no, x.date::text, x.customer_id, x.customer_name, x.search_text from docs x join sales_invoices si on si.doc_id = x.id
      where x.status = 'active' and si.goods_left ${cust} order by x.created_at desc limit 50`, params);
  for (const v of invs.rows) {
    if (!words.every((w) => v.search_text.includes(w))) continue;
    const il = await tx.query<{ id: string; product_id: string; name: string; unit_name: string; qty: string; returned_qty: string; delivered: string }>(
      `select l.id, l.product_id, l.name, l.unit_name, l.qty::text, l.returned_qty::text,
              coalesce((select sum(dl.qty) from sales_delivery_lines dl join sales_deliveries dv on dv.id = dl.delivery_id where dl.inv_line_id = l.id and dv.status = 'active'), 0)::text delivered
         from doc_lines l where l.doc_id = $1 order by l.line_no`, [v.id]);
    const lines = il.rows.map((l) => {
      const q2 = d(l.qty).minus(d(l.returned_qty));
      return { id: l.id, productId: l.product_id, name: l.name, unitName: l.unit_name, qty: qty4(q2), delivered: qty4(l.delivered), remaining: qty4(q2.minus(d(l.delivered))) };
    });
    if (lines.every((l) => !d(l.remaining).gt(0))) continue;
    out.push({ kind: 'INV', no: v.no, date: v.date, customer: { id: v.customer_id, name: v.customer_name }, shipTo: '', project: null, warehouseId: null, lines });
  }
  return { items: out, nextCursor: null };
}

