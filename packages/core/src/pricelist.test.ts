import { describe, expect, it } from 'vitest';
import { listValidOn, pickListPrice } from './pricelist';

const items = [
  { productId: 'p1', unitIdx: 0, minQty: '0', price: '140' },
  { productId: 'p1', unitIdx: 0, minQty: '100', price: '135' },
  { productId: 'p1', unitIdx: 0, minQty: '500', price: '130' },
  { productId: 'p1', unitIdx: 1, minQty: '0', price: '5400' },
];

describe('price list lookup (BR-05)', () => {
  it('picks the highest quantity break not above qty', () => {
    expect(pickListPrice(items, 'p1', 0, '1')?.price).toBe('140');
    expect(pickListPrice(items, 'p1', 0, '99.5')?.price).toBe('140');
    expect(pickListPrice(items, 'p1', 0, '100')?.price).toBe('135');
    expect(pickListPrice(items, 'p1', 0, '800')?.price).toBe('130');
  });
  it('matches the unit and product', () => {
    expect(pickListPrice(items, 'p1', 1, '2')?.price).toBe('5400');
    expect(pickListPrice(items, 'p2', 0, '2')).toBeNull();
  });
  it('no item when every break is above qty', () => {
    expect(pickListPrice([{ productId: 'p1', unitIdx: 0, minQty: '50', price: '1' }], 'p1', 0, '10')).toBeNull();
  });
  it('validity window', () => {
    expect(listValidOn({ active: true, validFrom: null, validTo: null }, '2026-10-26')).toBe(true);
    expect(listValidOn({ active: true, validFrom: '2026-10-27', validTo: null }, '2026-10-26')).toBe(false);
    expect(listValidOn({ active: true, validFrom: '2026-10-01', validTo: '2026-10-26' }, '2026-10-26')).toBe(true);
    expect(listValidOn({ active: true, validFrom: null, validTo: '2026-10-25' }, '2026-10-26')).toBe(false);
    expect(listValidOn({ active: false, validFrom: null, validTo: null }, '2026-10-26')).toBe(false);
  });
});
