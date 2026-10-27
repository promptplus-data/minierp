import { describe, expect, it } from 'vitest';
import { agingBucket, agingSummary, checkAllocations, daysOverdue, dueWithin, purchaseBill, vendorReturnAmounts, whtAmount } from './payables';

describe('purchaseBill (REQ-M05-08 / BR-19)', () => {
  it('AP and VAT come from the amount after the bill discount: 10,000 − 300 → 10,379', () => {
    expect(purchaseBill(['10000'], '300', true)).toEqual({ base: '10000.00', discount: '300.00', net: '9700.00', vat: '679.00', total: '10379.00' });
  });
  it('non-VAT shop has no input VAT; several lines are summed', () => {
    expect(purchaseBill(['120.50', '79.50'], '0', false)).toEqual({ base: '200.00', discount: '0.00', net: '200.00', vat: '0.00', total: '200.00' });
  });
  it('rejects a discount above the bill or below 0', () => {
    expect(() => purchaseBill(['100'], '101', true)).toThrow(RangeError);
    expect(() => purchaseBill(['100'], '-1', true)).toThrow(RangeError);
  });
});

describe('whtAmount', () => {
  it('VAT shop withholds on the pre-VAT amount: 3% of 10,700 → 300.00', () => {
    expect(whtAmount('10700', 3, true)).toBe('300.00');
    expect(whtAmount('10700', 1, true)).toBe('100.00');
  });
  it('non-VAT shop withholds on the amount paid; 0% is zero; other rates refused', () => {
    expect(whtAmount('1000', 3, false)).toBe('30.00');
    expect(whtAmount('1000', 0, true)).toBe('0.00');
    expect(() => whtAmount('1000', 5, true)).toThrow(RangeError);
  });
});

describe('aging (REQ-M18-04)', () => {
  it('buckets: not due / 1–30 / 31–60 / > 60', () => {
    expect(agingBucket('2026-10-26', '2026-10-26')).toBe('current');
    expect(agingBucket('2026-10-27', '2026-10-26')).toBe('current');
    expect(agingBucket('2026-10-25', '2026-10-26')).toBe('d1_30');
    expect(agingBucket('2026-09-26', '2026-10-26')).toBe('d1_30');
    expect(agingBucket('2026-09-25', '2026-10-26')).toBe('d31_60');
    expect(agingBucket('2026-08-27', '2026-10-26')).toBe('d31_60');
    expect(agingBucket('2026-08-26', '2026-10-26')).toBe('over60');
    expect(daysOverdue('2026-10-20', '2026-10-26')).toBe(6);
  });
  it('summary skips settled bills', () => {
    expect(agingSummary([{ due: '2026-11-01', balance: '100' }, { due: '2026-10-01', balance: '50.5' }, { due: '2026-01-01', balance: '0' }], '2026-10-26'))
      .toEqual({ current: '100.00', d1_30: '50.50', d31_60: '0.00', over60: '0.00' });
  });
  it('due within 7 days', () => {
    expect(dueWithin('2026-11-02', '2026-10-26')).toBe(true);
    expect(dueWithin('2026-11-03', '2026-10-26')).toBe(false);
    expect(dueWithin('2026-10-25', '2026-10-26')).toBe(false);
  });
});

describe('vendorReturnAmounts (REQ-M18-03)', () => {
  it('values the return at GR price plus VAT and caps the AP reduction at the open balance', () => {
    expect(vendorReturnAmounts([{ qty: '10', unitPrice: '121' }], true, '5000')).toEqual({ base: '1210.00', vat: '84.70', total: '1294.70', applied: '1294.70', unapplied: '0.00' });
    expect(vendorReturnAmounts([{ qty: '10', unitPrice: '121' }], true, '1000')).toMatchObject({ applied: '1000.00', unapplied: '294.70' });
    expect(vendorReturnAmounts([{ qty: '2', unitPrice: '50' }], false, '0')).toMatchObject({ total: '100.00', applied: '0.00', unapplied: '100.00' });
  });
});

describe('checkAllocations', () => {
  it('needs at least one bill, positive amounts within the balance', () => {
    expect(checkAllocations([])).toMatch(/no bills/);
    expect(checkAllocations([{ billNo: 'AP1', amount: '0', balance: '10' }])).toMatch(/> 0/);
    expect(checkAllocations([{ billNo: 'AP1', amount: '10.01', balance: '10' }])).toMatch(/exceeds/);
    expect(checkAllocations([{ billNo: 'AP1', amount: '10', balance: '10' }])).toBeNull();
  });
});
