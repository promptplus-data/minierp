/**
 * Hook called by services/inventory.ts `receipt()` inside the goods-receipt transaction (REQ-M05-06 → REQ-M18-01):
 * records the GR lines (for vendor returns) and creates the AP bill with the vendor's payment term.
 * Kept free of imports from services/inventory so the two files never import each other.
 */
import type { Tx } from '@erp/db';
import { dueDate, money, purchaseBill, type BillDiscountMode, type PaymentTerm } from '@erp/core';
import type { Ctx } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';

/** BR-19: 'sep' (default) keeps the bill discount as a separate purchase discount; 'alloc' spreads it into lot cost. */
export async function billDiscountMode(tx: Tx): Promise<BillDiscountMode> {
  const r = await tx.query<{ bill_discount_mode: BillDiscountMode }>(`select bill_discount_mode from purchasing_settings`);
  return r.rows[0]?.bill_discount_mode ?? 'sep';
}

export interface GrHookLine {
  productId: string; warehouseId: string; unitIdx: number; unitName: string; unitFactor: string;
  qty: string; baseQty: string; unitPrice: string; amount: string; lotUnitCost: string; lotId: string;
}

export interface GrHookInput {
  docId: string; no: string; date: string; vendorId: string; vendorInvoiceNo: string;
  billDiscount: string; mode: BillDiscountMode; lines: GrHookLine[];
}

/** Returns the AP bill number. */
export async function onGoodsReceipt(tx: Tx, ctx: Ctx, gr: GrHookInput): Promise<string> {
  for (const [i, l] of gr.lines.entries()) {
    await tx.query(
      `insert into gr_lines (tenant_id, gr_doc_id, gr_no, line_no, product_id, warehouse_id, unit_idx, unit_name, unit_factor, qty, base_qty, unit_price, amount, lot_unit_cost, lot_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [ctx.tenantId, gr.docId, gr.no, i + 1, l.productId, l.warehouseId, l.unitIdx, l.unitName, l.unitFactor, l.qty, l.baseQty, l.unitPrice, l.amount, l.lotUnitCost, l.lotId],
    );
  }
  const shop = await tx.query<{ vat_registered: boolean; term: PaymentTerm | null }>(
    `select t.vat_registered, v.term from tenants t, vendors v where t.id = $1 and v.id = $2`, [ctx.tenantId, gr.vendorId]);
  const vat = shop.rows[0]?.vat_registered ?? true;
  const bill = purchaseBill(gr.lines.map((l) => l.amount), gr.billDiscount, vat);
  const no = await nextDocNo(tx, ctx.tenantId, 'AP', gr.date);
  await tx.query(
    `insert into ap_bills (tenant_id, no, source, vendor_id, vendor_invoice_no, gr_doc_id, gr_no, date, due_date, base, discount, discount_mode, vat, total, created_by)
     values ($1,$2,'gr',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [ctx.tenantId, no, gr.vendorId, gr.vendorInvoiceNo, gr.docId, gr.no, gr.date, dueDate(gr.date, shop.rows[0]?.term), bill.base, bill.discount, gr.mode, bill.vat, money(bill.total), ctx.userId],
  );
  return no;
}
