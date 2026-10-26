import { describe, expect, it } from 'vitest';
import { CASHIER_DISC_CAP, discountPct, exceedsCap } from './discount';
import { perm } from './perms';

describe('discount cap (OQ-10)', () => {
  it('computes % of gross', () => {
    expect(discountPct(2900, 290)).toBe('10');
    expect(discountPct('300', '100')).toBe('33.3333');
    expect(discountPct(0, 10)).toBe('0');
  });
  it('cashier cap is 0: any discount needs approval', () => {
    expect(CASHIER_DISC_CAP).toBe(0);
    expect(perm('cashier', 'pos.discCap')).toBe(0);
    expect(exceedsCap(discountPct(1000, 1), perm('cashier', 'pos.discCap'))).toBe(true);
    expect(exceedsCap(0, 0)).toBe(false);
  });
  it('sales 10% cap: exactly 10% is allowed, 10.0001% is not', () => {
    expect(exceedsCap('10', perm('sales', 'pos.discCap'))).toBe(false);
    expect(exceedsCap('10.0001', 10)).toBe(true);
  });
});
