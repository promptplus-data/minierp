import { describe, expect, it } from 'vitest';
import { agingBucket, daysBetween, daysOverdue, isDueWithin, preVatShare, receiptTotals, splitInclusive, WhtError } from './ar';

describe('aging (REQ-M10-04)', () => {
  it('buckets by days past due', () => {
    expect(agingBucket('2026-10-26', '2026-10-26')).toBe('notDue');
    expect(agingBucket('2026-11-30', '2026-10-26')).toBe('notDue');
    expect(agingBucket('2026-10-25', '2026-10-26')).toBe('d1_30');
    expect(agingBucket('2026-09-26', '2026-10-26')).toBe('d1_30'); // 30 days
    expect(agingBucket('2026-09-25', '2026-10-26')).toBe('d31_60');
    expect(agingBucket('2026-08-27', '2026-10-26')).toBe('d31_60'); // 60
    expect(agingBucket('2026-08-26', '2026-10-26')).toBe('d61_90');
    expect(agingBucket('2026-07-28', '2026-10-26')).toBe('d61_90'); // 90
    expect(agingBucket('2026-07-27', '2026-10-26')).toBe('over90');
  });
  it('counts days across months and years', () => {
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysOverdue('2026-11-01', '2026-10-26')).toBe(0);
  });
  it('due within 7 days (REQ-M10-05)', () => {
    expect(isDueWithin('2026-10-26', '2026-10-26', 7)).toBe(true);
    expect(isDueWithin('2026-11-02', '2026-10-26', 7)).toBe(true);
    expect(isDueWithin('2026-11-03', '2026-10-26', 7)).toBe(false);
    expect(isDueWithin('2026-10-25', '2026-10-26', 7)).toBe(false); // overdue, not "due soon"
  });
});

describe('withholding tax on receipts (REQ-M10-03)', () => {
  it('computes WHT on the pre-VAT part: cash + WHT = settled', () => {
    // invoice 10,700 = 10,000 + VAT 700; 3% WHT = 300
    const t = receiptTotals([{ settled: '10700', invoiceTotal: '10700', invoiceVat: '700' }], { mode: 'rate', rate: 3 });
    expect(t).toMatchObject({ settled: '10700.00', whtBase: '10000.00', wht: '300.00', cash: '10400.00' });
  });
  it('partial settlement takes its pro-rata pre-VAT share', () => {
    expect(preVatShare('5350', '10700', '700').toFixed(2)).toBe('5000.00');
    const t = receiptTotals([{ settled: '5350', invoiceTotal: '10700', invoiceVat: '700' }, { settled: '1000', invoiceTotal: '1000', invoiceVat: '0' }], { mode: 'rate', rate: 1 });
    expect(t).toMatchObject({ whtBase: '6000.00', wht: '60.00', cash: '6290.00' });
    expect(t.lines.map((l) => l.wht)).toEqual(['50.00', '10.00']);
  });
  it('a typed amount is allocated across lines and capped by the base', () => {
    const t = receiptTotals([{ settled: '2140', invoiceTotal: '2140', invoiceVat: '140' }, { settled: '1070', invoiceTotal: '1070', invoiceVat: '70' }], { mode: 'amount', amount: '90' });
    expect(t.lines.map((l) => l.wht)).toEqual(['60.00', '30.00']);
    expect(t.cash).toBe('3120.00');
    expect(() => receiptTotals([{ settled: '107', invoiceTotal: '107', invoiceVat: '7' }], { mode: 'amount', amount: '101' })).toThrow(WhtError);
  });
  it('no WHT', () => {
    expect(receiptTotals([{ settled: '99.5', invoiceTotal: '100', invoiceVat: '0' }], { mode: 'none' })).toMatchObject({ wht: '0.00', cash: '99.50' });
  });
});

describe('lump-sum VAT split', () => {
  it('splits a VAT-inclusive amount', () => {
    expect(splitInclusive('96000', 'inc')).toEqual({ base7: '89719.63', exempt: '0.00', vat: '6280.37', total: '96000.00' });
    expect(splitInclusive('500', 'none')).toEqual({ base7: '0.00', exempt: '500.00', vat: '0.00', total: '500.00' });
  });
});
