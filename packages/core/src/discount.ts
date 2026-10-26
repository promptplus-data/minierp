import { d, round4, type Num } from './money';

/** Default discount cap for the cashier role (OQ-10): 0%. */
export const CASHIER_DISC_CAP = 0;

/** Discount as % of gross, 4 dp. Gross 0 → "0". */
export function discountPct(gross: Num, discount: Num): string {
  const g = d(gross);
  if (g.isZero()) return '0';
  return round4(d(discount).div(g).times(100)).toFixed();
}

/** True when pct is above the role's cap (approval needed). */
export const exceedsCap = (pct: Num, capPct: Num): boolean => d(pct).gt(d(capPct));
