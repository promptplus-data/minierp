import { d, qty4, round4, sum, Decimal, type Num } from './money';

/** How a goods receipt costs its free lines (ของแถม): 0 (default) or the paid money spread by market value. */
export type FreeGoodsCosting = 'zero' | 'allocate';

export interface FreeAllocLine {
  /** What this line costs after the bill discount (0 for a free line). */
  paid: Num;
  /** Market value of the line: qty × invoice cost for a paid line, qty × market unit price for a free line. */
  market: Num;
  /** Quantity in base units (lot quantity). */
  baseQty: Num;
}

export interface FreeAllocResult {
  /** Cost of the line after the spread, 4 dp. The amounts sum exactly to the paid total. */
  amount: string;
  /** Lot unit cost per base unit, 4 dp. */
  unitCost: string;
}

/**
 * Relative market value costing of free goods on a receipt: the money actually paid (sum of `paid`) is spread over
 * every line, paid and free, in proportion to `market`. Amounts round to 4 dp with the residual on the line with the
 * largest market value; unit costs round to 4 dp and the largest line takes the unit-cost residual too, so
 * Σ unitCost × baseQty equals the paid total whenever the largest line's quantity allows it (else within 0.00005 × its qty).
 * When the market values sum to 0 every line keeps its own paid amount.
 */
export function allocateFreeGoods(lines: readonly FreeAllocLine[]): FreeAllocResult[] {
  if (lines.some((l) => d(l.market).lt(0) || d(l.paid).lt(0))) throw new Error('allocateFreeGoods: negative value');
  if (lines.some((l) => !d(l.baseQty).gt(0))) throw new Error('allocateFreeGoods: base qty must be > 0');
  const total = sum(lines.map((l) => l.paid));
  const mkt = sum(lines.map((l) => l.market));
  const unit = (amt: Decimal, q: Num) => qty4(amt.div(d(q)));
  if (mkt.isZero()) return lines.map((l) => ({ amount: qty4(l.paid), unitCost: unit(d(l.paid), l.baseQty) }));
  let big = 0;
  lines.forEach((l, i) => { if (d(l.market).gt(d(lines[big]!.market))) big = i; });
  const amounts = lines.map((l) => round4(total.times(d(l.market)).div(mkt)));
  amounts[big] = amounts[big]!.plus(total.minus(sum(amounts)));
  const units = lines.map((l, i) => d(unit(amounts[i]!, l.baseQty)));
  const others = sum(lines.map((l, i) => (i === big ? 0 : units[i]!.times(d(l.baseQty)))));
  units[big] = round4(total.minus(others).div(d(lines[big]!.baseQty)));
  return lines.map((_, i) => ({ amount: qty4(amounts[i]!), unitCost: qty4(units[i]!) }));
}
