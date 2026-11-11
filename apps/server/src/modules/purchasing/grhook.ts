/**
 * Hook called by services/inventory.ts `receipt()` inside the goods-receipt transaction (REQ-M05-06 → REQ-M18-01):
 * records the GR lines (for vendor returns) and creates the AP bill with the vendor's payment term.
 * Kept free of imports from services/inventory so the two files never import each other.
 */
import type { Tx } from '@erp/db';
import { d, dueDate, money, poOverQty, poStatus, purchaseBill, qty4, type BillDiscountMode, type FreeGoodsCosting, type PaymentTerm, type PoStatus } from '@erp/core';
import { writeAudit } from '../../lib/audit';
import type { Ctx } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E, isUuid } from '../../lib/errors';

/** BR-19: 'sep' (default) keeps the bill discount as a separate purchase discount; 'alloc' spreads it into lot cost. */
export async function billDiscountMode(tx: Tx): Promise<BillDiscountMode> {
  const r = await tx.query<{ bill_discount_mode: BillDiscountMode }>(`select bill_discount_mode from purchasing_settings`);
  return r.rows[0]?.bill_discount_mode ?? 'sep';
}

/** How a receipt costs its free lines unless it says otherwise: 'zero' (default) or 'allocate' (relative market value). */
export async function freeGoodsCosting(tx: Tx): Promise<FreeGoodsCosting> {
  const r = await tx.query<{ free_goods_costing: FreeGoodsCosting }>(`select free_goods_costing from purchasing_settings`);
  return r.rows[0]?.free_goods_costing ?? 'zero';
}

export interface GrHookLine {
  productId: string; warehouseId: string; unitIdx: number; unitName: string; unitFactor: string;
  qty: string; baseQty: string; unitPrice: string; amount: string; lotUnitCost: string; lotId: string;
  /** Purchase order line this receipt line fills (requires GrHookInput.poId). */
  poLineId?: string | null;
  /** ของแถม: unitPrice / amount are 0; lotUnitCost is 0 unless the receipt allocates. */
  free?: boolean;
  /** 'allocate' receipts: cost per receipt unit after the spread (lotUnitCost × unitFactor before rounding). */
  allocUnitCost?: string | null;
  /** 'allocate' receipts, free lines: market price per receipt unit used for the spread. */
  marketUnitPrice?: string | null;
}

export interface GrHookInput {
  docId: string; no: string; date: string; vendorId: string; vendorInvoiceNo: string;
  billDiscount: string; mode: BillDiscountMode; lines: GrHookLine[];
  /** GR note, copied to the AP bill. */
  note?: string;
  /** Received against this purchase order (ใบสั่งซื้อ). */
  poId?: string | null;
  /** Why more than the PO still waits for is accepted; required when a linked line goes over. */
  overReceiveNote?: string;
  /** Costing mode the receipt was saved with ('allocate' only when it had a free line). */
  freeGoodsCosting?: FreeGoodsCosting;
}

