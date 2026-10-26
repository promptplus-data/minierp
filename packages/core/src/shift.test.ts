import { describe, expect, it } from 'vitest';
import { shiftDiff, shiftExpected } from './shift';

describe('shift', () => {
  it('BRD: 2,000 + 19,640 − 290 = 21,350', () => {
    const e = shiftExpected({ float: 2000, cashSales: 19640, cashRefunds: 290, cashIn: 0, cashOut: 0 });
    expect(e).toBe('21350.00');
    expect(shiftDiff(e, 21300)).toBe('-50.00');
    expect(shiftDiff(e, '21350')).toBe('0.00');
  });
  it('cash in / out', () => {
    expect(shiftExpected({ float: '1000.10', cashSales: '0.20', cashRefunds: 0, cashIn: 500, cashOut: '200.30' })).toBe('1300.00');
  });
});
