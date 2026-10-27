/**
 * Monthly VAT reports (REQ-M11-03): รายงานภาษีขาย / รายงานภาษีซื้อ in the Revenue Department layout.
 *
 * Rules
 * - Amounts come from the documents as issued (base7 / exempt / vat per document). The report never recomputes
 *   VAT from a summed base, so every row and the totals match the source documents exactly.
 * - A voided document stays on the report with amounts 0.00 and the void reason in the remark.
 * - ABB (ใบกำกับภาษีอย่างย่อ) are summarised to one row per day per POS device: first–last number, count,
 *   Σ of the live bills; voided ABB inside the range count as 0 and are listed in the remark.
 * - Credit notes (ใบลดหนี้) are listed with negative amounts and the referenced document in the remark.
 * - Rows are ordered by date, then document number; totals are the exact sum of the rows.
 */
import { d, money, round2, sum, type Money, type Num } from './money';

export interface VatDocIn {
  kind: 'doc';
  date: string;
  no: string;
  /** 'CN' is a credit note (negative); anything else is a normal tax invoice. */
  type: string;
  status: 'active' | 'void';
  name: string;
  taxId: string | null;
  branch: string | null;
  base7: Num;
  exempt: Num;
  vat: Num;
  refNo?: string | null;
  voidReason?: string | null;
}

/** One POS device's ABB for one day, already aggregated in SQL (live bills only in the sums). */
export interface AbbDayIn {
  kind: 'abb';
  date: string;
  device: string;
  firstNo: string;
  lastNo: string;
  count: number;
  voidNos: string[];
  base7: Num;
  exempt: Num;
  vat: Num;
}

export interface VatRow {
  seq: number;
  date: string;
  no: string;
  name: string;
  taxId: string;
  branch: string;
  base7: Money;
  exempt: Money;
  vat: Money;
  total: Money;
  note: string;
}

export interface VatTotals { base7: Money; exempt: Money; vat: Money; total: Money; docs: number; voided: number }

/** สถานประกอบการ column: 'สำนักงานใหญ่' or 'สาขาที่ 00001'; empty when the buyer has no tax ID. */
export function branchLabel(branch: string | null | undefined, taxId: string | null | undefined): string {
  if (!taxId) return '';
  const b = (branch ?? '').trim();
  if (!b || b === '00000' || b === 'สำนักงานใหญ่' || /^0+$/.test(b)) return 'สำนักงานใหญ่';
  if (/^\d+$/.test(b)) return `สาขาที่ ${b.padStart(5, '0')}`;
  return b.startsWith('สาขา') ? b : `สาขา ${b}`;
}

const ZERO = '0.00';

export function buildVatReport(items: readonly (VatDocIn | AbbDayIn)[]): { rows: VatRow[]; totals: VatTotals } {
  const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date) || key(a).localeCompare(key(b)));
  let voided = 0;
  let docs = 0;
  const rows: VatRow[] = sorted.map((it, i) => {
    if (it.kind === 'abb') {
      docs += it.count;
      voided += it.voidNos.length;
      const live = it.count - it.voidNos.length;
      const notes = [`${it.count} ใบ`];
      if (it.voidNos.length) notes.push(`ยกเลิก ${it.voidNos.length} ใบ (${it.voidNos.join(', ')}) แสดงยอด 0`);
      if (!live) notes.push('ยกเลิกทั้งหมด');
      return row(i, it.date, it.firstNo === it.lastNo ? it.firstNo : `${it.firstNo} – ${it.lastNo}`,
        `ใบกำกับภาษีอย่างย่อ (รวมรายวัน) เครื่อง ${it.device}`, '', '', it.base7, it.exempt, it.vat, 1, notes.join(' · '));
    }
    docs += 1;
    if (it.status === 'void') {
      voided += 1;
      return row(i, it.date, it.no, it.name, it.taxId ?? '', branchLabel(it.branch, it.taxId), 0, 0, 0, 1, `ยกเลิก${it.voidReason ? `: ${it.voidReason}` : ''}`);
    }
    const cn = it.type === 'CN';
    return row(i, it.date, it.no, it.name, it.taxId ?? '', branchLabel(it.branch, it.taxId), it.base7, it.exempt, it.vat, cn ? -1 : 1,
      cn ? `ใบลดหนี้${it.refNo ? ` อ้างอิง ${it.refNo}` : ''}` : '');
  });
  const totals: VatTotals = {
    base7: money(sum(rows.map((r) => r.base7))),
    exempt: money(sum(rows.map((r) => r.exempt))),
    vat: money(sum(rows.map((r) => r.vat))),
    total: money(sum(rows.map((r) => r.total))),
    docs,
    voided,
  };
  return { rows, totals };
}

const key = (x: VatDocIn | AbbDayIn) => (x.kind === 'abb' ? `${x.firstNo}|${x.device}` : x.no);

function row(i: number, date: string, no: string, name: string, taxId: string, branch: string, base7: Num, exempt: Num, vat: Num, sign: 1 | -1, note: string): VatRow {
  const b = round2(base7).times(sign);
  const e = round2(exempt).times(sign);
  const v = round2(vat).times(sign);
  const fix = (x: ReturnType<typeof d>) => (x.isZero() ? ZERO : money(x));
  return { seq: i + 1, date, no, name, taxId, branch, base7: fix(b), exempt: fix(e), vat: fix(v), total: fix(b.plus(e).plus(v)), note };
}

/**
 * Input VAT of a purchase document whose amounts are ex VAT (manual goods receipt): 7% of the document total,
 * rounded per document (never on the month's sum). Vendors without a tax ID give no claimable input VAT.
 */
export function purchaseVat(exVatTotal: Num, vendorHasTaxId: boolean): Money {
  return vendorHasTaxId ? money(round2(d(exVatTotal).times('0.07'))) : ZERO;
}

/**
 * Splits a document's ex-VAT value over its lines (for reports by product / category and line-level exports).
 * - exc: a 7% line's ex-VAT value is its net after bill discount; exempt lines likewise.
 * - inc: 7% lines share the document's base7 pro-rata to their net after bill discount; the rounding remainder
 *   goes to the last 7% line, so Σ lines == base7 + exempt of the document exactly.
 * - none (non-VAT shop): every line is exempt at its net.
 */
export function lineExVat(doc: { vatMode: 'inc' | 'exc' | 'none'; base7: Num }, lines: readonly { netAfterBill: Num; vat: 'v7' | 'exempt' }[]): Money[] {
  if (doc.vatMode !== 'inc') return lines.map((l) => money(l.netAfterBill));
  const v7 = lines.map((l, i) => ({ l, i })).filter((x) => x.l.vat === 'v7');
  const pool = sum(v7.map((x) => x.l.netAfterBill));
  const out: Money[] = lines.map((l) => money(l.netAfterBill));
  if (!v7.length) return out;
  let given = d(0);
  v7.forEach((x, k) => {
    const share = k === v7.length - 1 ? d(doc.base7).minus(given) : pool.isZero() ? d(0) : round2(d(x.l.netAfterBill).times(d(doc.base7)).div(pool));
    given = given.plus(share);
    out[x.i] = money(share);
  });
  return out;
}
