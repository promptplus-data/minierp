import { addDays, parseISODate } from './dates';
import { allocate } from './vat';
import { d, money, round2, sum, Decimal, type Money, type Num } from './money';

/**
 * Accounts receivable rules (M10): aging buckets, withholding tax on receipts, VAT split of lump-sum documents.
 * Dates are 'YYYY-MM-DD'; money comes back as 2 dp strings.
 */

/** REQ-M10-04 buckets: not yet due, then days past the due date. */
export const AGING_BUCKETS = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'over90'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
export const AGING_LABEL_TH: Record<AgingBucket, string> = {
  notDue: 'ยังไม่ครบกำหนด', d1_30: 'เกิน 1–30 วัน', d31_60: 'เกิน 31–60 วัน', d61_90: 'เกิน 61–90 วัน', over90: 'เกิน 90 วัน',
};

const dayNo = (iso: string): number => {
  const { y, m, d: dd } = parseISODate(iso);
  return Date.UTC(y, m - 1, dd) / 86_400_000;
};

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => dayNo(to) - dayNo(from);

/** Days past due on `asOf` (0 when not yet due). */
export const daysOverdue = (dueDate: string, asOf: string): number => Math.max(0, daysBetween(dueDate, asOf));

export function agingBucket(dueDate: string, asOf: string): AgingBucket {
  const o = daysOverdue(dueDate, asOf);
  if (o === 0) return 'notDue';
  if (o <= 30) return 'd1_30';
  if (o <= 60) return 'd31_60';
  if (o <= 90) return 'd61_90';
  return 'over90';
}

/** REQ-M10-05: due on or before asOf + days but not yet overdue. */
export const isDueWithin = (dueDate: string, asOf: string, days: number): boolean => dueDate >= asOf && dueDate <= addDays(asOf, days);

/**
 * Pre-VAT part of an amount settled on an invoice: settled × (total − vat) / total.
 * WHT is computed on the value before VAT (REQ-M10-03).
 */
export function preVatShare(settled: Num, invoiceTotal: Num, invoiceVat: Num): Decimal {
  const t = d(invoiceTotal);
  if (t.isZero()) return round2(settled);
  return round2(d(settled).times(t.minus(d(invoiceVat))).div(t));
}

export type WhtInput = { mode: 'none' } | { mode: 'rate'; rate: Num } | { mode: 'amount'; amount: Num };
export interface SettleLine { settled: Num; invoiceTotal: Num; invoiceVat: Num }
export interface ReceiptTotals {
  /** Sum cut from the receivables. */
  settled: Money;
  /** Pre-VAT base of the settled amounts. */
  whtBase: Money;
  wht: Money;
  /** Money actually received: settled − wht. cash + wht = settled, always. */
  cash: Money;
  lines: { whtBase: Money; wht: Money }[];
}

export class WhtError extends Error {}

/**
 * Receipt totals with withholding tax. `rate` (1 or 3 %) is applied per line on its pre-VAT share and summed;
 * `amount` (typed by the user) is allocated across the lines pro-rata to their pre-VAT shares.
 */
export function receiptTotals(lines: readonly SettleLine[], wht: WhtInput): ReceiptTotals {
  const bases = lines.map((l) => preVatShare(l.settled, l.invoiceTotal, l.invoiceVat));
  let whts: Decimal[];
  if (wht.mode === 'rate') {
    const r = d(wht.rate);
    if (r.lt(0) || r.gt(100)) throw new WhtError('WHT rate must be 0..100');
    whts = bases.map((b) => round2(b.times(r).div(100)));
  } else if (wht.mode === 'amount') {
    const a = round2(wht.amount);
    if (a.lt(0)) throw new WhtError('WHT amount must not be negative');
    if (a.gt(sum(bases))) throw new WhtError('WHT amount is more than the pre-VAT base');
    whts = allocate(a, bases);
  } else {
    whts = bases.map(() => new Decimal(0));
  }
  const settled = sum(lines.map((l) => l.settled));
  const w = sum(whts);
  return {
    settled: money(settled), whtBase: money(sum(bases)), wht: money(w), cash: money(settled.minus(w)),
    lines: bases.map((b, i) => ({ whtBase: money(b), wht: money(whts[i]!) })),
  };
}

/**
 * VAT split of a lump-sum amount (deposits, installment invoices). inc: the amount includes 7 %;
 * none: non-VAT shop. Returns base7 + vat = total.
 */
export function splitInclusive(total: Num, vatMode: 'inc' | 'none'): { base7: Money; exempt: Money; vat: Money; total: Money } {
  const t = round2(total);
  if (vatMode === 'none') return { base7: '0.00', exempt: money(t), vat: '0.00', total: money(t) };
  const vat = round2(t.times(7).div(107));
  return { base7: money(t.minus(vat)), exempt: '0.00', vat: money(vat), total: money(t) };
}
