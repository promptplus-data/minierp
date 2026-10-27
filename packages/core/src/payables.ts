/**
 * M18 payables (accounts payable) rules: purchase bill totals with a separate bill discount (BR-19),
 * withholding tax on payments, AP aging buckets, vendor-return amounts. Pure, no clock.
 */
import { addDays, parseISODate } from './dates';
import { d, money, round2, sum, type Money, type Num } from './money';

export type BillDiscountMode = 'sep' | 'alloc';

export interface PurchaseBill { base: Money; discount: Money; net: Money; vat: Money; total: Money }

/**
 * REQ-M05-08 / REQ-M18-01: AP and input VAT come from the amount AFTER the bill discount, whatever the
 * discount mode (the mode only decides whether lot cost is reduced). 10,000 − 300, VAT shop → 10,379.00.
 */
export function purchaseBill(lineAmounts: readonly Num[], billDiscount: Num, vatRegistered: boolean): PurchaseBill {
  const base = round2(sum(lineAmounts));
  const disc = round2(billDiscount);
  if (disc.lt(0) || disc.gt(base)) throw new RangeError('bill discount must be between 0 and the bill total');
  const net = base.minus(disc);
  const vat = vatRegistered ? round2(net.times('0.07')) : d(0);
  return { base: money(base), discount: money(disc), net: money(net), vat: money(vat), total: money(net.plus(vat)) };
}

/** Rates the payment voucher offers (REQ-M03-08): none, 1% transport, 3% service. */
export const WHT_RATES = [0, 1, 3] as const;
export type WhtRate = (typeof WHT_RATES)[number];

/**
 * Withholding tax on a payment (mockup apPayModal): the rate applies to the amount before VAT when the shop is
 * VAT registered (the bills carry 7% VAT), else to the amount paid.
 */
export function whtAmount(paid: Num, rate: number, vatRegistered: boolean): Money {
  if (!WHT_RATES.includes(rate as WhtRate)) throw new RangeError(`unsupported WHT rate ${rate}`);
  if (rate === 0) return '0.00';
  const base = vatRegistered ? d(paid).div('1.07') : d(paid);
  return money(base.times(rate).div(100));
}

/** Days from a due date to today (positive = overdue). */
export function daysOverdue(due: string, today: string): number {
  const a = parseISODate(due);
  const b = parseISODate(today);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 864e5);
}

export type AgingBucket = 'current' | 'd1_30' | 'd31_60' | 'over60';
export const AGING_TH: Record<AgingBucket, string> = { current: 'ยังไม่ครบกำหนด', d1_30: 'เกิน 1–30 วัน', d31_60: 'เกิน 31–60 วัน', over60: 'เกิน 60 วัน' };

/** REQ-M18-04 buckets: not yet due / 1–30 / 31–60 / > 60 days overdue. */
export function agingBucket(due: string, today: string): AgingBucket {
  const n = daysOverdue(due, today);
  if (n <= 0) return 'current';
  if (n <= 30) return 'd1_30';
  if (n <= 60) return 'd31_60';
  return 'over60';
}

/** Sums open balances per bucket. */
export function agingSummary(bills: readonly { due: string; balance: Num }[], today: string): Record<AgingBucket, Money> {
  const acc: Record<AgingBucket, ReturnType<typeof d>> = { current: d(0), d1_30: d(0), d31_60: d(0), over60: d(0) };
  for (const b of bills) {
    if (!d(b.balance).gt(0)) continue;
    const k = agingBucket(b.due, today);
    acc[k] = acc[k].plus(d(b.balance));
  }
  return { current: money(acc.current), d1_30: money(acc.d1_30), d31_60: money(acc.d31_60), over60: money(acc.over60) };
}

/** Due within the next `days` days (inclusive of today), not yet overdue: the home-page card. */
export const dueWithin = (due: string, today: string, days = 7): boolean => due >= today && due <= addDays(today, days);

/**
 * Vendor return (REQ-M18-03): value at the GR purchase price (before bill discount) plus VAT. The AP bill is
 * reduced by at most its open balance; anything above is an unapplied vendor credit.
 */
export function vendorReturnAmounts(lines: readonly { qty: Num; unitPrice: Num }[], vatRegistered: boolean, billBalance: Num) {
  const base = round2(sum(lines.map((l) => round2(d(l.qty).times(d(l.unitPrice))))));
  const vat = vatRegistered ? round2(base.times('0.07')) : d(0);
  const total = base.plus(vat);
  const bal = d(billBalance).lt(0) ? d(0) : d(billBalance);
  const applied = total.lt(bal) ? total : bal;
  return { base: money(base), vat: money(vat), total: money(total), applied: money(applied), unapplied: money(total.minus(applied)) };
}

/** Per-bill payment allocation check: every amount > 0 and ≤ the bill's open balance. */
export function checkAllocations(allocs: readonly { billNo: string; amount: Num; balance: Num }[]): string | null {
  if (!allocs.length) return 'no bills selected';
  for (const a of allocs) {
    if (!d(a.amount).gt(0)) return `${a.billNo}: amount must be > 0`;
    if (d(a.amount).gt(d(a.balance))) return `${a.billNo}: amount ${money(a.amount)} exceeds the open balance ${money(a.balance)}`;
  }
  return null;
}
