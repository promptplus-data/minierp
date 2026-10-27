import { addDays } from './dates';
import { d, money, round2, sum, type Money, type Num } from './money';

/**
 * Project billing rules (M09): installment templates, schedules, per-installment amounts with deposit deduction.
 */

/** REQ-M09-07 templates; 'custom' means the caller passes its own percentages. */
export const INSTALLMENT_TEMPLATES = {
  '30/40/30': ['30', '40', '30'],
  '50/50': ['50', '50'],
  '100%': ['100'],
} as const;
export type InstallmentTemplate = keyof typeof INSTALLMENT_TEMPLATES | 'custom';

/** REQ-M09-04: every percentage > 0 and the total is exactly 100. */
export function validInstallmentPcts(pcts: readonly Num[]): boolean {
  if (!pcts.length) return false;
  if (pcts.some((p) => !d(p).gt(0))) return false;
  return sum(pcts).eq(100);
}

/** Default schedule: installment i is due `stepDays` × i after the start date. */
export function planInstallments(pcts: readonly Num[], startDate: string, stepDays = 30): { n: number; pct: string; dueDate: string }[] {
  return pcts.map((p, i) => ({ n: i + 1, pct: d(p).toFixed(), dueDate: addDays(startDate, stepDays * (i + 1)) }));
}

export interface InstallmentRow {
  pct: Num;
  /** Set when the installment already has an (active) invoice: the gross and deposit deduction it billed. */
  billed?: { gross: Num; deduct: Num } | null;
}

/**
 * Amount of installment `index` (REQ-M09-05): gross = value × pct; deposit deduction = deposit × pct.
 * The last installment still to bill takes the remainders, so the billed grosses add up to the value and the
 * deductions to the deposit exactly. Example: value 480,000, deposit 96,000, 40 % → 192,000 − 38,400 = 153,600.
 */
export function installmentAmount(value: Num, deposit: Num, rows: readonly InstallmentRow[], index: number): { gross: Money; deduct: Money; net: Money } {
  const row = rows[index];
  if (!row) throw new RangeError(`No installment #${index}`);
  const unbilled = rows.filter((r) => !r.billed);
  const isLast = !row.billed && unbilled.length === 1;
  let gross = round2(d(value).times(d(row.pct)).div(100));
  let deduct = round2(d(deposit).times(d(row.pct)).div(100));
  if (isLast) {
    gross = d(value).minus(sum(rows.filter((r) => r.billed).map((r) => r.billed!.gross)));
    deduct = d(deposit).minus(sum(rows.filter((r) => r.billed).map((r) => r.billed!.deduct)));
  }
  // never deduct more than is left of the deposit (it may have been forfeited or refunded in part)
  const left = d(deposit).minus(sum(rows.filter((r) => r.billed).map((r) => r.billed!.deduct)));
  if (deduct.gt(left)) deduct = left;
  if (deduct.gt(gross)) deduct = gross;
  if (deduct.lt(0)) deduct = d(0);
  return { gross: money(gross), deduct: money(deduct), net: money(gross.minus(deduct)) };
}
