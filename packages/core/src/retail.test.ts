import { describe, expect, it } from 'vitest';
import {
  bomSuggest, bundleNormalPrice, bundleSetsAvailable, listPriceForDoc, moUnitCost, pickRetailListPrice, priceExVat, promoBelowCost, promoState,
  promoUnitPrice, resolvePrice, yieldPct, type PriceListEntry,
} from './retail';

describe('promoState (REQ-M15-01)', () => {
  const p = { status: 'active' as const, start: '2026-10-15', end: '2026-11-15' };
  it('derives scheduled / live / expired from the dates, inclusive', () => {
    expect(promoState(p, '2026-10-14')).toBe('scheduled');
    expect(promoState(p, '2026-10-15')).toBe('live');
    expect(promoState(p, '2026-11-15')).toBe('live');
    expect(promoState(p, '2026-11-16')).toBe('expired');
  });
  it('draft and closed win over the dates', () => {
    expect(promoState({ ...p, status: 'draft' }, '2026-10-20')).toBe('draft');
    expect(promoState({ ...p, status: 'closed' }, '2026-10-20')).toBe('closed');
  });
});

describe('promoUnitPrice (mockup applyPromo)', () => {
  it('pct off the unit list price', () => expect(promoUnitPrice('pct', 10, '1290.00')).toBe('1161.00'));
  it('amt is baht off per base unit, so packs get factor × amount off', () => {
    expect(promoUnitPrice('amt', 5, 145, 1)).toBe('140.00');
    expect(promoUnitPrice('amt', 5, 5800, 40)).toBe('5600.00');
  });
  it('fixed is the promo price per base unit', () => expect(promoUnitPrice('fixed', '19.90', 24)).toBe('19.90'));
  it('never negative and never above list', () => {
    expect(promoUnitPrice('amt', 200, 145)).toBe('0.00');
    expect(promoUnitPrice('fixed', 30, 24)).toBe('24.00');
  });
  it('rounds to the satang', () => expect(promoUnitPrice('pct', 7, '89.00')).toBe('82.77'));
});

describe('bundles (REQ-M15-02)', () => {
  it('normal price of a set (PR002: 100 อิฐ × 24 + 2 ปูน × 145 = 2690)', () => {
    expect(bundleNormalPrice([{ qtyPerSet: 100, normalPrice: 24 }, { qtyPerSet: 2, normalPrice: 145 }])).toBe('2690.00');
  });
  it('sets available is limited by the scarcest component', () => {
    expect(bundleSetsAvailable([{ qtyPerSet: 100, have: 300 }, { qtyPerSet: 2, have: 5 }])).toBe(2);
    expect(bundleSetsAvailable([{ qtyPerSet: 100, have: 99 }, { qtyPerSet: 2, have: 50 }])).toBe(0);
    expect(bundleSetsAvailable([])).toBe(0);
  });
});

describe('below cost at promo creation (REQ-M15-03, BR-16)', () => {
  it('compares the promo price before VAT with the cost', () => {
    expect(priceExVat('116.00', 'inc', 'v7')).toBe('108.4112');
    expect(priceExVat('116.00', 'inc', 'exempt')).toBe('116');
    expect(promoBelowCost('108.4112', '118.34')).toBe(true);
    expect(promoBelowCost('130.8411', '118.34')).toBe(false);
    expect(promoBelowCost('1', null)).toBe(false);
    expect(promoBelowCost('118.336', '118.34')).toBe(false); // within half a satang
  });
});

describe('BR-05 price resolution', () => {
  const entries: PriceListEntry[] = [
    { source: 'group', unitIdx: 0, minQty: 0, price: '140.00' },
    { source: 'group', unitIdx: 0, minQty: 50, price: '136.00' },
    { source: 'customer', unitIdx: 0, minQty: 10, price: '138.00' },
    { source: 'group', unitIdx: 1, minQty: 0, price: '5500.00' },
  ];
  it('customer list first, then the group list with the largest qty break', () => {
    expect(pickRetailListPrice(entries, 0, 20)).toEqual({ price: '138.00', source: 'customer' });
    expect(pickRetailListPrice(entries, 0, 5)).toEqual({ price: '140.00', source: 'group' });
    expect(pickRetailListPrice(entries.filter((e) => e.source === 'group'), 0, 60)).toEqual({ price: '136.00', source: 'group' });
    expect(pickRetailListPrice(entries, 1, 1)).toEqual({ price: '5500.00', source: 'group' });
    expect(pickRetailListPrice(entries, 2, 1)).toBeNull();
  });
  it('quotation beats everything; promo only when lower than the list price', () => {
    expect(resolvePrice({ retail: 145, quotation: '139.50', list: { price: 138, source: 'customer' }, promo: { id: 'p', price: 100 } }))
      .toEqual({ unitPrice: '139.50', source: 'quotation', promoId: null, listPrice: '145.00' });
    expect(resolvePrice({ retail: 145, list: { price: 138, source: 'customer' }, promo: { id: 'p', price: 140 } }))
      .toEqual({ unitPrice: '138.00', source: 'customer', promoId: null, listPrice: '145.00' });
    expect(resolvePrice({ retail: 145, list: { price: 138, source: 'group' }, promo: { id: 'p', price: 130 } }))
      .toEqual({ unitPrice: '130.00', source: 'promo', promoId: 'p', listPrice: '145.00' });
    expect(resolvePrice({ retail: 145 })).toEqual({ unitPrice: '145.00', source: 'retail', promoId: null, listPrice: '145.00' });
  });
  it('converts list prices between VAT bases', () => {
    expect(listPriceForDoc('100.00', false, 'inc', 'v7')).toBe('107.00');
    expect(listPriceForDoc('107.00', true, 'exc', 'v7')).toBe('100.00');
    expect(listPriceForDoc('100.00', false, 'inc', 'exempt')).toBe('100.00');
    expect(listPriceForDoc('100.00', true, 'none', 'v7')).toBe('100.00');
  });
});

describe('production costing (REQ-M16-02/03)', () => {
  it('suggests materials from the BOM', () => expect(bomSuggest('0.04', 30)).toBe('1.2'));
  it('unit cost = (materials + labour + overhead) ÷ good; rejects load the good units (mockup MO2610-0003)', () => {
    // 8646 materials + 25 × 28 labour = 9346 / 28 good = 333.7857
    expect(moUnitCost({ materials: 8646, labour: 700, good: 28 })).toBe('333.7857');
    expect(moUnitCost({ materials: '100', labour: '10', overhead: '5', good: 4 })).toBe('28.7500');
    expect(() => moUnitCost({ materials: 1, good: 0 })).toThrow();
  });
  it('yield vs plan', () => {
    expect(yieldPct(28, 30)).toBe('93.33');
    expect(yieldPct(1, 0)).toBe('0.00');
  });
});
