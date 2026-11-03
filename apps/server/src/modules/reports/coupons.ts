/** REQ-M11-05: SCG Family coupons used, for the claim-back (cloud only, OQ-A2; loaded only by the cloud build). */
import type { Tx } from '@erp/db';
import { money, sum } from '@erp/core';
import { Sources, checkRange } from './sources';

export async function couponsReport(tx: Tx, from: string, to: string) {
  checkRange(from, to);
  const src = new Sources(tx);
  const sources = [await src.status('coupons', 'ยังไม่มีบิลที่ตัดคูปองผ่าน SCG Family (การเชื่อมต่อ M13 อยู่นอกขอบเขตรอบนี้)')];
  if (!(await src.has('coupons'))) return { from, to, rows: [], total: '0.00', sources };
  const r = await tx.query<{ bill_no: string; date: string; member_id: string; coupon_code: string; amount: string; redeem_ref: string }>(
    `select bill_no, date::text, member_id, coupon_code, amount::text, coalesce(redeem_ref, '') redeem_ref
       from rpt_coupon_redemptions where tenant_id = erp_current_tenant() and date between $1::date and $2::date order by date, bill_no`,
    [from, to],
  );
  const rows = r.rows.map((x) => ({ billNo: x.bill_no, date: x.date, memberId: x.member_id, couponCode: x.coupon_code, amount: money(x.amount), redeemRef: x.redeem_ref }));
  return { from, to, rows, total: money(sum(rows.map((x) => x.amount))), sources };
}
