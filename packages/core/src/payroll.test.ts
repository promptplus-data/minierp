import { describe, expect, it } from 'vitest';
import { estTax, leaveDays, payRow } from './payroll';

describe('payRow', () => {
  it('monthly salary above SSO cap → SSO 875', () => {
    const r = payRow({ pay: 'monthly', salary: 25000, sso: true });
    expect(r.sso).toBe('875.00');
    expect(r.gross).toBe('25000.00');
    expect(r.tax).toBe(estTax(25000, 875));
    expect(r.net).toBe((25000 - 875 - +r.tax).toFixed(2));
  });
  it('daily staff: rate × days (default 26), OT, allowance, advance', () => {
    const r = payRow({ pay: 'daily', dailyRate: 400, sso: true }, { ot: 500, allowance: 300, advance: 1000 });
    expect(r.base).toBe('10400.00');
    expect(r.gross).toBe('11200.00');
    expect(r.sso).toBe('560.00');
    expect(r.tax).toBe('0.00');
    expect(r.net).toBe('9640.00');
    expect(payRow({ pay: 'daily', dailyRate: 400, sso: false }, { days: 20 }).base).toBe('8000.00');
  });
  it('commission, unpaid leave (salary/30 per day), manual tax override', () => {
    const r = payRow({ pay: 'monthly', salary: 15000, sso: true, commissionPct: 1 }, { commissionBase: '123456.78', unpaidLeaveDays: 2, tax: 100 });
    expect(r.commission).toBe('1234.57');
    expect(r.unpaidAmt).toBe('1000.00');
    expect(r.gross).toBe('15234.57');
    expect(r.sso).toBe('762.00'); // 761.7285 → 762
    expect(r.tax).toBe('100.00');
    expect(r.net).toBe('14372.57');
  });
  it('SSO floor 1,650 and no SSO when not enrolled', () => {
    expect(payRow({ pay: 'daily', dailyRate: 100, sso: true }, { days: 5 }).sso).toBe('83.00'); // 1650×5% = 82.5 → 83
    expect(payRow({ pay: 'monthly', salary: 30000, sso: false }).sso).toBe('0.00');
  });
  it('custom SSO config', () => {
    expect(payRow({ pay: 'monthly', salary: 30000, sso: true }, {}, { ssoRate: '0.05', ssoCap: 15000, ssoFloor: 1650 }).sso).toBe('750.00');
  });
});

describe('estTax', () => {
  it('zero below the threshold', () => {
    expect(estTax(15000, 750)).toBe('0.00');
  });
  it('progressive brackets', () => {
    // 50,000/m: y 600,000 − 100,000 − 60,000 − 10,500 = 429,500 → 7,500 + 12,950 = 20,450/yr → 1,704/m
    expect(estTax(50000, 875)).toBe('1704.00');
    // 25,000/m: 300,000 − 100,000 − 60,000 − 10,500 = 129,500 → 0
    expect(estTax(25000, 875)).toBe('0.00');
  });
  it('top bracket', () => {
    // 12,000,000 − 100,000 − 60,000 = 11,840,000 → 7.5k+20k+37.5k+50k+250k+900k+2,394k = 3,659,000/yr ÷ 12 = 304,916.67
    expect(estTax(1000000, 0)).toBe('304917.00');
  });
});

describe('leaveDays', () => {
  it('counts inclusive days excluding Sundays', () => {
    expect(leaveDays('2026-10-26', '2026-10-26')).toBe(1); // Monday
    expect(leaveDays('2026-10-24', '2026-10-27')).toBe(3); // Sat, (Sun), Mon, Tue
    expect(leaveDays('2026-10-25', '2026-10-25')).toBe(0); // Sunday
    expect(leaveDays('2026-10-28', '2026-10-26')).toBe(0);
  });
  it('half day', () => {
    expect(leaveDays('2026-10-26', '2026-10-26', true)).toBe(0.5);
  });
});
