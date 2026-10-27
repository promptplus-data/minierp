import { describe, expect, it } from 'vitest';
import { calcDoc } from './vat';
import { sum } from './money';
import { branchLabel, buildVatReport, lineExVat, purchaseVat, type AbbDayIn, type VatDocIn } from './taxreport';

const inv = (no: string, x: Partial<VatDocIn> = {}): VatDocIn => ({
  kind: 'doc', date: '2026-10-05', no, type: 'INV', status: 'active', name: 'หจก. รุ่งเรืองก่อสร้าง', taxId: '0503558001234', branch: '00000',
  base7: '1000.00', exempt: '0.00', vat: '70.00', ...x,
});

describe('buildVatReport (REQ-M11-03)', () => {
  it('keeps a voided invoice on the report with zero amounts and the reason', () => {
    const r = buildVatReport([inv('INV2610-0001'), inv('INV2610-0002', { status: 'void', voidReason: 'บิลซ้ำ' })]);
    expect(r.rows[1]).toMatchObject({ no: 'INV2610-0002', base7: '0.00', vat: '0.00', total: '0.00', note: 'ยกเลิก: บิลซ้ำ' });
    expect(r.totals).toMatchObject({ base7: '1000.00', vat: '70.00', total: '1070.00', docs: 2, voided: 1 });
  });

  it('summarises ABB per day per POS, voided ABB inside the range count as 0', () => {
    const abb: AbbDayIn = { kind: 'abb', date: '2026-10-05', device: 'POS-1', firstNo: 'ABB2610-0001', lastNo: 'ABB2610-0004', count: 4, voidNos: ['ABB2610-0003'], base7: '271.03', exempt: '0.00', vat: '18.97' };
    const r = buildVatReport([abb]);
    expect(r.rows[0]).toMatchObject({ no: 'ABB2610-0001 – ABB2610-0004', taxId: '', base7: '271.03', vat: '18.97', total: '290.00' });
    expect(r.rows[0]!.name).toContain('POS-1');
    expect(r.rows[0]!.note).toContain('ยกเลิก 1 ใบ (ABB2610-0003)');
    expect(r.totals).toMatchObject({ docs: 4, voided: 1 });
  });

  it('VAT is the sum of per-document VAT, never 7/107 of the summed day', () => {
    // three 10.00 baht bills incl VAT: each base 9.35 + VAT 0.65; summed day 30.00 → 7/107 would give 1.96, documents say 1.95
    const bills = ['10', '10', '10'].map((p) => calcDoc([{ qty: '1', unitPrice: p, vat: 'v7' }], 'inc'));
    const abb: AbbDayIn = { kind: 'abb', date: '2026-10-05', device: 'POS-1', firstNo: 'ABB2610-0001', lastNo: 'ABB2610-0003', count: 3, voidNos: [],
      base7: sum(bills.map((b) => b.base7)).toFixed(2), exempt: '0', vat: sum(bills.map((b) => b.vat)).toFixed(2) };
    const r = buildVatReport([abb]);
    expect(r.totals.vat).toBe('1.95');
    expect(r.totals.total).toBe('30.00');
  });

  it('credit notes are negative and reference the original; rows ordered by date then number', () => {
    const r = buildVatReport([
      inv('CN2610-0001', { type: 'CN', date: '2026-10-07', base7: '100.00', vat: '7.00', refNo: 'INV2610-0001' }),
      inv('INV2610-0001', { date: '2026-10-02' }),
    ]);
    expect(r.rows.map((x) => x.no)).toEqual(['INV2610-0001', 'CN2610-0001']);
    expect(r.rows[1]).toMatchObject({ base7: '-100.00', vat: '-7.00', total: '-107.00', note: 'ใบลดหนี้ อ้างอิง INV2610-0001' });
    expect(r.totals).toMatchObject({ base7: '900.00', vat: '63.00', total: '963.00' });
    expect(r.rows.map((x) => x.seq)).toEqual([1, 2]);
  });

  it('branch column follows the Revenue Department wording', () => {
    expect(branchLabel('00000', '0503558001234')).toBe('สำนักงานใหญ่');
    expect(branchLabel(null, '0503558001234')).toBe('สำนักงานใหญ่');
    expect(branchLabel('1', '0503558001234')).toBe('สาขาที่ 00001');
    expect(branchLabel('00003', '0503558001234')).toBe('สาขาที่ 00003');
    expect(branchLabel('00003', null)).toBe('');
  });

  it('input VAT is 7% per purchase document and only with a vendor tax ID', () => {
    expect(purchaseVat('1234.56', true)).toBe('86.42');
    expect(purchaseVat('1234.56', false)).toBe('0.00');
  });
});

describe('lineExVat', () => {
  it('inc: shares base7 over 7% lines, remainder on the last; Σ lines = base7 + exempt', () => {
    const lines = [{ qty: '1', unitPrice: '33.33', vat: 'v7' as const }, { qty: '1', unitPrice: '33.33', vat: 'v7' as const }, { qty: '1', unitPrice: '50', vat: 'exempt' as const }, { qty: '1', unitPrice: '33.34', vat: 'v7' as const }];
    const t = calcDoc(lines, 'inc', '7');
    const ex = lineExVat({ vatMode: 'inc', base7: t.base7 }, t.lines.map((l, i) => ({ netAfterBill: l.after, vat: lines[i]!.vat })));
    expect(sum(ex).toFixed(2)).toBe(sum([t.base7, t.exempt]).toFixed(2));
    expect(ex[2]).toBe(t.lines[2]!.after);
  });
  it('exc and none: the net after bill discount', () => {
    expect(lineExVat({ vatMode: 'exc', base7: '100' }, [{ netAfterBill: '60', vat: 'v7' }, { netAfterBill: '40', vat: 'exempt' }])).toEqual(['60.00', '40.00']);
    expect(lineExVat({ vatMode: 'none', base7: '0' }, [{ netAfterBill: '60', vat: 'v7' }])).toEqual(['60.00']);
  });
});
