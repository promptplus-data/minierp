/**
 * Purchase orders (ใบสั่งซื้อ, PO): order goods from a vendor, optionally made from a quotation / sales order with the
 * shortfall prefilled, received through the normal goods receipt (services/inventory.ts receipt → grhook.ts checks
 * the PO and links gr_lines.po_line_id). Received qty and status come from the active receipts (refreshPoStatus).
 * Permission: inv.receive (the manual receipt key) to create / close / void; read also fin.ap or inv.view.
 */
import type { Tx } from '@erp/db';
import type { PoPrefill, PoReq, PoSummary, PurchaseOrder } from '@erp/contracts';
import { calcDoc, d, fmtTHB, lineDiscount, money, poShortfall, qty4, searchTokens, type PoStatus, type VatMode } from '@erp/core';
import { writeAudit } from '../../lib/audit';
import { can, requirePerm, type Ctx, type Deps } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E, isUuid } from '../../lib/errors';
import { decodeCursor, likeEscape, pageOf } from '../../lib/paging';
import { RESERVED_CTE } from '../../services/inventory';
import { loadProducts, requireWarehouse, unitOf } from '../../services/master';
import { poLineReceipts } from './grhook';

const STATUS_TH: Record<PoStatus, string> = { open: 'รอรับของ', partial: 'รับบางส่วน', received: 'รับครบ', closed: 'ปิดแล้ว', void: 'ยกเลิก' };

/** Viewers who may see PO prices: whoever makes receipts / pays vendors, or sees costs. */
const seePrice = (ctx: Ctx) => can(ctx, 'data.cost') === 1 || can(ctx, 'inv.receive') === 1 || can(ctx, 'fin.ap') === 1;
function requireRead(ctx: Ctx) {
  if (can(ctx, 'inv.receive') !== 1 && can(ctx, 'fin.ap') === 0) requirePerm(ctx, 'inv.view', { readOnly: true });
}

async function defaultWarehouse(tx: Tx): Promise<string | null> {
  const r = await tx.query<{ id: string }>(`select id from warehouses where active and kind = 'normal' order by is_pos, code limit 1`);
  return r.rows[0]?.id ?? null;
}

// ---------- source (quotation / sales order) ----------
interface SourceLine { id: string; product_id: string; sku: string; name: string; unit_idx: number; unit_name: string; unit_factor: string; ordered: string }
interface Source { type: 'QT' | 'SO'; id: string; no: string; customerName: string; warehouseId: string | null; lines: SourceLine[]; skipped: number }

/** Stock lines of a live quotation (current revision) or sales order (still to deliver). Services and free-text lines are skipped. */
async function loadSource(tx: Tx, no: string): Promise<Source> {
  const type = /^QT/.test(no) ? 'QT' : /^SO/.test(no) ? 'SO' : null;
  if (!type) throw E.validation('ใบสั่งซื้อสร้างได้จากใบเสนอราคาหรือใบสั่งขายเท่านั้น', { field: 'sourceNo' });
  if (type === 'QT') {
    const q = (await tx.query<{ id: string; revision: number; status: string; c_name: string }>(
      `select x.id, x.revision, x.status, c.name c_name from sales_quotes x join customers c on c.id = x.customer_id where x.no = $1`, [no])).rows[0];
    if (!q) throw E.notFound(`ไม่พบใบเสนอราคา ${no}`);
    if (q.status === 'void') throw E.conflict(`${no} ถูกยกเลิกแล้ว`);
    const r = await tx.query<SourceLine & { kind: string | null }>(
      `select l.id, l.product_id, p.sku, l.name, l.unit_idx, l.unit_name, l.unit_factor::text, l.qty::text ordered, p.kind
         from sales_quote_lines l left join products p on p.id = l.product_id where l.quote_id = $1 and l.revision = $2 order by l.line_no`, [q.id, q.revision]);
    const lines = r.rows.filter((l) => l.product_id && l.kind === 'stock');
    return { type, id: q.id, no, customerName: q.c_name, warehouseId: null, lines, skipped: r.rows.length - lines.length };
  }
  const o = (await tx.query<{ id: string; status: string; warehouse_id: string | null; c_name: string }>(
    `select x.id, x.status, x.warehouse_id, c.name c_name from sales_orders x join customers c on c.id = x.customer_id where x.no = $1`, [no])).rows[0];
  if (!o) throw E.notFound(`ไม่พบใบสั่งขาย ${no}`);
  if (o.status === 'void') throw E.conflict(`${no} ถูกยกเลิกแล้ว`);
  const r = await tx.query<SourceLine & { kind: string }>(
    `select l.id, l.product_id, p.sku, l.name, l.unit_idx, l.unit_name, l.unit_factor::text, p.kind,
            greatest(l.qty - coalesce((select sum(dl.qty) from sales_delivery_lines dl join sales_deliveries dv on dv.id = dl.delivery_id
                                        where dl.so_line_id = l.id and dv.status = 'active'), 0), 0)::text ordered
       from sales_order_lines l join products p on p.id = l.product_id where l.so_id = $1 order by l.line_no`, [o.id]);
  const lines = r.rows.filter((l) => l.kind === 'stock' && d(l.ordered).gt(0));
  return { type, id: o.id, no, customerName: o.c_name, warehouseId: o.warehouse_id, lines, skipped: r.rows.length - lines.length };
}