/** Returns the AP bill number. */
export async function onGoodsReceipt(tx: Tx, ctx: Ctx, gr: GrHookInput): Promise<string> {
  const check = await checkPoReceipt(tx, gr);
  const poId = check?.poId ?? null;
  for (const [i, l] of gr.lines.entries()) {
    await tx.query(
      `insert into gr_lines (tenant_id, gr_doc_id, gr_no, line_no, product_id, warehouse_id, unit_idx, unit_name, unit_factor, qty, base_qty, unit_price, amount, lot_unit_cost, lot_id,
         po_id, po_line_id, free, alloc_unit_cost, market_unit_price)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [ctx.tenantId, gr.docId, gr.no, i + 1, l.productId, l.warehouseId, l.unitIdx, l.unitName, l.unitFactor, l.qty, l.baseQty, l.unitPrice, l.amount, l.lotUnitCost, l.lotId,
        l.poLineId ? poId : null, l.poLineId ?? null, l.free === true, l.allocUnitCost ?? null, l.marketUnitPrice ?? null],
    );
  }
  await tx.query(`update stock_docs set free_goods_costing = $2 where id = $1`, [gr.docId, gr.freeGoodsCosting ?? 'zero']);
  if (poId) await refreshPoStatus(tx, poId);
  if (check?.over.length) {
    const note = gr.overReceiveNote!.trim();
    await tx.query(`update stock_docs set over_receive_note = $2 where id = $1`, [gr.docId, note]);
    await writeAudit(tx, ctx, check.over.map((o) => ({
      action: 'over_receive', object: 'PO', ref: check.poNo,
      detail: `รับเกินใบสั่งซื้อ ${check.poNo}: ${o.name} เกิน ${o.excess} ${o.unitName} · ${gr.no} · หมายเหตุ: ${note}`,
    })));
  }
  const shop = await tx.query<{ vat_registered: boolean; term: PaymentTerm | null }>(
    `select t.vat_registered, v.term from tenants t, vendors v where t.id = $1 and v.id = $2`, [ctx.tenantId, gr.vendorId]);
  const vat = shop.rows[0]?.vat_registered ?? true;
  const bill = purchaseBill(gr.lines.map((l) => l.amount), gr.billDiscount, vat);
  const no = await nextDocNo(tx, ctx.tenantId, 'AP', gr.date);
  await tx.query(
    `insert into ap_bills (tenant_id, no, source, vendor_id, vendor_invoice_no, gr_doc_id, gr_no, date, due_date, base, discount, discount_mode, vat, total, created_by, note)
     values ($1,$2,'gr',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [ctx.tenantId, no, gr.vendorId, gr.vendorInvoiceNo, gr.docId, gr.no, gr.date, dueDate(gr.date, shop.rows[0]?.term), bill.base, bill.discount, gr.mode, bill.vat, money(bill.total), ctx.userId, gr.note ?? ''],
  );
  return no;
}

// ---------- purchase orders (ใบสั่งซื้อ) ----------

/** Base qty received on each line of a PO by goods receipts that are not void. */
export async function poLineReceipts(tx: Tx, poId: string) {
  const r = await tx.query<{ id: string; product_id: string; sku: string; name: string; unit_name: string; base_qty: string; unit_factor: string; free: boolean; received: string }>(
    `select l.id, l.product_id, p.sku, p.name, l.unit_name, l.base_qty::text, l.unit_factor::text, l.free,
            coalesce((select sum(g.base_qty) from gr_lines g join stock_docs s on s.id = g.gr_doc_id where g.po_line_id = l.id and s.void_at is null), 0)::text received
       from purchase_order_lines l join products p on p.id = l.product_id where l.po_id = $1 order by l.line_no`, [poId]);
  return r.rows;
}

/** Which of these PO line ids are free (ของแถมตามเงื่อนไขผู้ขาย): a receipt line linked to one is free too (cost 0). */
export async function freePoLineIds(tx: Tx, ids: string[]): Promise<Set<string>> {
  const ok = ids.filter(isUuid);
  if (!ok.length) return new Set();
  const r = await tx.query<{ id: string }>(`select id from purchase_order_lines where id = any($1::uuid[]) and free`, [ok]);
  return new Set(r.rows.map((x) => x.id));
}

/** open / partial / received from the active receipts; closed and void stay. */
export async function refreshPoStatus(tx: Tx, poId: string): Promise<PoStatus> {
  const cur = (await tx.query<{ status: PoStatus }>(`select status from purchase_orders where id = $1`, [poId])).rows[0]!.status;
  const next = poStatus(cur, (await poLineReceipts(tx, poId)).map((l) => ({ qty: l.base_qty, received: l.received })));
  if (next !== cur) await tx.query(`update purchase_orders set status = $2 where id = $1`, [poId, next]);
  return next;
}

export interface OverLine { poLineId: string; sku: string; name: string; unitName: string; ordered: string; received: string; receiving: string; excess: string }

/**
 * A receipt against a PO: the PO is open or partially received, from the same vendor, every poLineId is a line of it with
 * the same product, and a free receipt line (ของแถม) links only to a free PO line. A line that receives more than it
 * still waits for needs `overReceiveNote`; without one the receipt is refused with 409 PO_OVER_RECEIVE listing each
 * line (ordered / received / this receipt / excess, in the PO line unit) so the client can ask and resend.
 * Free lines without a PO line never count. Locks the PO row so two receipts against it queue.
 */
async function checkPoReceipt(tx: Tx, gr: GrHookInput): Promise<{ poId: string; poNo: string; over: OverLine[] } | null> {
  const linked = gr.lines.filter((l) => l.poLineId);
  if (!gr.poId) {
    if (linked.length) throw E.validation('poLineId needs poId');
    return null;
  }
  if (!isUuid(gr.poId)) throw E.validation('Unknown purchase order');
  const po = (await tx.query<{ id: string; no: string; status: PoStatus; vendor_id: string }>(
    `select id, no, status, vendor_id from purchase_orders where id = $1 for update`, [gr.poId])).rows[0];
  if (!po) throw E.validation('Unknown purchase order');
  if (po.status !== 'open' && po.status !== 'partial') throw E.conflict(`ใบสั่งซื้อ ${po.no} ${po.status === 'void' ? 'ถูกยกเลิกแล้ว' : po.status === 'closed' ? 'ปิดแล้ว' : 'รับครบแล้ว'} รับของเพิ่มไม่ได้`, { reason: 'PO_NOT_OPEN' });
  if (po.vendor_id !== gr.vendorId) throw E.validation(`ผู้ขายไม่ตรงกับใบสั่งซื้อ ${po.no}`, { field: 'vendorId' });
  if (!linked.length) throw E.validation(`เลือกรายการจากใบสั่งซื้อ ${po.no} อย่างน้อย 1 รายการ`);
  const lines = new Map((await poLineReceipts(tx, po.id)).map((l) => [l.id, l]));
  const taking = new Map<string, ReturnType<typeof d>>();
  for (const l of linked) {
    const pl = lines.get(l.poLineId!);
    if (!pl) throw E.validation(`รายการไม่ได้อยู่ในใบสั่งซื้อ ${po.no}`);
    if (pl.product_id !== l.productId) throw E.validation(`สินค้าไม่ตรงกับรายการในใบสั่งซื้อ ${po.no}`);
    if (l.free && !pl.free) throw E.validation(`${pl.name}: ของแถมผูกกับรายการสั่งซื้อปกติไม่ได้ (เพิ่มเป็นรายการของแถมแยก)`, { reason: 'FREE_LINE_ON_PO_LINE' });
    taking.set(pl.id, (taking.get(pl.id) ?? d(0)).plus(d(l.baseQty)));
  }
  const over: OverLine[] = [];
  for (const [id, q] of taking) {
    const pl = lines.get(id)!;
    const excess = d(poOverQty(pl.base_qty, pl.received, q));
    if (excess.gt(0)) {
      const f = d(pl.unit_factor);
      over.push({
        poLineId: id, sku: pl.sku, name: pl.name, unitName: pl.unit_name, ordered: qty4(d(pl.base_qty).div(f)), received: qty4(d(pl.received).div(f)),
        receiving: qty4(q.div(f)), excess: qty4(excess.div(f)),
      });
    }
  }
  if (over.length && !gr.overReceiveNote?.trim()) {
    throw E.conflict(`รับเกินจำนวนในใบสั่งซื้อ ${po.no}: ${over.map((o) => `${o.name} เกิน ${o.excess} ${o.unitName}`).join(', ')} — ระบุหมายเหตุเพื่อยืนยัน`,
      { reason: 'PO_OVER_RECEIVE', poNo: po.no, lines: over });
  }
  return { poId: po.id, poNo: po.no, over };
}
