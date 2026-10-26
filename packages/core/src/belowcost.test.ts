import { describe, expect, it } from 'vitest';
import { checkBelowCost, netUnitPricesExVat } from './belowcost';

describe('below cost (BR-16)', () => {
  it('BRD: 145 incl VAT, 20% off → 116 → 108.41 ex VAT < cost 118.34', () => {
    const [p] = netUnitPricesExVat([{ qty: 1, unitPrice: 145, vat: 'v7', discount: { kind: 'pct', value: 20 } }], 'inc');
    expect(p).toBe('108.4112');
    expect(checkBelowCost([{ netUnitExVat: p!, unitCost: '118.34' }])).toEqual([0]);
  });
  it('includes bill discount but ignores the SCG Family coupon', () => {
    // 10 × 100 ex VAT, bill disc 100 → 90/unit
    const [p] = netUnitPricesExVat([{ qty: 10, unitPrice: 100, vat: 'v7' }], 'exc', 100);
    expect(p).toBe('90');
    expect(checkBelowCost([{ netUnitExVat: p!, unitCost: 95 }])).toEqual([0]);
    expect(checkBelowCost([{ netUnitExVat: p!, unitCost: 90 }])).toEqual([]);
  });
  it('skips products without cost and lines with zero qty', () => {
    expect(checkBelowCost([{ netUnitExVat: 1, unitCost: null }, { netUnitExVat: 1, unitCost: 0 }, { netUnitExVat: 5, unitCost: 6 }])).toEqual([2]);
    expect(netUnitPricesExVat([{ qty: 0, unitPrice: 10, vat: 'v7' }], 'inc')).toEqual([null]);
  });
  it('half-satang tolerance like the mockup', () => {
    expect(checkBelowCost([{ netUnitExVat: '118.336', unitCost: '118.34' }])).toEqual([]);
    expect(checkBelowCost([{ netUnitExVat: '118.334', unitCost: '118.34' }])).toEqual([0]);
  });
  it('exempt lines are not divided by 1.07; baseQty for pack units', () => {
    const r = netUnitPricesExVat([
      { qty: 1, unitPrice: 107, vat: 'exempt' },
      { qty: 1, unitPrice: 5800, vat: 'v7', baseQty: 40 },
    ], 'inc');
    expect(r).toEqual(['107', '135.514']);
  });
});
