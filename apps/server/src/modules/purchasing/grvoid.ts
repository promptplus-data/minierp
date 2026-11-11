/**
 * Void a goods receipt (BR-22: flag, never delete). Allowed only while nothing downstream used it: every lot it created
 * is untouched (nothing sold, transferred, counted or returned from it) and its AP bill has no payment and no vendor
 * return. The lots go back to zero through a ledger stock-out at the lot cost, the AP bill is voided, and the purchase
 * orders it filled get their received quantity back (refreshPoStatus).
 */
import type { Tx } from '@erp/db';
import type { GrDetail } from '@erp/contracts';
import { d, fmtTHB, money } from '@erp/core';
import { writeAudit } from '../../lib/audit';
import { requirePerm, type Ctx } from '../../lib/context';
import { E } from '../../lib/errors';
import { applyOut } from '../../lib/stock';
import { getReceipt } from './ap';
import { refreshPoStatus } from './grhook';

export async function voidReceipt(tx: Tx, ctx: Ctx, no: string, reason: string): Promise<GrDetail> {
  requirePerm(ctx, 'inv.receive');
  const g = (await tx.query<{ id: string; no: string; warehouse_id: string; void_at: Date | null; total: string | null }>(
    `select id, no, warehouse_id, void_at, total::text from stock_docs where type = 'GR' and no = $1 for update`, [no])).rows[0];
  if (!g) throw E.notFound(`ไม่พบใบรับสินค้า ${no}`);
  if (g.void_at) throw E.conflict(`${no} ถูกยกเลิกแล้ว`);
  const bill = (await tx.query<{ id: string; no: string; paid: string; returned: string }>(
    `select id, no, paid::text, returned::text from ap_bills where gr_doc_id = $1 and status = 'active' for update`, [g.id])).rows[0];
  const pvs = bill ? (await tx.query<{ no: string }>(
    `select distinct p.no from ap_payment_allocs a join ap_payments p on p.id = a.payment_id where a.bill_id = $1 and p.status = 'active' order by p.no`, [bill.id])).rows : [];
  const prs = (await tx.query<{ no: string }>(`select no from vendor_returns where gr_doc_id = $1 order by no`, [g.id])).rows;
  if (pvs.length || prs.length || (bill && (d(bill.paid).gt(0) || d(bill.returned).gt(0)))) {
    throw E.downstreamFirst(`${no} จ่ายเงินหรือส่งคืนผู้ขายแล้ว ยกเลิกไม่ได้`, { docs: [...pvs, ...prs].map((x) => x.no) });
  }
  const lines = (await tx.query<{ product_id: string; name: string; base_qty: string; lot_id: string; lot_unit_cost: string; po_id: string | null }>(
    `select g.product_id, p.name, g.base_qty::text, g.lot_id::text, g.lot_unit_cost::text, g.po_id from gr_lines g join products p on p.id = g.product_id
      where g.gr_doc_id = $1 order by g.line_no`, [g.id])).rows;
  const lots = new Map((await tx.query<{ id: string; remaining: string; qty_in: string }>(
    `select id::text, remaining::text, qty_in::text from stock_lots where id = any($1::bigint[]) order by product_id, received_at, id for update`,
    [lines.map((l) => l.lot_id)])).rows.map((l) => [l.id, l]));
  const used = lines.filter((l) => { const lot = lots.get(l.lot_id); return !lot || d(lot.remaining).lt(d(lot.qty_in)); });
  if (used.length) {
    throw E.conflict(`สินค้าจาก ${no} ถูกขาย โอน หรือปรับยอดไปแล้ว ยกเลิกไม่ได้: ${used.map((l) => l.name).join(', ')}`, { reason: 'GR_LOTS_USED' });
  }
  const ref = { docType: 'GR', docNo: no, docId: g.id, note: `ยกเลิกใบรับสินค้า · ${reason}` };
  for (const l of lines) {
    const take = { lotId: l.lot_id, qty: l.base_qty, unitCost: l.lot_unit_cost };
    await applyOut(tx, ctx, g.warehouse_id, { productId: l.product_id, qty: l.base_qty, takes: [take], cogs: money(d(l.base_qty).times(d(l.lot_unit_cost))) }, ref);
  }
  await tx.query(`update stock_docs set void_at = now(), void_by = $2, void_reason = $3 where id = $1`, [g.id, ctx.userId, reason]);
  if (bill) await tx.query(`update ap_bills set status = 'void' where id = $1`, [bill.id]);
  const poIds = [...new Set(lines.flatMap((l) => (l.po_id ? [l.po_id] : [])))];
  for (const id of poIds) await refreshPoStatus(tx, id);
  const pos = poIds.length ? (await tx.query<{ no: string }>(`select no from purchase_orders where id = any($1::uuid[]) order by no`, [poIds])).rows.map((r) => r.no) : [];
  await writeAudit(tx, ctx, [{
    action: 'void', object: 'GR', ref: no,
    detail: `${reason} · ${lines.length} รายการ${g.total != null ? ` · ฿${fmtTHB(g.total)}` : ''}${bill ? ` · ยกเลิกบิลเจ้าหนี้ ${bill.no}` : ''}${pos.length ? ` · คืนยอดค้างรับ ${pos.join(', ')}` : ''}`,
  }]);
  return getReceipt(tx, ctx, no);
}
