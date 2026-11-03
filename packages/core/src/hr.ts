/**
 * HR rules for M17 that are not payroll math (payRow lives in payroll.ts): leave types and yearly entitlements
 * (defaults per the Thai Labour Protection Act), leave balance / over-entitlement, unpaid-day deduction days,
 * Thai national ID check, payroll periods and labour cost.
 */
import { d, money, sum, Decimal, type Money, type Num } from './money';

/** Leave types with an entitlement. 'unpaid' is recorded too (mockup) but has no entitlement and is always deducted. */
export const LEAVE_TYPES = ['sick', 'personal', 'vacation', 'maternity', 'other'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];
export type LeaveKind = LeaveType | 'unpaid';
export type LeaveEntitlement = Record<LeaveType, number>;

export const LEAVE_TH: Record<LeaveKind, string> = {
  sick: 'ลาป่วย', personal: 'ลากิจ', vacation: 'พักร้อน', maternity: 'ลาคลอด', other: 'ลาอื่น ๆ', unpaid: 'ลาไม่รับค่าจ้าง',
};

/**
 * Defaults per the Labour Protection Act: sick leave paid up to 30 working days a year (s.32/57), personal business
 * leave at least 3 days (s.34), annual vacation at least 6 working days after one year of service (s.30), maternity
 * leave 98 days (s.41, as amended 2023). The shop may grant more per employee.
 */
export const DEFAULT_LEAVE_ENTITLEMENT: Readonly<LeaveEntitlement> = { sick: 30, personal: 3, vacation: 6, maternity: 98, other: 0 };

/** Entitlement for a new employee: vacation only after one year of service at the start of the given year. */
export function defaultEntitlement(startDate: string, year: number): LeaveEntitlement {
  const anniversary = `${Number(startDate.slice(0, 4)) + 1}${startDate.slice(4, 10)}`;
  return { ...DEFAULT_LEAVE_ENTITLEMENT, vacation: anniversary <= `${year}-12-31` ? DEFAULT_LEAVE_ENTITLEMENT.vacation : 0 };
}

export interface LeaveRecord { type: LeaveKind; days: Num; status: 'pending' | 'approved' | 'rejected'; fromDate: string }

/** Approved days used of one type in one calendar year (counted in the year the leave starts). */
export function leaveUsed(records: readonly LeaveRecord[], type: LeaveKind, year: number): string {
  return sum(records.filter((r) => r.type === type && r.status === 'approved' && r.fromDate.startsWith(`${year}-`)).map((r) => r.days)).toString();
}

export interface LeaveBalance { type: LeaveType; entitled: number; used: string; remaining: string }

export function leaveBalances(ent: LeaveEntitlement, records: readonly LeaveRecord[], year: number): LeaveBalance[] {
  return LEAVE_TYPES.map((type) => {
    const used = leaveUsed(records, type, year);
    return { type, entitled: ent[type], used, remaining: d(ent[type]).minus(used).toString() };
  });
}

/**
 * Days of a new leave beyond the remaining entitlement (0 when within it). Unpaid leave has no entitlement, so all
 * of it is "over" and is always deducted.
 */
export function overEntitlement(ent: LeaveEntitlement, records: readonly LeaveRecord[], type: LeaveKind, days: Num, year: number): string {
  if (type === 'unpaid') return d(days).toString();
  const remaining = Decimal.max(0, d(ent[type]).minus(leaveUsed(records, type, year)));
  return Decimal.max(0, d(days).minus(remaining)).toString();
}

/** Unpaid days a leave contributes to payroll: all of an unpaid leave, the over-entitlement part when deduct is chosen. */
export function deductibleDays(l: { type: LeaveKind; days: Num; overDays: Num; deduct: boolean }): string {
  if (l.type === 'unpaid') return d(l.days).toString();
  return l.deduct ? d(l.overDays).toString() : '0';
}

/** Thai national ID: 13 digits, last digit = (11 - Σ d[i]·(13-i) mod 11) mod 10. */
export function thaiIdValid(id: string): boolean {
  const s = id.replace(/[\s-]/g, '');
  if (!/^\d{13}$/.test(s)) return false;
  let t = 0;
  for (let i = 0; i < 12; i++) t += Number(s[i]) * (13 - i);
  return (11 - (t % 11)) % 10 === Number(s[12]);
}

/** Masked national ID for screens without HR salary permission: x-xxxx-xxxxx-12-3. */
export const maskThaiId = (id: string): string => {
  const s = id.replace(/[\s-]/g, '');
  return s.length === 13 ? `x-xxxx-xxxxx-${s.slice(10, 12)}-${s[12]}` : s ? 'xxxx' : '';
};

/** 'YYYY-MM' → first and last calendar day. */
export function periodRange(period: string): { from: string; to: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new RangeError(`bad payroll period ${period}`);
  const [y, m] = period.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
}

const MON_TH = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
/** '2026-10' → 'ต.ค. 2569' (mockup monTH). */
export const periodTH = (period: string): string => `${MON_TH[Number(period.slice(5, 7))]} ${Number(period.slice(0, 4)) + 543}`;

/** Employer social security equals the employee contribution (5% of the capped wage), so labour cost = gross + SSO. */
export function labourCost(rows: readonly { gross: Num; sso: Num }[]): { gross: Money; employerSso: Money; total: Money } {
  const gross = sum(rows.map((r) => r.gross));
  const er = sum(rows.map((r) => r.sso));
  return { gross: money(gross), employerSso: money(er), total: money(gross.plus(er)) };
}

/** Username rule of REQ-M01-10: a–z 0–9 . _ , 3–20 characters. */
export const USERNAME_RE = /^[a-z0-9._]{3,20}$/;