/** Purchase price per BASE unit to suggest: the last goods receipt of the product, else its moving-average cost. */
async function lastCosts(tx: Tx, productIds: string[]): Promise<Map<string, string>> {
  const r = await tx.query<{ product_id: string; c: string }>(
    `select p.id product_id,
            coalesce((select g.unit_price / g.unit_factor from gr_lines g join stock_docs s on s.id = g.gr_doc_id
                       where g.product_id = p.id and s.void_at is null order by s.created_at desc, g.line_no limit 1), p.cost)::text c
       from products p where p.id = any($1::uuid[])`, [productIds]);
  return new Map(r.rows.map((x) => [x.product_id, x.c]));
}

/**
 * Lines to order for a quotation / sales order: each stock line with qty = ordered − available in the warehouse (≥ 0).
 * Available = on hand − what OTHER sales orders reserve (this order's own reservation is added back). Several lines of
 * one product share the available stock in line order.
 */
export async function prefill(tx: Tx, deps: Deps, ctx: Ctx, sourceNo: string, q: { warehouseId?: string }): Promise<PoPrefill> {
  requirePerm(ctx, 'inv.receive');
  const src = await loadSource(tx, sourceNo);
  const defWh = await defaultWarehouse(tx);
  const wh = await requireWarehouse(tx, q.warehouseId ?? src.warehouseId ?? defWh ?? undefined);
  const pids = [...new Set(src.lines.map((l) => l.product_id))];
  const stock = await tx.query<{ product_id: string; onhand: string; reserved: string }>(
    `with ${RESERVED_CTE}
     select p.id product_id, coalesce((select sum(l.remaining) from stock_lots l where l.product_id = p.id and l.warehouse_id = $2), 0)::text onhand,
            coalesce((select r.q from reserved r where r.product_id = p.id and r.warehouse_id = $2), 0)::text reserved
       from products p where p.id = any($1::uuid[])`, [pids, wh.id]);
  const avail = new Map(stock.rows.map((s) => [s.product_id, d(s.onhand).minus(d(s.reserved))]));
  if (src.type === 'SO' && (src.warehouseId ?? defWh) === wh.id) {
    for (const l of src.lines) avail.set(l.product_id, (avail.get(l.product_id) ?? d(0)).plus(d(l.ordered).times(d(l.unit_factor))));
  }
  const costs = await lastCosts(tx, pids);
  const shop = (await tx.query<{ vat_registered: boolean }>(`select vat_registered from tenants where id = $1`, [ctx.tenantId])).rows[0];
  const price = seePrice(ctx);
  return {
    source: { type: src.type, no: src.no, customerName: src.customerName }, warehouseId: wh.id, vatMode: shop?.vat_registered === false ? 'none' : 'exc',
    lines: src.lines.map((l) => {
      const f = d(l.unit_factor);
      const a = avail.get(l.product_id) ?? d(0);
      const availableQty = qty4(a.div(f));
      avail.set(l.product_id, a.minus(d(l.ordered).times(f)));
      const c = costs.get(l.product_id);
      return {
        sourceLineId: l.id, productId: l.product_id, sku: l.sku, name: l.name, unitIdx: l.unit_idx, unitName: l.unit_name,
        orderedQty: qty4(l.ordered), availableQty, qty: poShortfall(l.ordered, availableQty), unitCost: price && c != null ? qty4(d(c).times(f)) : null,
      };
    }),
    skipped: src.skipped,
  };
}

