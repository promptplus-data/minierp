import { d, money, Decimal, type Num } from './money';

/**
 * A return / credit note against a bill that is still owed (credit invoice or POS credit bill): the credit first
 * reduces what is still owed on that bill, never below zero; the rest (`over`) goes back to the customer as money
 * (cash / transfer) or as a customer credit.
 */
export function returnArSplit(total: Num, arBalance: Num): { toAr: string; over: string } {
  const t = d(total);
  const owed = Decimal.max(0, d(arBalance));
  const toAr = Decimal.min(t, owed);
  return { toAr: money(toAr), over: money(t.minus(toAr)) };
}
