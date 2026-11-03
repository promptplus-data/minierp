import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEAVE_ENTITLEMENT, deductibleDays, defaultEntitlement, labourCost, leaveBalances, leaveUsed, maskThaiId, overEntitlement,
  periodRange, periodTH, thaiIdValid, USERNAME_RE, type LeaveRecord,
} from './hr';

const ent = { ...DEFAULT_LEAVE_ENTITLEMENT };
const recs: LeaveRecord[] = [
  { type: 'sick', days: 2, status: 'approved', fromDate: '2026-10-06' },
  { type: 'sick', days: '0.5', status: 'approved', fromDate: '2026-03-01' },
  { type: 'sick', days: 5, status: 'rejected', fromDate: '2026-04-01' },
  { type: 'sick', days: 3, status: 'pending', fromDate: '2026-05-01' },
  { type: 'sick', days: 4, status: 'approved', fromDate: '2025-12-30' }, // previous year
  { type: 'personal', days: 3, status: 'approved', fromDate: '2026-02-02' },
];

describe('leave (REQ-M17-04/05)', () => {
  it('defaults follow the labour law: sick 30, personal 3, vacation 6 after one year, maternity 98', () => {
    expect(DEFAULT_LEAVE_ENTITLEMENT).toEqual({ sick: 30, personal: 3, vacation: 6, maternity: 98, other: 0 });
    expect(defaultEntitlement('2026-03-01', 2026).vacation).toBe(0);
    expect(defaultEntitlement('2025-03-01', 2026).vacation).toBe(6);
    expect(defaultEntitlement('2025-12-31', 2026).vacation).toBe(6);
  });
  it('counts only approved leave of the type in the year it starts, half days included', () => {
    expect(leaveUsed(recs, 'sick', 2026)).toBe('2.5');
    expect(leaveUsed(recs, 'sick', 2025)).toBe('4');
    const b = leaveBalances(ent, recs, 2026);
    expect(b.find((x) => x.type === 'sick')).toEqual({ type: 'sick', entitled: 30, used: '2.5', remaining: '27.5' });
    expect(b.find((x) => x.type === 'personal')!.remaining).toBe('0');
  });
  it('over-entitlement: days beyond what remains; unpaid leave is all over', () => {
    expect(overEntitlement(ent, recs, 'personal', 2, 2026)).toBe('2');
    expect(overEntitlement(ent, recs, 'sick', 28, 2026)).toBe('0.5');
    expect(overEntitlement(ent, recs, 'sick', 1, 2026)).toBe('0');
    expect(overEntitlement(ent, recs, 'unpaid', '1.5', 2026)).toBe('1.5');
    expect(overEntitlement({ ...ent, personal: 1 }, recs, 'personal', 1, 2026)).toBe('1'); // already beyond: remaining never negative
  });
  it('deductible days: unpaid always, over-entitlement only when deduct is chosen', () => {
    expect(deductibleDays({ type: 'unpaid', days: 2, overDays: 2, deduct: false })).toBe('2');
    expect(deductibleDays({ type: 'personal', days: 3, overDays: 1, deduct: true })).toBe('1');
    expect(deductibleDays({ type: 'personal', days: 3, overDays: 1, deduct: false })).toBe('0');
  });
});

describe('misc HR helpers', () => {
  it('Thai national ID checksum and mask', () => {
    expect(thaiIdValid('1101700207030')).toBe(true);
    expect(thaiIdValid('1-1017-00207-03-0')).toBe(true);
    expect(thaiIdValid('1101700207031')).toBe(false);
    expect(thaiIdValid('12345')).toBe(false);
    expect(maskThaiId('1101700207030')).toBe('x-xxxx-xxxxx-03-0');
    expect(maskThaiId('')).toBe('');
  });
  it('periods', () => {
    expect(periodRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('2028-02').to).toBe('2028-02-29');
    expect(periodRange('2026-10').to).toBe('2026-10-31');
    expect(() => periodRange('2026-13')).toThrow();
    expect(periodTH('2026-10')).toBe('ต.ค. 2569');
  });
  it('labour cost = gross + employer SSO (equal to the employee share)', () => {
    expect(labourCost([{ gross: '28000.00', sso: '875.00' }, { gross: '13500', sso: '675' }])).toEqual({ gross: '41500.00', employerSso: '1550.00', total: '43050.00' });
  });
  it('username rule', () => {
    expect(USERNAME_RE.test('prae.k_2')).toBe(true);
    expect(USERNAME_RE.test('ab')).toBe(false);
    expect(USERNAME_RE.test('Prae')).toBe(false);
  });
});