// ---------- create ----------
async function resolveVat(tx: Tx, ctx: Ctx, requested?: VatMode): Promise<VatMode> {
  const s = (await tx.query<{ vat_registered: boolean }>(`select vat_registered from tenants where id = $1`, [ctx.tenantId])).rows[0];
  if (!s?.vat_registered) return 'none';
  if (requested === 'none') throw E.validation('ร้านจดภาษีมูลค่าเพิ่ม: เลือกราคารวมหรือไม่รวม VAT', { field: 'vatMode' });
  return requested ?? 'exc';
}

export async function createPo(tx: Tx, deps: Deps, ctx: Ctx, req: PoReq): Promise<PurchaseOrder> {
  requirePerm(ctx, 'inv.receive');
  if (!isUuid(req.vendorId)) throw E.validation('เลือกผู้ขาย', { field: 'vendorId' });
  const vendor = (await tx.query<{ id: string; name: string; code: string }>(`select id, name, code from vendors where id = $1`, [req.vendorId])).rows[0];
  if (!vendor) throw E.validation('เลือกผู้ขาย', { field: 'vendorId' });
  const wh = await requireWarehouse(tx, req.warehouseId);
  const date = req.date ?? deps.today();
  if (req.expectedDate && req.expectedDate < date) throw E.validation('วันที่คาดว่าจะได้รับต้องไม่ก่อนวันที่สั่งซื้อ', { field: 'expectedDate' });
  const vatMode = await resolveVat(tx, ctx, req.vatMode);
  const src = req.sourceNo ? await loadSource(tx, req.sourceNo.trim()) : null;
  const srcLines = new Map((src?.lines ?? []).map((l) => [l.id, l]));
  const products = await loadProducts(tx, req.lines.map((l) => l.productId));
  const lines = req.lines.map((l, i) => {
    const p = products.get(l.productId)!;
    if (p.kind !== 'stock') throw E.validation(`รายการที่ ${i + 1}: ${p.sku} เป็นบริการ ไม่ต้องสั่งซื้อเข้าสต็อก`, { field: `lines.${i}.productId` });
    if (!p.active) throw E.validation(`รายการที่ ${i + 1}: ${p.sku} ปิดการใช้งานแล้ว`, { field: `lines.${i}.productId` });
    if (!d(l.qty).gt(0)) throw E.validation(`รายการที่ ${i + 1}: จำนวนต้องมากกว่า 0`, { field: `lines.${i}.qty` });
    let sl: SourceLine | undefined;
    if (l.sourceLineId) {
      sl = srcLines.get(l.sourceLineId);
      if (!src || !sl) throw E.validation(`รายการที่ ${i + 1}: ไม่ใช่รายการของเอกสารต้นทาง`, { field: `lines.${i}.sourceLineId` });
      if (sl.product_id !== p.id) throw E.validation(`รายการที่ ${i + 1}: สินค้าไม่ตรงกับเอกสารต้นทาง`, { field: `lines.${i}.productId` });
    }
    const u = unitOf(p, l.unitIdx);
    return { p, unitIdx: l.unitIdx, unitName: u.name, factor: qty4(u.factor), qty: qty4(l.qty), baseQty: qty4(d(l.qty).times(d(u.factor))), unitCost: qty4(l.unitCost), discount: l.discount ?? null, sl };
  });
  const totals = calcDoc(lines.map((l) => ({ qty: l.qty, unitPrice: l.unitCost, discount: l.discount, vat: l.p.vat })), vatMode, 0);
  const no = await nextDocNo(tx, ctx.tenantId, 'PO', date);
  const search = [no, vendor.name, vendor.code, req.vendorRef, req.note, src?.no, ...lines.map((l) => `${l.p.name} ${l.p.sku}`), money(totals.total), fmtTHB(totals.total)]
    .filter(Boolean).join(' ').toLowerCase();
  const id = (await tx.query<{ id: string }>(
    `insert into purchase_orders (tenant_id, no, date, vendor_id, warehouse_id, expected_date, vendor_ref, note, vat_mode, gross, line_disc, base7, exempt, vat, total,
       source_type, source_id, source_no, search_text, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning id`,
    [ctx.tenantId, no, date, vendor.id, wh.id, req.expectedDate ?? null, req.vendorRef, req.note.trim(), vatMode, totals.gross, totals.lineDisc, totals.base7, totals.exempt,
      totals.vat, totals.total, src?.type ?? null, src?.id ?? null, src?.no ?? null, search, ctx.userId],
  )).rows[0]!.id;
  for (const [i, l] of lines.entries()) {
    await tx.query(
      `insert into purchase_order_lines (tenant_id, po_id, line_no, product_id, unit_idx, unit_name, unit_factor, qty, base_qty, unit_cost, discount, disc_amt, net, vat,
         source_line_id, source_qty)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [ctx.tenantId, id, i + 1, l.p.id, l.unitIdx, l.unitName, l.factor, l.qty, l.baseQty, l.unitCost, l.discount ? JSON.stringify(l.discount) : null,
        money(lineDiscount({ qty: l.qty, unitPrice: l.unitCost, discount: l.discount })), totals.lines[i]!.net, l.p.vat, l.sl?.id ?? null, l.sl ? qty4(l.sl.ordered) : null],
    );
  }
  await writeAudit(tx, ctx, [{ action: 'create', object: 'PO', ref: no, detail: `${vendor.name} · ${wh.name} · ${lines.length} รายการ · ฿${fmtTHB(totals.total)}${src ? ` · จาก ${src.no}` : ''}` }]);
  return getPo(tx, ctx, no);
}

// ---------- read ----------
interface PoRow {
  id: string; no: string; date: string; status: PoStatus; vendor_id: string; v_code: string; v_name: string; v_tax_id: string | null; v_phone: string | null;
  warehouse_id: string; wh_name: string; expected_date: string | null; vendor_ref: string; note: string; vat_mode: VatMode;
  gross: string; line_disc: string; base7: string; exempt: string; vat: string; total: string; source_type: 'QT' | 'SO' | null; source_no: string | null;
  created_by_name: string; closed_by_name: string | null; closed_at: Date | null; close_reason: string | null; void_by_name: string | null; void_at: Date | null; void_reason: string | null;
}
const SELECT = `select x.id, x.no, to_char(x.date,'YYYY-MM-DD') date, x.status, x.vendor_id, v.code v_code, v.name v_name, v.tax_id v_tax_id, v.phone v_phone,
  x.warehouse_id, w.name wh_name, to_char(x.expected_date,'YYYY-MM-DD') expected_date, x.vendor_ref, x.note, x.vat_mode,
  x.gross::text, x.line_disc::text, x.base7::text, x.exempt::text, x.vat::text, x.total::text, x.source_type, x.source_no,
  cu.name created_by_name, clu.name closed_by_name, x.closed_at, x.close_reason, vu.name void_by_name, x.void_at, x.void_reason
  from purchase_orders x join vendors v on v.id = x.vendor_id join warehouses w on w.id = x.warehouse_id join users cu on cu.id = x.created_by
  left join users clu on clu.id = x.closed_by left join users vu on vu.id = x.void_by`;

async function poRow(tx: Tx, no: string, forUpdate = false): Promise<PoRow> {
  if (forUpdate) await tx.query(`select id from purchase_orders where no = $1 for update`, [no]);
  const r = await tx.query<PoRow>(`${SELECT} where x.no = $1`, [no]);
  if (!r.rows[0]) throw E.notFound(`ไม่พบใบสั่งซื้อ ${no}`);
  return r.rows[0];
}

export async function getPo(tx: Tx, ctx: Ctx, no: string): Promise<PurchaseOrder> {
  requireRead(ctx);
  const x = await poRow(tx, no);
  const lines = await tx.query<{ id: string; line_no: number; product_id: string; sku: string; name: string; unit_idx: number; unit_name: string; unit_factor: string;
    qty: string; unit_cost: string; discount: { kind: 'pct' | 'amt'; value: string } | null; disc_amt: string; net: string; vat: 'v7' | 'exempt'; source_line_id: string | null; source_qty: string | null }>(
    `select l.id, l.line_no, l.product_id, p.sku, p.name, l.unit_idx, l.unit_name, l.unit_factor::text, l.qty::text, l.unit_cost::text, l.discount, l.disc_amt::text,
            l.net::text, l.vat, l.source_line_id, l.source_qty::text
       from purchase_order_lines l join products p on p.id = l.product_id where l.po_id = $1 order by l.line_no`, [x.id]);
  const rec = new Map((await poLineReceipts(tx, x.id)).map((r) => [r.id, r.received]));
  const receipts = await tx.query<{ no: string; date: string; void_at: Date | null }>(
    `select s.no, to_char(s.date,'YYYY-MM-DD') date, s.void_at from stock_docs s
      where s.type = 'GR' and exists (select 1 from gr_lines g where g.gr_doc_id = s.id and g.po_id = $1) order by s.created_at`, [x.id]);
  const price = seePrice(ctx);
  return {
    id: x.id, no: x.no, date: x.date, status: x.status,
    vendor: { id: x.vendor_id, code: x.v_code, name: x.v_name, taxId: x.v_tax_id, phone: x.v_phone },
    warehouseId: x.warehouse_id, warehouseName: x.wh_name, expectedDate: x.expected_date, vendorRef: x.vendor_ref, note: x.note, vatMode: x.vat_mode,
    totals: price ? { gross: money(x.gross), lineDisc: money(x.line_disc), billDisc: '0.00', base7: money(x.base7), exempt: money(x.exempt), vat: money(x.vat), total: money(x.total) } : null,
    source: x.source_type && x.source_no ? { type: x.source_type, no: x.source_no } : null,
    lines: lines.rows.map((l) => {
      const f = d(l.unit_factor);
      const received = d(rec.get(l.id) ?? 0).div(f);
      // GR cost per line unit: net after the line discount, VAT taken out when the PO prices include VAT.
      const exVat = x.vat_mode === 'inc' && l.vat === 'v7' ? d(l.net).times(100).div(107) : d(l.net);
      return {
        id: l.id, lineNo: l.line_no, productId: l.product_id, sku: l.sku, name: l.name, unitIdx: l.unit_idx, unitName: l.unit_name, unitFactor: qty4(f),
        qty: qty4(l.qty), receivedQty: qty4(received), remainingQty: qty4(d(l.qty).minus(received).gt(0) ? d(l.qty).minus(received) : 0),
        unitCost: price ? qty4(l.unit_cost) : null, discount: l.discount ? { kind: l.discount.kind, value: String(l.discount.value) } : null,
        discAmt: price ? money(l.disc_amt) : null, net: price ? money(l.net) : null, vat: l.vat,
        grUnitCost: price ? qty4(exVat.div(d(l.qty))) : null, sourceLineId: l.source_line_id, sourceQty: l.source_qty != null ? qty4(l.source_qty) : null,
      };
    }),
    receipts: receipts.rows.map((r) => ({ no: r.no, date: r.date, status: r.void_at ? 'void' as const : 'active' as const })),
    createdBy: x.created_by_name,
    closed: x.closed_at ? { by: x.closed_by_name ?? '', at: x.closed_at.toISOString(), reason: x.close_reason ?? '' } : null,
    voided: x.void_at ? { by: x.void_by_name ?? '', at: x.void_at.toISOString(), reason: x.void_reason ?? '' } : null,
  };
}

export async function listPos(tx: Tx, ctx: Ctx, q: { q?: string; limit: number; cursor?: string; status?: PoStatus | 'pending'; vendorId?: string }) {
  requireRead(ctx);
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.status === 'pending') where.push(`x.status in ('open','partial')`);
  else if (q.status) {
    params.push(q.status);
    where.push(`x.status = $${params.length}`);
  }
  if (q.vendorId) {
    if (!isUuid(q.vendorId)) throw E.validation('Unknown vendor');
    params.push(q.vendorId);
    where.push(`x.vendor_id = $${params.length}`);
  }
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`x.search_text ilike $${params.length}`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(x.created_at, x.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<{ id: string; no: string; date: string; status: PoStatus; v_name: string; warehouse_id: string; expected_date: string | null; vendor_ref: string;
    source_no: string | null; total: string; note: string; created_by_name: string; created_at: Date; preview: string | null }>(
    `select x.id, x.no, to_char(x.date,'YYYY-MM-DD') date, x.status, v.name v_name, x.warehouse_id, to_char(x.expected_date,'YYYY-MM-DD') expected_date, x.vendor_ref,
            x.source_no, x.total::text, x.note, cu.name created_by_name, x.created_at,
            (select string_agg(p.name || ' × ' || trim_scale(l.qty)::text || ' ' || l.unit_name, ', ' order by l.line_no) from purchase_order_lines l join products p on p.id = l.product_id where l.po_id = x.id) preview
       from purchase_orders x join vendors v on v.id = x.vendor_id join users cu on cu.id = x.created_by
      ${where.length ? `where ${where.join(' and ')}` : ''} order by x.created_at desc, x.id desc limit $${params.length}`, params);
  const price = seePrice(ctx);
  return pageOf(r.rows, q.limit, (x) => [x.created_at.toISOString(), x.id], (x): PoSummary => ({
    id: x.id, no: x.no, date: x.date, status: x.status, vendorName: x.v_name, warehouseId: x.warehouse_id, expectedDate: x.expected_date, vendorRef: x.vendor_ref,
    sourceNo: x.source_no, total: price ? money(x.total) : null, itemsPreview: x.preview ?? '', note: x.note, createdBy: x.created_by_name,
  }));
}

/** POs made from a quotation / sales order (shown on its detail page). */
export async function posFromSource(tx: Tx, sourceNo: string): Promise<{ no: string; status: string }[]> {
  const r = await tx.query<{ no: string; status: string }>(`select no, status from purchase_orders where source_no = $1 order by created_at`, [sourceNo]);
  return r.rows;
}

// ---------- void / close ----------
/** BR-22: a PO with an active goods receipt cannot be voided (void the receipts first, or close the PO). */
export async function voidPo(tx: Tx, ctx: Ctx, no: string, reason: string): Promise<PurchaseOrder> {
  requirePerm(ctx, 'inv.receive');
  const x = await poRow(tx, no, true);
  if (x.status === 'void') throw E.conflict(`${no} ถูกยกเลิกแล้ว`);
  const live = await tx.query<{ no: string }>(
    `select distinct s.no from stock_docs s join gr_lines g on g.gr_doc_id = s.id where g.po_id = $1 and s.void_at is null order by s.no`, [x.id]);
  if (live.rowCount) throw E.downstreamFirst(`${no} มีใบรับสินค้าแล้ว ต้องยกเลิกใบรับก่อน หรือใช้ "ปิดใบสั่งซื้อ"`, { docs: live.rows.map((r) => r.no) });
  await tx.query(`update purchase_orders set status = 'void', void_by = $2, void_at = now(), void_reason = $3 where id = $1`, [x.id, ctx.userId, reason]);
  await writeAudit(tx, ctx, [{ action: 'void', object: 'PO', ref: no, detail: `${x.v_name} · ${STATUS_TH[x.status]} · ฿${fmtTHB(x.total)} · ${reason}` }]);
  return getPo(tx, ctx, no);
}

/** Short-shipped order: stop waiting for the rest. Received lines stay; no more receipts against it. */
export async function closePo(tx: Tx, ctx: Ctx, no: string, reason: string): Promise<PurchaseOrder> {
  requirePerm(ctx, 'inv.receive');
  const x = await poRow(tx, no, true);
  if (x.status !== 'open' && x.status !== 'partial') throw E.conflict(`${no} ${STATUS_TH[x.status]} ปิดไม่ได้`);
  await tx.query(`update purchase_orders set status = 'closed', closed_by = $2, closed_at = now(), close_reason = $3 where id = $1`, [x.id, ctx.userId, reason]);
  const left = (await poLineReceipts(tx, x.id)).filter((l) => d(l.received).lt(d(l.base_qty))).length;
  await writeAudit(tx, ctx, [{ action: 'close', object: 'PO', ref: no, detail: `${x.v_name} · ${STATUS_TH[x.status]} · ค้างรับ ${left} รายการ · ${reason}` }]);
  return getPo(tx, ctx, no);
}

