/**
 * Hook called by services/inventory.ts `receipt()` inside the goods-receipt transaction (REQ-M05-06 → REQ-M18-01):
 * records the GR lines (for vendor returns) and creates the AP bill with the vendor's payment term.
 * Kept free of imports from services/inventory so the two files never import each other.
 */
import type { Tx } from '@erp/db';
import { d, dueDate, money, poStatus, purchaseBill, qty4, type BillDiscountMode, type PaymentTerm, type PoStatus } from '@erp/core';
import type { Ctx } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E, isUuid } from '../../lib/errors';

/** BR-19: 'sep' (default) keeps the bill discount as a separate purchase discount; 'alloc' spreads it into lot cost. */
export async function billDiscountMode(tx: Tx): Promise<BillDiscountMode> {
  const r = await tx.query<{ bill_discount_mode: BillDiscountMode }>(`select bill_discount_mode from purchasing_settings`);
  return r.rows[0]?.bill_discount_mode ?? 'sep';
}

export interface GrHookLine {
  productId: string; warehouseId: string; unitIdx: number; unitName: string; unitFactor: string;
  qty: string; baseQty: string; unitPrice: string; amount: string; lotUnitCost: string; lotId: string;
  /** Purchase order line this receipt line fills (requires GrHookInput.poId). */
  poLineId?: string | null;
}

export interface GrHookInput {
  docId: string; no: string; date: string; vendorId: string; vendorInvoiceNo: string;
  billDiscount: string; mode: BillDiscountMode; lines: GrHookLine[];
  /** GR note, copied to the AP bill. */
  note?: string;
  /** Received against this purchase order (ใบสั่งซื้อ). */
  poId?: string | null;
}

/** Returns the AP bill number. */
export async function onGoodsReceipt(tx: Tx, ctx: Ctx, gr: GrHookInput): Promise<string> {
  const poId = await checkPoReceipt(tx, gr);
  for (const [i, l] of gr.lines.entries()) {
    await tx.query(
      `insert into gr_lines (tenant_id, gr_doc_id, gr_no, line_no, product_id, warehouse_id, unit_idx, unit_name, unit_factor, qty, base_qty, unit_price, amount, lot_unit_cost, lot_id,
         po_id, po_line_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [ctx.tenantId, gr.docId, gr.no, i + 1, l.productId, l.warehouseId, l.unitIdx, l.unitName, l.unitFactor, l.qty, l.baseQty, l.unitPrice, l.amount, l.lotUnitCost, l.lotId,
        l.poLineId ? poId : null, l.poLineId ?? null],
    );
  }
  if (poId) await refreshPoStatus(tx, poId);
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
  const r = await tx.query<{ id: string; product_id: string; base_qty: string; unit_factor: string; received: string }>(
    `select l.id, l.product_id, l.base_qty::text, l.unit_factor::text,
            coalesce((select sum(g.base_qty) from gr_lines g join stock_docs s on s.id = g.gr_doc_id where g.po_line_id = l.id and s.void_at is null), 0)::text received
       from purchase_order_lines l where l.po_id = $1 order by l.line_no`, [poId]);
  return r.rows;
}

/** open / partial / received from the active receipts; closed and void stay. */
export async function refreshPoStatus(tx: Tx, poId: string): Promise<PoStatus> {
  const cur = (await tx.query<{ status: PoStatus }>(`select status from purchase_orders where id = $1`, [poId])).rows[0]!.status;
  const next = poStatus(cur, (await poLineReceipts(tx, poId)).map((l) => ({ qty: l.base_qty, received: l.received })));
  if (next !== cur) await tx.query(`update purchase_orders set status = $2 where id = $1`, [poId, next]);
  return next;
}

/**
 * A receipt against a PO: the PO is open or partially received, from the same vendor, every poLineId is a line of it with
 * the same product, and no line receives more than it still waits for (over-receipt is refused; receive the extra
 * as a line without poLineId). Locks the PO row so two receipts against it queue.
 */
async function checkPoReceipt(tx: Tx, gr: GrHookInput): Promise<string | null> {
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
    taking.set(pl.id, (taking.get(pl.id) ?? d(0)).plus(d(l.baseQty)));
  }
  for (const [id, q] of taking) {
    const pl = lines.get(id)!;
    const left = d(pl.base_qty).minus(d(pl.received));
    if (q.gt(left)) {
      const f = d(pl.unit_factor);
      throw E.validation(`รับเกินจำนวนที่สั่งในใบสั่งซื้อ ${po.no} (ค้างรับ ${qty4(left.div(f))} รับครั้งนี้ ${qty4(q.div(f))})`, { reason: 'PO_OVER_RECEIVE', poLineId: id });
    }
  }
  return po.id;
}
