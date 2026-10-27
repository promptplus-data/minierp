import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GL, PEAK_CONTACT_HEAD, PEAK_DOC_HEAD, PEAK_PRODUCT_HEAD, entityType, expressRows, flowAccountRows, genericBookRows, journalLines, lineVatShares, missingGl,
  peakContactRows, peakDocRows, peakProductRows, splitPeakFiles, csvUtf8, yyyymmdd, type ExportCell, type PeakDocIn,
} from './acctexport';
import { d, sum } from './money';

describe('PEAK headers (REQ-M12-06)', () => {
  it('2 header rows with 21 / 47 / 21 columns', () => {
    for (const [h, n] of [[PEAK_PRODUCT_HEAD, 21], [PEAK_CONTACT_HEAD, 47], [PEAK_DOC_HEAD, 21]] as const) {
      expect(h).toHaveLength(2);
      expect(h[0]).toHaveLength(n);
      expect(h[1]).toHaveLength(n);
    }
    expect(PEAK_PRODUCT_HEAD[1]!.slice(9, 14)).toEqual(['ผังบัญชีซื้อสินค้า', 'ผังบัญชีรายได้ขาย', 'คำนวณต้นทุนขายหรือไม่', 'วิธีการคำนวณ', 'ผังบัญชีต้นทุนขาย']);
    expect(PEAK_CONTACT_HEAD[0]![1]).toBe('ข้อมูลผู้ติดต่อ');
    expect(PEAK_CONTACT_HEAD[0]![10]).toBe('ข้อมูลที่อยู่จดทะเบียน');
  });
});

describe('PEAK rows', () => {
  it('products: GL from the shop mapping, one row per lot with the same ลำดับที่', () => {
    const rows = peakProductRows([
      { sku: 'SCG-CEM-T50', name: 'ปูนซีเมนต์ตราเสือ 50 กก.', unit: 'ถุง', buyPrice: '122', buyVat: 'v7', salePrice: '145', saleVat: 'v7', isStock: true, barcode: '8850001000014',
        lots: [{ date: '2026-09-10', qty: '25', unitCost: '118.34' }, { date: '2026-10-01', qty: '37', unitCost: '124.44' }] },
      { sku: 'SV-DLV', name: 'ค่าขนส่ง', unit: 'เที่ยว', buyPrice: '0', buyVat: 'v7', salePrice: '300', saleVat: 'v7', isStock: false, lots: [] },
    ], DEFAULT_GL);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toHaveLength(21);
    expect(rows[0]!.slice(0, 17)).toEqual([1, 'SCG-CEM-T50', 'ปูนซีเมนต์ตราเสือ 50 กก.', '', 'ถุง', '122.00', '7%', '145.00', '7%', '114102', '410101', 'คำนวณ', 'FIFO', '510103', '20260910', '25.00', '118.34']);
    expect(rows[1]![0]).toBe(1);
    expect(rows[1]!.slice(14, 17)).toEqual(['20261001', '37.00', '124.44']);
    expect(rows[2]!.slice(11, 14)).toEqual(['ไม่คำนวณ', '', '']);
  });

  it('contacts: 47 columns, customer term on the invoice side, vendor term on the expense side', () => {
    const rows = peakContactRows([
      { code: 'C00001', role: 'customer', name: 'หจก. รุ่งเรืองก่อสร้าง', taxId: '0503558001234', branch: '00000', phone: '053-333-444', term: { t: 'days', x: 30 }, creditLimit: '200000' },
      { code: 'V00002', role: 'vendor', name: 'บจก. ท่อไทยค้าส่ง', taxId: '0105556012345', branch: '00000', phone: null, term: { t: 'nextDay', x: 5 } },
    ], { ...DEFAULT_GL, ar: '113199' });
    for (const r of rows) expect(r).toHaveLength(47);
    expect(rows[0]!.slice(0, 9)).toEqual([1, 'C00001', 'ลูกค้า', 'ไทย', '0503558001234', '00000', 'นิติบุคคล', '', 'หจก. รุ่งเรืองก่อสร้าง']);
    expect(rows[0]!.slice(30, 38)).toEqual(['X วันหลังวันที่ออกเอกสาร', 30, 'ตามการตั้งค่าของกิจการ', '', '113199', '212101', 'กำหนดเอง', '200000.00']);
    expect(rows[1]!.slice(30, 34)).toEqual(['ตามการตั้งค่าของกิจการ', '', 'วันที่ X ของเดือนถัดไป', 5]);
    expect(entityType('3500700123456')).toBe('บุคคลธรรมดา');
  });

  it('documents: one row per line, header cells on the first line only, sales account 410101', () => {
    const doc: PeakDocIn = {
      date: '2026-10-05', no: 'INV2610-0001', contactCode: 'C00001', contactName: 'หจก. รุ่งเรืองก่อสร้าง', taxId: '0503558001234', branch: '00000', vatMode: 'inc', billDiscount: '0',
      lines: [
        { sku: 'SCG-TA-20', name: 'กาวซีเมนต์', qty: '2', unitPrice: '210', discount: '0', vat: 'v7', exVat: '392.52', lineVat: '27.48' },
        { sku: 'SV-DLV', name: 'ค่าขนส่ง', qty: '1', unitPrice: '300', discount: '0', vat: 'v7', exVat: '280.37', lineVat: '19.63' },
      ],
    };
    const rows = peakDocRows([doc, { ...doc, no: 'INV2610-0002' }], DEFAULT_GL.sale);
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r).toHaveLength(21);
    expect(rows[0]!.slice(0, 13)).toEqual([1, '20261005', 'INV2610-0001', '', 'C00001', 'หจก. รุ่งเรืองก่อสร้าง', '0503558001234', '00000', '', 'รวมภาษี', 'SCG-TA-20', 'กาวซีเมนต์', '410101']);
    expect(rows[1]!.slice(0, 3)).toEqual([1, '', '']);
    expect(rows[2]![0]).toBe(2);
  });

  it('line VAT shares add up to the document VAT', () => {
    const s = lineVatShares('47.11', [{ exVat: '392.52', vat: 'v7' }, { exVat: '50', vat: 'exempt' }, { exVat: '280.37', vat: 'v7' }]);
    expect(s[1]).toBe('0.00');
    expect(sum(s).toFixed(2)).toBe('47.11');
  });
});

