import { d, money, round2, sum, Decimal, type Money, type Num } from './money';

export type VatMode = 'inc' | 'exc' | 'none';
export type LineVat = 'v7' | 'exempt';
export interface LineDiscount { kind: 'pct' | 'amt'; value: Num }
export interface DocLine { qty: Num; unitPrice: Num; discount?: LineDiscount | null; vat: LineVat }

export interface DocTotals {
  /** Sum of qty × unit price, before any discount. */
  gross: Money;
  /** Sum of line discounts. */
  lineDisc: Money;
  /** gross − lineDisc (the mockup's `sub`). */
  sub: Money;
  /** Shop bill discount actually applied (capped to sub − coupon). */
  billDisc: Money;
  /** SCG Family coupon actually applied (capped to sub). */
  coupon: Money;
  /** Value subject to 7% VAT (ex VAT). */
  base7: Money;
  /** Value exempt / 0% / non-VAT shop. */
  exempt: Money;
  vat: Money;
  /** Amount payable. base7 + exempt + vat === total, always. */
  total: Money;
  /** Per line: net after line discount, share of bill discount + coupon, and net after both. */
  lines: { net: Money; alloc: Money; after: Money }[];
}

const dz = new Decimal(0);

/** qty × unit price, rounded to the satang. */
export const lineGross = (l: Pick<DocLine, 'qty' | 'unitPrice'>): Decimal => round2(d(l.qty).times(d(l.unitPrice)));

/** Line discount amount: pct of gross (rounded) or fixed amount, clamped to [0, gross]. */
export function lineDiscount(l: Pick<DocLine, 'qty' | 'unitPrice' | 'discount'>): Decimal {
  const g = lineGross(l);
  if (!l.discount) return dz;
  const v = d(l.discount.value);
  const raw = l.discount.kind === 'pct' ? round2(g.times(v).div(100)) : round2(v);
  return Decimal.max(dz, Decimal.min(g, raw));
}

const lineNetD = (l: DocLine): Decimal => lineGross(l).minus(lineDiscount(l));

/** Line amount after line discount, before bill discount / VAT split. */
export const lineNet = (l: DocLine): Money => money(lineNetD(l));

/**
 * Split `amount` across `weights` pro-rata, each share rounded to the satang;
 * the rounding remainder goes on the last line with a non-zero weight so shares sum exactly.
 */
export function allocate(amount: Num, weights: readonly Num[]): Decimal[] {
  const total = sum(weights);
  const amt = d(amount);
  if (total.isZero()) return weights.map(() => dz);
  const shares = weights.map((w) => round2(amt.times(d(w)).div(total)));
  let last = -1;
  weights.forEach((w, i) => { if (!d(w).isZero()) last = i; });
  shares[last] = shares[last]!.plus(amt.minus(sum(shares)));
  return shares;
}

/**
 * Document totals (VAT modes, bill discount, SCG Family coupon).
 * - Coupon is capped to sub; bill discount to what is left (mockup `cartCalc`).
 * - Both are allocated across lines pro-rata to line net before the VAT split (mockup `calcDoc`).
 * - inc: prices include 7%; vat = round2(vatable × 7/107), base7 = vatable − vat.
 * - exc: prices are ex VAT; vat = round2(base7 × 7%).
 * - none: non-VAT shop, everything is `exempt`, vat 0.
 */
export function calcDoc(lines: readonly DocLine[], vatMode: VatMode, billDiscount: Num = 0, coupon: Num = 0): DocTotals {
  const gross = sum(lines.map(lineGross));
  const nets = lines.map(lineNetD);
  const sub = sum(nets);
  const cp = Decimal.min(sub, Decimal.max(dz, round2(coupon)));
  const bd = Decimal.min(sub.minus(cp), Decimal.max(dz, round2(billDiscount)));
  const allocs = allocate(cp.plus(bd), nets);
  const after = nets.map((n, i) => n.minus(allocs[i]!));

  let vatable = dz;
  let exempt = dz;
  lines.forEach((l, i) => {
    if (vatMode !== 'none' && l.vat === 'v7') vatable = vatable.plus(after[i]!);
    else exempt = exempt.plus(after[i]!);
  });

  let base7: Decimal, vat: Decimal, total: Decimal;
  if (vatMode === 'inc') {
    vat = round2(vatable.times(7).div(107));
    base7 = vatable.minus(vat);
    total = vatable.plus(exempt);
  } else if (vatMode === 'exc') {
    base7 = vatable;
    vat = round2(base7.times('0.07'));
    total = base7.plus(exempt).plus(vat);
  } else {
    base7 = dz;
    vat = dz;
    total = exempt;
  }

  return {
    gross: money(gross),
    lineDisc: money(gross.minus(sub)),
    sub: money(sub),
    billDisc: money(bd),
    coupon: money(cp),
    base7: money(base7),
    exempt: money(exempt),
    vat: money(vat),
    total: money(total),
    lines: nets.map((n, i) => ({ net: money(n), alloc: money(allocs[i]!), after: money(after[i]!) })),
  };
}
