import { d, qty4, Decimal, type Num } from './money';
import { lineNet, type DocLine, type VatMode } from './vat';

export interface BelowCostItem { netUnitExVat: Num; unitCost: Num | null | undefined }

/** Tolerance from the mockup: a line is below cost only if it is more than half a satang under. */
const TOL = new Decimal('0.005');

/**
 * BR-16 below-cost check. Returns indexes of offending lines.
 * Products with no cost (null / 0) are not checked.
 */
export function checkBelowCost(items: readonly BelowCostItem[]): number[] {
  const out: number[] = [];
  items.forEach((it, i) => {
    if (it.unitCost == null || !d(it.unitCost).gt(0)) return;
    if (d(it.netUnitExVat).lt(d(it.unitCost).minus(TOL))) out.push(i);
  });
  return out;
}

/**
 * Net selling price per unit used by BR-16: after line discount and the shop bill discount,
 * before VAT, EXCLUDING the SCG Family coupon (mockup `belowCost`).
 * `baseQty` lets the caller pass qty in base units when the line is sold in a pack unit.
 * Returns 4 dp strings; lines with qty <= 0 return null.
 */
export function netUnitPricesExVat(
  lines: readonly (DocLine & { baseQty?: Num })[],
  vatMode: VatMode,
  billDiscount: Num = 0,
): (string | null)[] {
  const nets = lines.map((l) => d(lineNet(l)));
  const sub = nets.reduce((a, n) => a.plus(n), new Decimal(0));
  const k = sub.gt(0) ? Decimal.max(0, new Decimal(1).minus(d(billDiscount).div(sub))) : new Decimal(1);
  return lines.map((l, i) => {
    const q = d(l.baseQty ?? l.qty);
    if (!q.gt(0)) return null;
    let sp = nets[i]!.times(k).div(q);
    if (vatMode === 'inc' && l.vat === 'v7') sp = sp.div('1.07');
    return qty4(sp);
  });
}
