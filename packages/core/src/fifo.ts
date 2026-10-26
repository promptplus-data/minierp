import { d, money, qty4, sum, Decimal, type Money, type Num } from './money';

export interface Lot { id: string; receivedAt: string; qty: Num; unitCost: Num }
export interface LotTake { lotId: string; qty: string; unitCost: string }

/** BR-07: stock may never go negative. */
export class InsufficientStockError extends Error {
  readonly need: string;
  readonly have: string;
  constructor(need: Num, have: Num) {
    super(`Insufficient stock: need ${qty4(need)}, have ${qty4(have)}`);
    this.name = 'InsufficientStockError';
    this.need = qty4(need);
    this.have = qty4(have);
  }
}

const byAge = (a: Lot, b: Lot): number =>
  a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : a.id.localeCompare(b.id, 'en', { numeric: true });

/**
 * FIFO issue: consume lots oldest first (receivedAt, then id).
 * Pure: returns what to take; the caller decrements the lots.
 * Throws InsufficientStockError when the lots do not cover qty (BR-07).
 */
export function takeLots(lots: readonly Lot[], qty: Num): { takes: LotTake[]; cogs: Money } {
  const need = d(qty);
  if (need.isNegative()) throw new RangeError('qty must be >= 0');
  const live = lots.filter((l) => d(l.qty).gt(0)).sort(byAge);
  const have = sum(live.map((l) => l.qty));
  if (have.lt(need)) throw new InsufficientStockError(need, have);

  const takes: LotTake[] = [];
  let rest = need;
  let cogs = new Decimal(0);
  for (const l of live) {
    if (rest.lte(0)) break;
    const t = Decimal.min(rest, d(l.qty));
    takes.push({ lotId: l.id, qty: qty4(t), unitCost: qty4(l.unitCost) });
    cogs = cogs.plus(t.times(d(l.unitCost)));
    rest = rest.minus(t);
  }
  return { takes, cogs: money(cogs) };
}

/**
 * Moving-average cost after a receipt (mockup `stockIn`).
 * Negative prior quantity is treated as 0. Result rounded to 4 dp.
 */
export function movingAverage(prevQty: Num, prevCost: Num, inQty: Num, inCost: Num): string {
  const old = Decimal.max(0, d(prevQty));
  const q = d(inQty);
  const tot = old.plus(q);
  if (tot.lte(0)) return qty4(inCost);
  return qty4(d(prevCost).times(old).plus(d(inCost).times(q)).div(tot));
}
