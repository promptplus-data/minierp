import { d, money, round2, Decimal, type Money, type Num } from './money';
import { addDays, dayOfWeek } from './dates';

export interface PayrollConfig {
  /** Employee social-security rate, default 0.05. */
  ssoRate: Num;
  /** Wage ceiling for SSO, default 17,500. */
  ssoCap: Num;
  /** Wage floor for SSO, default 1,650 (mockup). */
  ssoFloor?: Num;
}
export const DEFAULT_PAYROLL_CONFIG: PayrollConfig = { ssoRate: '0.05', ssoCap: 17500, ssoFloor: 1650 };

export interface Employee {
  /** monthly = salaried; daily covers daily and part-time staff. */
  pay: 'monthly' | 'daily';
  salary?: Num;
  dailyRate?: Num;
  /** Enrolled in social security. */
  sso: boolean;
  /** Commission % of the employee's sales ex VAT. */
  commissionPct?: Num;
}

export interface PayInputs {
  /** Days worked (daily staff). Default 26. */
  days?: Num;
  ot?: Num;
  allowance?: Num;
  /** Salary advance to deduct. */
  advance?: Num;
  /** Manual withholding tax; when absent `estTax` is used. */
  tax?: Num | null;
  /** Approved unpaid leave days this month (monthly staff only; deducted at salary/30 per day). */
  unpaidLeaveDays?: Num;
  /** Sales ex VAT (base7 + exempt of the employee's invoices this month). */
  commissionBase?: Num;
}

export interface PayRow {
  base: Money; ot: Money; allowance: Money; commission: Money; unpaidAmt: Money;
  gross: Money; sso: Money; tax: Money; advance: Money; net: Money;
}

const BRACKETS: [number, string][] = [
  [150000, '0'], [300000, '0.05'], [500000, '0.10'], [750000, '0.15'],
  [1000000, '0.20'], [2000000, '0.25'], [5000000, '0.30'], [Infinity, '0.35'],
];

/**
 * Monthly withholding estimate (mockup `estTax`): annualise, deduct 50% expenses (max 100,000),
 * personal allowance 60,000 and SSO, apply PIT brackets, divide by 12, round to whole baht.
 */
export function estTax(monthlyIncome: Num, monthlySso: Num): Money {
  const y = d(monthlyIncome).times(12);
  const inc = y.minus(Decimal.min(y.times('0.5'), 100000)).minus(60000).minus(d(monthlySso).times(12));
  let t = new Decimal(0);
  let lo = new Decimal(0);
  for (const [hiN, r] of BRACKETS) {
    const hi = hiN === Infinity ? inc : new Decimal(hiN);
    if (inc.gt(lo)) t = t.plus(Decimal.min(inc, hi).minus(lo).times(r));
    if (hiN === Infinity) break;
    lo = hi;
  }
  return money(Decimal.max(0, t).div(12).toDecimalPlaces(0, Decimal.ROUND_HALF_UP));
}

/** One payroll row (mockup `payRow`). */
export function payRow(emp: Employee, inp: PayInputs = {}, cfg: PayrollConfig = DEFAULT_PAYROLL_CONFIG): PayRow {
  const daily = emp.pay === 'daily';
  const days = inp.days != null ? d(inp.days) : new Decimal(26);
  const base = round2(daily ? d(emp.dailyRate).times(days) : d(emp.salary));
  const unpaidAmt = daily ? new Decimal(0) : round2(d(inp.unpaidLeaveDays).times(d(emp.salary)).div(30));
  const commission = round2(d(inp.commissionBase).times(d(emp.commissionPct)).div(100));
  const ot = d(inp.ot), allowance = d(inp.allowance), advance = d(inp.advance);
  const gross = round2(base.plus(ot).plus(allowance).plus(commission).minus(unpaidAmt));
  const sso = emp.sso
    ? Decimal.min(Decimal.max(gross, d(cfg.ssoFloor ?? 0)), d(cfg.ssoCap)).times(d(cfg.ssoRate)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    : new Decimal(0);
  const tax = inp.tax != null && inp.tax !== '' ? d(inp.tax) : d(estTax(gross, sso));
  return {
    base: money(base), ot: money(ot), allowance: money(allowance), commission: money(commission),
    unpaidAmt: money(unpaidAmt), gross: money(gross), sso: money(sso), tax: money(tax), advance: money(advance),
    net: money(gross.minus(sso).minus(tax).minus(advance)),
  };
}

/** Leave days between two dates inclusive, Sundays excluded; half-day leave = 0.5 (mockup `leaveDays`). */
export function leaveDays(from: string, to: string, half = false): number {
  if (half) return 0.5;
  let n = 0;
  for (let x = from; x <= to; x = addDays(x, 1)) if (dayOfWeek(x) !== 0) n++;
  return n;
}
