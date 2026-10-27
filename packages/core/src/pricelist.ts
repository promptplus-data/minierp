import { d, type Num } from './money';

/**
 * BR-05 price list lookup (steps 2 and 3): an item matches the product and unit; among the matches the one with
 * the highest minQty that is still <= qty wins (quantity breaks of a group list). A customer list normally has
 * minQty 0 on every item.
 */
export interface PriceListItem { productId: string; unitIdx: number; minQty: Num; price: Num }

export function pickListPrice<T extends PriceListItem>(items: readonly T[], productId: string, unitIdx: number, qty: Num): T | null {
  let best: T | null = null;
  for (const it of items) {
    if (it.productId !== productId || it.unitIdx !== unitIdx) continue;
    if (d(it.minQty).gt(d(qty))) continue;
    if (!best || d(it.minQty).gt(d(best.minQty))) best = it;
  }
  return best;
}

/** A list is usable on `date` when active and date is inside [validFrom, validTo] (open ends allowed). */
export const listValidOn = (l: { active: boolean; validFrom: string | null; validTo: string | null }, date: string): boolean =>
  l.active && (!l.validFrom || l.validFrom <= date) && (!l.validTo || date <= l.validTo);