describe('splitPeakFiles', () => {
  const recs = (n: number, per = 1): ExportCell[][] => Array.from({ length: n }, (_, i) => Array.from({ length: per }, () => [i + 1, `R${i + 1}`])).flat();

  it('≤1,000 rows per file, renumbered from 1 in each file', () => {
    const files = splitPeakFiles(recs(2500));
    expect(files.map((f) => f.length)).toEqual([1000, 1000, 500]);
    expect(files[1]![0]).toEqual([1, 'R1001']);
    expect(files[2]![499]).toEqual([500, 'R2500']);
  });
  it('keeps the rows of one record together', () => {
    const files = splitPeakFiles(recs(5, 3), 10); // 15 rows, records of 3
    expect(files.map((f) => f.length)).toEqual([9, 6]);
    expect(files[1]!.map((r) => r[0])).toEqual([1, 1, 1, 2, 2, 2]);
  });
  it('an empty export is one file with headers only', () => {
    expect(splitPeakFiles([])).toEqual([[]]);
  });
});

describe('CSV and other programs', () => {
  it('UTF-8 BOM, CRLF and quoting', () => {
    const s = csvUtf8([['a,b', 'x"y', 'ไทย'], [1, '']]);
    expect(s.startsWith('﻿')).toBe(true);
    expect(s).toBe('﻿"a,b","x""y",ไทย\r\n1,\r\n');
    expect(yyyymmdd('2026-10-05')).toBe('20261005');
  });
  it('Express / FlowAccount / generic: credit notes negative, voided zero', () => {
    const x = { date: '2026-10-05', no: 'CN2610-0001', type: 'CN', contactCode: 'C00003', contactName: 'คุณสมศรี', taxId: null, base7: '100', exempt: '0', vat: '7', total: '107' };
    expect(expressRows([x])[0]).toEqual(['CN2610-0001', '05/10/2569', 'C00003', '-100.00', '-7.00', '-107.00']);
    expect(flowAccountRows([{ ...x, type: 'INV' }])[0]).toEqual(['CN2610-0001', '2026-10-05', 'คุณสมศรี', '100.00', '7.00', '107.00']);
    expect(genericBookRows([{ ...x, type: 'INV', status: 'void' }])[0]!.slice(6)).toEqual(['0.00', '0.00', '0.00', '0.00', 'ยกเลิก']);
  });
});

describe('journal (REQ-M12-03)', () => {
  it('every document balances; cash sale, credit note and purchase with discount', () => {
    const lines = journalLines([
      { date: '2026-10-05', no: 'ABB2610-0001', side: 'sale', type: 'ABB', paid: true, base7: '1355.14', exempt: '0', vat: '94.86', total: '1450.00' },
      { date: '2026-10-06', no: 'CN2610-0001', side: 'sale', type: 'CN', paid: true, base7: '100', exempt: '0', vat: '7', total: '107' },
      { date: '2026-10-06', no: 'GR2610-0001', side: 'purchase', type: 'GR', paid: false, base7: '900', exempt: '0', vat: '63', total: '963', discount: '100' },
    ], DEFAULT_GL);
    for (const no of ['ABB2610-0001', 'CN2610-0001', 'GR2610-0001']) {
      const l = lines.filter((x) => x.no === no);
      expect(sum(l.map((x) => d(x.debit || 0))).toFixed(2)).toBe(sum(l.map((x) => d(x.credit || 0))).toFixed(2));
    }
    expect(lines.find((l) => l.no === 'ABB2610-0001' && l.account === '111101')?.debit).toBe('1450.00');
    expect(lines.find((l) => l.no === 'CN2610-0001' && l.account === '410101')?.debit).toBe('100.00');
    expect(lines.find((l) => l.no === 'GR2610-0001' && l.account === '510104')?.credit).toBe('100.00');
    expect(lines.find((l) => l.no === 'GR2610-0001' && l.account === '114102')?.debit).toBe('1000.00');
  });
  it('reports GL keys that are empty', () => {
    expect(missingGl({ ...DEFAULT_GL, vatOut: ' ' }, ['sale', 'vatOut'])).toEqual(['vatOut']);
  });
});
