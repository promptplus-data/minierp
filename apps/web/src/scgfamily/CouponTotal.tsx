/**
 * CLOUD ONLY. The member coupon's own totals row, apart from the shop's discounts (spec §7): two cells of a .tot
 * grid (cart, sales-order form, document page) or receipt rows (`slip`) with the member id line.
 */
import { fmt } from '../ui';

export default function CouponTotal({ coupon, slip }: { coupon: { code: string; amount: string; memberId?: string }; slip?: boolean }) {
  if (slip) {
    return (
      <>
        <div className="r"><span>คูปอง SCG Family {coupon.code}</span><span data-testid="slip-coupon">−{fmt(coupon.amount)}</span></div>
        {coupon.memberId && <div className="r"><span>สมาชิก SCG Family</span><span>{coupon.memberId}</span></div>}
      </>
    );
  }
  return (
    <>
      <span className="muted">คูปอง SCG Family <span className="mono small">{coupon.code}</span></span>
      <span className="disc" data-testid="t-coupon">−{fmt(coupon.amount)}</span>
    </>
  );
}
