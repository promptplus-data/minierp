import { describe, expect, it } from 'vitest';
import { excelSerialDate, exVat, guessMapping, matchUnit, parseDateCell, parseNumberCell, parseVatFlag, taxIdValid, textCell } from './importfmt';

describe('parseDateCell', () => {
  it('ISO, yyyymmdd (PEAK lots), DD/MM/YYYY in CE and BE', () => {
    expect(parseDateCell('2026-10-22')).toBe('2026-10-22');
    expect(parseDateCell('20260914')).toBe('2026-09-14');
    expect(parseDateCell(20260914)).toBe('2026-09-14');
    expect(parseDateCell('22/10/2569')).toBe('2026-10-22');
    expect(parseDateCell('22/10/2026')).toBe('2026-10-22');
    expect(parseDateCell('5-1-2569')).toBe('2026-01-05');
  });
  it('Excel serials and Date objects (AT-OP-07)', () => {
    expect(excelSerialDate(46317)).toBe('2026-10-22');
    expect(parseDateCell(46317)).toBe('2026-10-22');
    expect(parseDateCell(new Date(Date.UTC(2026, 9, 22)))).toBe('2026-10-22');
  });
  it('rejects impossible or malformed dates', () => {
    expect(parseDateCell('31/02/2569')).toBeNull();
    expect(parseDateCell('2026-13-01')).toBeNull();
    expect(parseDateCell('22/10/69')).toBeNull();
    expect(parseDateCell('abc')).toBeNull();
    expect(parseDateCell('')).toBeNull();
  });
});

describe('parseNumberCell', () => {
  it('thousands commas, baht sign, spaces, XLSX numbers', () => {
    expect(parseNumberCell('2,150.00')).toBe('2150');
    expect(parseNumberCell('฿ 1,250.50')).toBe('1250.5');
    expect(parseNumberCell(43.5)).toBe('43.5');
    expect(parseNumberCell('-5')).toBe('-5');
  });
  it('rejects text and broken grouping (AT-OP-05)', () => {
    expect(parseNumberCell('abc')).toBeNull();
    expect(parseNumberCell('1,25')).toBeNull();
    expect(parseNumberCell('')).toBeNull();
  });
});

describe('text, VAT flag, tax id, VAT conversion', () => {
  it('textCell keeps codes as digits', () => {
    expect(textCell(8100234561)).toBe('8100234561');
    expect(textCell('  x ')).toBe('x');
  });
  it('VAT flags', () => {
    expect(parseVatFlag('Y')).toBe('inc');
    expect(parseVatFlag('รวม')).toBe('inc');
    expect(parseVatFlag('N')).toBe('exc');
    expect(parseVatFlag('ไม่รวม')).toBe('exc');
    expect(parseVatFlag('none')).toBe('none');
    expect(parseVatFlag('?')).toBeNull();
  });
  it('tax id check digit', () => {
    expect(taxIdValid('0505561004323')).toBe(true);
    expect(taxIdValid('0505561004321')).toBe(false);
    expect(taxIdValid('12345')).toBe(false);
  });
  it('AT-OP-06: 129.47 incl. VAT → 121 ex VAT', () => {
    expect(exVat('129.47')).toBe('121');
  });
});

describe('guessMapping and matchUnit', () => {
  it('maps Thai and English headers, ignoring case and spaces', () => {
    const fields = [{ key: 'product_code', aliases: ['รหัสสินค้า', 'SKU'] }, { key: 'qty', aliases: ['จำนวน', 'Qty'] }, { key: 'unit', aliases: ['หน่วย', 'UOM'] }];
    expect(guessMapping(['รหัสสินค้า', 'ชื่อ', ' QTY ', 'uom'], fields)).toEqual({ product_code: 0, qty: 2, unit: 3 });
  });
  it('matches unit names exactly, by synonym, then by prefix', () => {
    const units = [{ name: 'ถุง' }, { name: 'พาเลท' }];
    expect(matchUnit('ถุง', units)).toBe(0);
    expect(matchUnit('Pallet', units)).toBe(1);
    expect(matchUnit('แผ่น', units)).toBe(-1);
    expect(matchUnit('เมตร', [{ name: 'เส้น' }, { name: 'เมตร (ตัดขาย)' }])).toBe(1);
  });
});
