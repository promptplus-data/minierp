import { d, money, round2, sum, type Money, type Num } from './money';
import { allocate } from './vat';

export interface BundleComponent { productId: string; qtyPerSet: Num; normalPrice: Num }
export interface BundleAllocation { productId: string; qty: string; amount: Money }

/**
 * BR-17: split a bundle's revenue across its components pro-rata to normal price × qty per set.
 * Each share is rounded to the satang; the remainder lands on the last component.
 * `bundlePrice` is per set; revenue = sets × bundlePrice.
 */
export function bundleAlloc(components: readonly BundleComponent[], sets: Num, bundlePrice: Num): BundleAllocation[] {
  const revenue = round2(d(sets).times(d(bundlePrice)));
  const weights = components.map((c) => d(c.normalPrice).times(d(c.qtyPerSet)));
  // All-zero normal prices: fall back to equal weights so revenue is never lost.
  const w = sum(weights).isZero() ? components.map(() => d(1)) : weights;
  const shares = allocate(revenue, w);
  return components.map((c, i) => ({
    productId: c.productId,
    qty: d(c.qtyPerSet).times(d(sets)).toFixed(),
    amount: money(shares[i]!),
  }));
}
