import { describe, expect, it } from 'vitest';
import { allocateFreeGoods } from './freegoods';
import { d, sum } from './money';

const lotTotal = (r: { unitCost: string }[], qtys: string[]) => sum(r.map((x, i) => d(x.unitCost).times(d(qtys[i]!)))).toFixed(4);

describe('free goods costing by relative market value', () => {
  it('20 cement × 150 paid + 10 free plaster at market 100 → 112.5 and 75 a bag, 3,000 in all', () => {
    const r = allocateFreeGoods([{ paid: '3000', market: '3000', baseQty: '20' }, { paid: '0', market: '1000', baseQty: '10' }]);
    expect(r).toEqual([{ amount: '2250', unitCost: '112.5' }, { amount: '750', unitCost: '75' }]);
    expect(lotTotal(r, ['20', '10'])).toBe('3000.0000');
  });

  it('spreads only what was paid after the bill discount; market value of a paid line stays qty × invoice cost', () => {
    // 3,000 − 300 discount = 2,700 paid; market 3,000 : 1,000.
    const r = allocateFreeGoods([{ paid: '2700', market: '3000', baseQty: '20' }, { paid: '0', market: '1000', baseQty: '10' }]);
    expect(r).toEqual([{ amount: '2025', unitCost: '101.25' }, { amount: '675', unitCost: '67.5' }]);
  });

  it('several free lines share by their own market value', () => {
    const r = allocateFreeGoods([
      { paid: '1500', market: '1500', baseQty: '10' },
      { paid: '0', market: '500', baseQty: '5' },
      { paid: '0', market: '500', baseQty: '2' },
    ]);
    expect(r.map((x) => x.unitCost)).toEqual(['90', '60', '150']);
    expect(sum(r.map((x) => x.amount)).toFixed(4)).toBe('1500.0000');
  });

  it('rounds to 4 dp and puts the residual on the largest line so lot costs sum to the paid total', () => {
    const r = allocateFreeGoods([{ paid: '300', market: '300', baseQty: '3' }, { paid: '0', market: '70', baseQty: '7' }]);
    expect(r[1]).toEqual({ amount: '56.7568', unitCost: '8.1081' });
    expect(r[0]!.unitCost).toBe('81.0811');
    expect(sum(r.map((x) => x.amount)).toFixed(4)).toBe('300.0000');
    expect(lotTotal(r, ['3', '7'])).toBe('300.0000');
  });

  it('residual lands on the largest line even when it is the free one', () => {
    const r = allocateFreeGoods([{ paid: '100', market: '100', baseQty: '1' }, { paid: '0', market: '200', baseQty: '3' }]);
    // 33.3333 + 66.6667 = 100; unit of the free line takes the residual: (100 − 33.3333) / 3.
    expect(r[0]).toEqual({ amount: '33.3333', unitCost: '33.3333' });
    expect(r[1]!.amount).toBe('66.6667');
    expect(r[1]!.unitCost).toBe('22.2222');
  });

  it('no market value at all keeps paid amounts; a receipt of only free goods stays 0', () => {
    expect(allocateFreeGoods([{ paid: '50', market: '0', baseQty: '2' }, { paid: '0', market: '0', baseQty: '1' }]))
      .toEqual([{ amount: '50', unitCost: '25' }, { amount: '0', unitCost: '0' }]);
    expect(allocateFreeGoods([{ paid: '0', market: '400', baseQty: '4' }])).toEqual([{ amount: '0', unitCost: '0' }]);
  });

  it('refuses negative values and zero quantities', () => {
    expect(() => allocateFreeGoods([{ paid: '-1', market: '1', baseQty: '1' }])).toThrow();
    expect(() => allocateFreeGoods([{ paid: '1', market: '1', baseQty: '0' }])).toThrow();
  });
});
