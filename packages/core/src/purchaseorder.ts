import { d, qty4, Decimal, type Num } from './money';

export type PoStatus = 'open' | 'partial' | 'received' | 'closed' | 'void';

/**
 * Status of a purchase order from what its lines ordered and what active goods receipts took (base units).
 * A closed (short-shipped, closed by hand) or void order keeps its status whatever is received or rolled back.
 */
export function poStatus(current: PoStatus, lines: readonly { qty: Num; received: Num }[]): PoStatus {
  if (current === 'closed' || current === 'void') return current;
  if (lines.length && lines.every((l) => d(l.received).gte(d(l.qty)))) return 'received';
  return lines.some((l) => d(l.received).gt(0)) ? 'partial' : 'open';
}

/**
 * Quantity to order for a sales line: what the customer ordered minus what the warehouse can still give
 * (available below zero counts as zero) minus what is already on order and not yet received, never below zero.
 * Received goods are already inside `available`, so `onOrder` must be the unreceived part only.
 */
export function poShortfall(ordered: Num, available: Num, onOrder: Num = 0): string {
  return qty4(Decimal.max(0, d(ordered).minus(Decimal.max(0, d(available))).minus(Decimal.max(0, d(onOrder)))));
}

/** Base qty a receipt takes beyond what a PO line still waits for (0 when within). */
export function poOverQty(ordered: Num, received: Num, taking: Num): string {
  return qty4(Decimal.max(0, d(received).plus(d(taking)).minus(d(ordered))).minus(Decimal.max(0, d(received).minus(d(ordered)))));
}
