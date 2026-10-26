import { describe, expect, it } from 'vitest';
import { allocate, calcDoc, lineNet, type DocLine } from './vat';
import { sum } from './money';

const L = (qty: string, unitPrice: string, extra: Partial<DocLine> = {}): DocLine => ({ qty, unitPrice, vat: 'v7', ...extra });

const consistent = (t: ReturnType<typeof calcDoc>) =>
  expect(sum([t.base7, t.exempt, t.vat]).toFixed(2)).toBe(t.total);

describe('lineNet', () => {
  it('applies pct and amount discounts, clamped to gross', () => {
    expect(lineNet(L('20', '145', { discount: { kind: 'pct', value: 20 } }))).toBe('2320.00');
    expect(lineNet(L('2', '50', { discount: { kind: 'amt', value: '30' } }))).toBe('70.00');
    expect(lineNet(L('1', '50', { discount: { kind: 'amt', value: '80' } }))).toBe('0.00');
    expect(lineNet(L('0', '145'))).toBe('0.00');
  });
  it('rounds fractional qty × price to the satang', () => {
    expect(lineNet(L('1.333', '24.75'))).toBe('32.99'); // 32.99175
  });
});

describe('calcDoc', () => {
  it('inc: 10 bags × 145 incl VAT → base 1355.14 + VAT 94.86', () => {
    const t = calcDoc([L('10', '145')], 'inc');
    expect(t).toMatchObject({ gross: '1450.00', sub: '1450.00', base7: '1355.14', vat: '94.86', exempt: '0.00', total: '1450.00' });
    consistent(t);
  });
  it('exc: adds 7% on top', () => {
    const t = calcDoc([L('10', '100'), L('1', '50', { vat: 'exempt' })], 'exc');
    expect(t).toMatchObject({ base7: '1000.00', exempt: '50.00', vat: '70.00', total: '1120.00' });
  });
  it('none: non-VAT shop has no VAT even on v7 lines', () => {
    const t = calcDoc([L('10', '145'), L('1', '50', { vat: 'exempt' })], 'none', '100');
    expect(t).toMatchObject({ base7: '0.00', vat: '0.00', exempt: '1400.00', total: '1400.00', billDisc: '100.00' });
  });
  it('inc with exempt line: bill discount allocated pro-rata before VAT split', () => {
    // nets 1000 (v7) + 500 (exempt), bill disc 150 → 100 / 50
    const t = calcDoc([L('10', '100'), L('5', '100', { vat: 'exempt' })], 'inc', '150');
    expect(t.lines.map((l) => l.alloc)).toEqual(['100.00', '50.00']);
    expect(t).toMatchObject({ exempt: '450.00', vat: '58.88', base7: '841.12', total: '1350.00' });
    consistent(t);
  });
  it('line discount + bill discount + coupon', () => {
    const t = calcDoc([L('20', '145', { discount: { kind: 'pct', value: 10 } })], 'inc', '10', '100');
    expect(t).toMatchObject({ gross: '2900.00', lineDisc: '290.00', sub: '2610.00', coupon: '100.00', billDisc: '10.00', total: '2500.00' });
    consistent(t);
  });
  it('caps coupon to sub and bill discount to what is left', () => {
    const t = calcDoc([L('1', '80')], 'inc', '500', '50');
    expect(t).toMatchObject({ coupon: '50.00', billDisc: '30.00', total: '0.00', vat: '0.00', base7: '0.00' });
    const t2 = calcDoc([L('1', '80')], 'exc', '500');
    expect(t2).toMatchObject({ billDisc: '80.00', total: '0.00' });
  });
  it('3-line document: allocation and VAT split close to the satang', () => {
    const t = calcDoc([L('1', '33.33'), L('1', '33.33'), L('1', '33.34')], 'inc', '10');
    const allocs = t.lines.map((l) => l.alloc);
    expect(allocs).toEqual(['3.33', '3.33', '3.34']);
    expect(sum(allocs).toFixed(2)).toBe('10.00');
    expect(t.total).toBe('90.00');
    expect(t.vat).toBe('5.89'); // 90 × 7/107 = 5.8878
    expect(t.base7).toBe('84.11');
    consistent(t);
  });
  it('remainder goes to the last non-zero line', () => {
    const t = calcDoc([L('1', '10'), L('1', '10'), L('1', '10'), L('0', '99')], 'exc', '10');
    expect(t.lines.map((l) => l.alloc)).toEqual(['3.33', '3.33', '3.34', '0.00']);
    expect(t.total).toBe('21.40');
  });
  it('empty / zero documents', () => {
    expect(calcDoc([], 'inc', '50').total).toBe('0.00');
    expect(calcDoc([L('0', '145')], 'exc').total).toBe('0.00');
  });
  it('allocate never loses satang', () => {
    const a = allocate('100', ['1', '1', '1']);
    expect(a.map((x) => x.toFixed(2))).toEqual(['33.33', '33.33', '33.34']);
    expect(allocate('5', ['0', '0']).every((x) => x.isZero())).toBe(true);
  });
});
