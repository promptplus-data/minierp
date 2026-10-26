import { describe, expect, it } from 'vitest';
import { bundleAlloc } from './bundle';
import { sum } from './money';

describe('bundleAlloc (BR-17)', () => {
  it('splits pro-rata to normal price; remainder on last line', () => {
    const r = bundleAlloc([
      { productId: 'a', qtyPerSet: 1, normalPrice: 100 },
      { productId: 'b', qtyPerSet: 1, normalPrice: 100 },
      { productId: 'c', qtyPerSet: 1, normalPrice: 100 },
    ], 1, 100);
    expect(r.map((x) => x.amount)).toEqual(['33.33', '33.33', '33.34']);
  });
  it('multiplies by sets and qty per set', () => {
    const r = bundleAlloc([
      { productId: 'cement', qtyPerSet: 2, normalPrice: 145 },
      { productId: 'adhesive', qtyPerSet: 1, normalPrice: 210 },
    ], 3, 450); // normal 500/set, revenue 1350
    expect(r).toEqual([
      { productId: 'cement', qty: '6', amount: '783.00' },
      { productId: 'adhesive', qty: '3', amount: '567.00' },
    ]);
    expect(sum(r.map((x) => x.amount)).toFixed(2)).toBe('1350.00');
  });
  it('zero normal prices still allocate the whole revenue', () => {
    const r = bundleAlloc([{ productId: 'a', qtyPerSet: 1, normalPrice: 0 }, { productId: 'b', qtyPerSet: 1, normalPrice: 0 }], 1, '99.99');
    expect(sum(r.map((x) => x.amount)).toFixed(2)).toBe('99.99');
  });
});
