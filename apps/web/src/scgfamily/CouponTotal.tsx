/** CLOUD ONLY. Totals row of the bill's member coupon, apart from the shop's own discounts (two cells of a .tot grid). */
import type { AppliedCoupon } from '../cloud';
import { fmt } from '../ui';

export default function CouponTotal({ coupon }: { coupon: AppliedCoupon }) {
  return (
    <>
      <span className="muted">คูปอง SCG Family <span className="mono small">{coupon.code}</span></span>
      <span className="disc" data-testid="t-coupon">−{fmt(coupon.amount)}</span>
    </>
  );
}
