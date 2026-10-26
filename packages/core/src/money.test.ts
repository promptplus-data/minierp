import { describe, expect, it } from 'vitest';
import { d, fmtTHB, money, qty4, round2, round4, sum } from './money';

describe('money', () => {
  it('rounds half up to the satang without float error', () => {
    expect(money(1.005)).toBe('1.01'); // Math.round(1.005*100)/100 === 1 in JS floats
    expect(round2('2.675').toFixed(2)).toBe('2.68');
    expect(round4('118.34125').toFixed()).toBe('118.3413');
  });
  it('sums decimals exactly', () => {
    expect(sum(['0.1', '0.2']).eq('0.3')).toBe(true);
    expect(sum([]).toFixed()).toBe('0');
  });
  it('formats THB with separators', () => {
    expect(fmtTHB('1234.5')).toBe('1,234.50');
    expect(fmtTHB(1000000)).toBe('1,000,000.00');
    expect(fmtTHB('-12')).toBe('-12.00');
    expect(fmtTHB('-0.001')).toBe('0.00');
    expect(fmtTHB(0)).toBe('0.00');
  });
  it('qty4 trims trailing zeros', () => {
    expect(qty4('125.0000')).toBe('125');
    expect(d(null).isZero()).toBe(true);
    expect(round4(1).toFixed()).toBe('1');
  });
});
