import { describe, expect, it } from 'vitest';
import { INSTALLMENT_TEMPLATES, installmentAmount, planInstallments, validInstallmentPcts } from './project';

describe('installments (REQ-M09-04/05/07)', () => {
  it('percentages must be positive and sum to 100', () => {
    expect(validInstallmentPcts(INSTALLMENT_TEMPLATES['30/40/30'])).toBe(true);
    expect(validInstallmentPcts(INSTALLMENT_TEMPLATES['50/50'])).toBe(true);
    expect(validInstallmentPcts(INSTALLMENT_TEMPLATES['100%'])).toBe(true);
    expect(validInstallmentPcts(['33.33', '33.33', '33.34'])).toBe(true);
    expect(validInstallmentPcts(['30', '40', '20'])).toBe(false);
    expect(validInstallmentPcts(['110', '-10'])).toBe(false);
    expect(validInstallmentPcts([])).toBe(false);
  });
  it('plans due dates from the start date', () => {
    expect(planInstallments(['30', '40', '30'], '2026-10-26')).toEqual([
      { n: 1, pct: '30', dueDate: '2026-11-25' }, { n: 2, pct: '40', dueDate: '2026-12-25' }, { n: 3, pct: '30', dueDate: '2027-01-24' },
    ]);
  });
  it('BRD example: 480,000 with 96,000 deposit, 40 % installment = 192,000 − 38,400 = 153,600', () => {
    const rows = [{ pct: 30, billed: { gross: '144000', deduct: '28800' } }, { pct: 40 }, { pct: 30 }];
    expect(installmentAmount('480000', '96000', rows, 1)).toEqual({ gross: '192000.00', deduct: '38400.00', net: '153600.00' });
  });
  it('the last installment to bill takes the remainders', () => {
    const rows = [{ pct: '33.33', billed: { gross: '333.30', deduct: '33.33' } }, { pct: '33.33', billed: { gross: '333.30', deduct: '33.33' } }, { pct: '33.34' }];
    expect(installmentAmount('1000', '100', rows, 2)).toEqual({ gross: '333.40', deduct: '33.34', net: '300.06' });
    // value grew by a variation order: the last installment bills the difference too
    expect(installmentAmount('1200', '100', rows, 2).gross).toBe('533.40');
  });
  it('never deducts more than what is left of the deposit', () => {
    // deposit pool shrank to 67,200 after a forfeit; 67,200 is already deducted
    const rows = [{ pct: 30, billed: { gross: '144000', deduct: '28800' } }, { pct: 40, billed: { gross: '192000', deduct: '38400' } }, { pct: 10 }, { pct: 20 }];
    expect(installmentAmount('480000', '67200', rows, 2)).toEqual({ gross: '48000.00', deduct: '0.00', net: '48000.00' });
  });
  it('no deposit', () => {
    expect(installmentAmount('58590', '0', [{ pct: 100 }], 0)).toEqual({ gross: '58590.00', deduct: '0.00', net: '58590.00' });
  });
});
