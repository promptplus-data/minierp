/**
 * Accounting exports (REQ-M12-01..06): PEAK import templates, FlowAccount, Express, general journal, CSV.
 *
 * PEAK templates (REQ-M12-06): 2 header rows (group row + column row), at most 1,000 data rows per file
 * (splitPeakFiles keeps rows of one ลำดับที่ in the same file and renumbers per file), account codes from the
 * shop's GL mapping (ขาย 410101, ซื้อ 114102, ต้นทุนขาย 510103, ส่วนลดรับ 510104 by default).
 * - Products: 21 columns, one row per lot (extra lots repeat ลำดับที่) — column set from the mockup's PEAK_P.
 * - Contacts: 47 columns — column set from the mockup's PEAK_C.
 * - Sales / purchase documents: 21 columns, one row per document line, lines of a document share ลำดับที่.
 */
import { d, money, qty4, round2, sum, type Money, type Num } from './money';
import type { PaymentTerm } from './terms';

// ---------- GL mapping ----------
export interface GlMap {
  sale: string; buy: string; cogs: string; pdisc: string; ar: string; ap: string;
  vatOut: string; vatIn: string; cash: string; coupon: string; deposit: string;
}
export const DEFAULT_GL: Readonly<GlMap> = {
  sale: '410101', buy: '114102', cogs: '510103', pdisc: '510104', ar: '113101', ap: '212101',
  vatOut: '215101', vatIn: '115101', cash: '111101', coupon: '410901', deposit: '217101',
};
export const GL_LABELS: Readonly<Record<keyof GlMap, string>> = {
  buy: 'ซื้อสินค้า / สินค้าคงเหลือ', sale: 'รายได้ขาย', cogs: 'ต้นทุนขาย', pdisc: 'ส่วนลดรับจากผู้ขาย', ar: 'ลูกหนี้การค้า', ap: 'เจ้าหนี้การค้า',
  vatOut: 'ภาษีขาย', vatIn: 'ภาษีซื้อ', cash: 'เงินสด / เงินฝาก (รับเงินทันที)', coupon: 'ส่วนลดคูปอง SCG Family', deposit: 'เงินมัดจำรับ',
};
/** GL keys that are empty: exports that need them must warn before writing (REQ-M12-03). */
export const missingGl = (gl: GlMap, keys: readonly (keyof GlMap)[]): (keyof GlMap)[] => keys.filter((k) => !String(gl[k] ?? '').trim());

// ---------- formatting ----------
export type ExportCell = string | number;
/** 'YYYY-MM-DD' → 'yyyymmdd' (PEAK). */
export const yyyymmdd = (iso: string): string => iso.slice(0, 10).replace(/-/g, '');
/** 'YYYY-MM-DD' → 'dd/mm/yyyy' in the Buddhist era (Express). */
export const thaiDateBE = (iso: string): string => {
  const [y, m, dd] = iso.slice(0, 10).split('-');
  return `${dd}/${m}/${Number(y) + 543}`;
};

/** CSV text that Excel opens as UTF-8 (BOM, CRLF, RFC 4180 quoting). */
export function csvUtf8(rows: readonly (readonly ExportCell[])[]): string {
  const cell = (v: ExportCell) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// ---------- PEAK headers ----------
const groupRow = (groups: readonly [string, number][]): string[] => groups.flatMap(([n, k]) => [n, ...Array<string>(k - 1).fill('')]);

export const PEAK_PRODUCT_HEAD: readonly (readonly string[])[] = [
  groupRow([['ลำดับที่*', 1], ['ข้อมูลทั่วไป', 4], ['ข้อมูลการซื้อ', 2], ['ข้อมูลการขาย', 2], ['การบันทึกบัญชี', 2], ['ส่วนการคำนวณต้นทุนขาย', 3], ['ยอดยกมา', 3], ['รหัสสินค้าอื่น', 4]]),
  ['', 'รหัสสินค้า', 'ชื่อสินค้า*', 'คำอธิบาย', 'ชื่อหน่วย', 'ราคาซื้อ/หน่วย', 'อัตราภาษีซื้อ', 'ราคาขาย/หน่วย', 'อัตราภาษีขาย', 'ผังบัญชีซื้อสินค้า', 'ผังบัญชีรายได้ขาย',
    'คำนวณต้นทุนขายหรือไม่', 'วิธีการคำนวณ', 'ผังบัญชีต้นทุนขาย', 'วันที่ซื้อ (yyyymmdd)', 'จำนวนหน่วย', 'ราคาต่อหน่วย', 'Shopee', 'Lazada', 'Tiktok', 'บาร์โค้ด'],
];

export const PEAK_CONTACT_HEAD: readonly (readonly string[])[] = [
  groupRow([['ลำดับที่*', 1], ['ข้อมูลผู้ติดต่อ', 9], ['ข้อมูลที่อยู่จดทะเบียน', 6], ['ข้อมูลที่อยู่จัดส่งเอกสาร', 6], ['ช่องทางติดต่อ', 4], ['ข้อมูลธนาคารของคู่ค้า', 4],
    ['ตั้งค่าครบกำหนดชำระ', 4], ['ตั้งค่าการบันทึกบัญชี', 2], ['ตั้งค่าวงเงินขายเชื่อ', 2], ['ข้อมูลบุคคลที่ติดต่อได้', 8], ['กลุ่ม', 1]]),
  ['', 'รหัสผู้ติดต่อ', 'ประเภทผู้ติดต่อ', 'สัญชาติ', 'Tax ID', 'สาขา', 'ประเภทกิจการ', 'คำนำหน้า', 'ชื่อ*', 'นามสกุล', 'ผู้ติดต่อ', 'ที่อยู่', 'แขวง/ตำบล', 'เขต/อำเภอ', 'จังหวัด', 'รหัสไปรษณีย์',
    'ผู้ติดต่อ', 'ที่อยู่', 'แขวง/ตำบล', 'เขต/อำเภอ', 'จังหวัด', 'รหัสไปรษณีย์', 'อีเมล', 'เบอร์โทร', 'เว็บไซต์', 'เบอร์แฟกซ์', 'ธนาคาร', 'ชื่อบัญชี', 'เลขที่บัญชี', 'เลขที่สาขา',
    'ครบกำหนดชำระใบแจ้งหนี้', 'ตัวแปร X', 'ครบกำหนดบันทึกรายจ่าย', 'ตัวแปร X', 'บันทึกบัญชีลูกหนี้', 'บันทึกบัญชีเจ้าหนี้', 'กำหนดวงเงิน', 'จำนวนเงิน',
    'คำนำหน้า', 'ชื่อจริง', 'นามสกุล', 'ชื่อเล่น', 'อีเมล', 'เบอร์โทร', 'ตำแหน่ง', 'แผนก', 'กลุ่ม'],
];

export const PEAK_DOC_HEAD: readonly (readonly string[])[] = [
  groupRow([['ลำดับที่*', 1], ['ข้อมูลเอกสาร', 9], ['รายการสินค้า/บริการ', 9], ['ข้อมูลเพิ่มเติม', 2]]),
  ['', 'วันที่เอกสาร* (yyyymmdd)', 'เลขที่เอกสาร', 'อ้างอิงถึง', 'รหัสผู้ติดต่อ', 'ชื่อผู้ติดต่อ*', 'เลขทะเบียน 13 หลัก', 'สาขา (5 หลัก)', 'วันที่ครบกำหนด (yyyymmdd)',
    'ประเภทราคา', 'รหัสสินค้า/บริการ', 'ชื่อสินค้า/บริการ*', 'ผังบัญชี', 'จำนวน*', 'ราคาต่อหน่วย*', 'ส่วนลดต่อรายการ', 'อัตราภาษี', 'มูลค่าก่อนภาษี', 'ภาษีมูลค่าเพิ่ม',
    'ส่วนลดท้ายบิล', 'หมายเหตุ'],
];

// ---------- PEAK products (21) ----------
export interface PeakProductIn {
  sku: string; name: string; description?: string; unit: string; buyPrice: Num; buyVat: 'v7' | 'exempt'; salePrice: Num; saleVat: 'v7' | 'exempt';
  isStock: boolean; barcode?: string | null; lots: { date: string; qty: Num; unitCost: Num }[];
}
const vatRate = (v: 'v7' | 'exempt') => (v === 'v7' ? '7%' : 'ไม่มี');
const f2 = (x: Num) => money(x);

export function peakProductRows(products: readonly PeakProductIn[], gl: GlMap): ExportCell[][] {
  const rows: ExportCell[][] = [];
  products.forEach((p, n) => {
    const lots = p.isStock ? p.lots : [];
    const lot = (l: PeakProductIn['lots'][number] | undefined): ExportCell[] => (l ? [yyyymmdd(l.date), f2(l.qty), f2(l.unitCost)] : ['', '', '']);
    rows.push([n + 1, p.sku, p.name, p.description ?? '', p.unit, f2(p.buyPrice), vatRate(p.buyVat), f2(p.salePrice), vatRate(p.saleVat), gl.buy, gl.sale,
      p.isStock ? 'คำนวณ' : 'ไม่คำนวณ', p.isStock ? 'FIFO' : '', p.isStock ? gl.cogs : '', ...lot(lots[0]), '', '', '', p.barcode ?? '']);
    for (const l of lots.slice(1)) rows.push([n + 1, ...Array<ExportCell>(13).fill(''), ...lot(l), '', '', '', '']);
  });
  return rows;
}

// ---------- PEAK contacts (47) ----------
export interface PeakContactIn {
  code: string; role: 'customer' | 'vendor'; name: string; taxId: string | null; branch: string | null; phone: string | null;
  term: PaymentTerm | null; creditLimit?: Num | null; group?: string;
}
const PEAK_TERM: Record<PaymentTerm['t'], string> = {
  cash: 'X วันหลังวันที่ออกเอกสาร', days: 'X วันหลังวันที่ออกเอกสาร', nextDay: 'วันที่ X ของเดือนถัดไป', eom: 'สิ้นเดือนของวันที่ออกเอกสาร', eonm: 'สิ้นเดือนของเดือนถัดไป',
};
const termCells = (t: PaymentTerm | null): ExportCell[] => {
  const tm = t ?? { t: 'cash' as const };
  return [PEAK_TERM[tm.t], tm.t === 'days' || tm.t === 'nextDay' ? tm.x : tm.t === 'cash' ? 0 : ''];
};

/** Juristic person when the 13-digit tax ID starts with 0 (Revenue Department numbering), else an individual. */
export const entityType = (taxId: string | null): string => (!taxId ? '' : taxId.startsWith('0') ? 'นิติบุคคล' : 'บุคคลธรรมดา');

export function peakContactRows(contacts: readonly PeakContactIn[], gl: GlMap): ExportCell[][] {
  const none: ExportCell[] = ['ตามการตั้งค่าของกิจการ', ''];
  return contacts.map((c, i) => {
    const isV = c.role === 'vendor';
    const ent = entityType(c.taxId);
    const juristic = ent === 'นิติบุคคล';
    const limit = c.creditLimit != null && d(c.creditLimit).gt(0) ? money(c.creditLimit) : '';
    const row: ExportCell[] = [
      i + 1, c.code, isV ? 'ผู้ขาย' : 'ลูกค้า', 'ไทย', c.taxId ?? '', juristic ? (c.branch ?? '00000') : '', ent, '', c.name, '',
      '', '', '', '', '', '', // registered address (not kept in this edition)
      '', '', '', '', '', '', // mailing address
      '', c.phone ?? '', '', '', // channels
      '', '', '', '', // bank
      ...(isV ? none : termCells(c.term)), ...(isV ? termCells(c.term) : none),
      gl.ar, gl.ap,
      isV ? 'ค่าเริ่มต้น' : limit ? 'กำหนดเอง' : 'ค่าเริ่มต้น', isV ? '' : limit,
      '', '', '', '', '', '', '', '', // contact person
      c.group ?? '',
    ];
    return row;
  });
}

// ---------- PEAK sales / purchase documents (21) ----------
export interface PeakDocLineIn { sku: string; name: string; qty: Num; unitPrice: Num; discount: Num; vat: 'v7' | 'exempt'; exVat: Num; lineVat: Num; account?: string }
export interface PeakDocIn {
  date: string; no: string; ref?: string | null; contactCode: string; contactName: string; taxId: string | null; branch: string | null; dueDate?: string | null;
  vatMode: 'inc' | 'exc' | 'none'; billDiscount: Num; note?: string; lines: PeakDocLineIn[];
}
const PRICE_TYPE = { inc: 'รวมภาษี', exc: 'แยกภาษี', none: 'ไม่มีภาษี' } as const;

/** Splits a document's VAT over its lines in proportion to their ex-VAT value; the last 7% line takes the rounding remainder. */
export function lineVatShares(docVat: Num, lines: readonly { exVat: Num; vat: 'v7' | 'exempt' }[]): Money[] {
  const v7 = lines.map((l, i) => ({ l, i })).filter((x) => x.l.vat === 'v7');
  const pool = sum(v7.map((x) => x.l.exVat));
  const out = lines.map(() => '0.00');
  let given = d(0);
  v7.forEach((x, k) => {
    const s = k === v7.length - 1 ? d(docVat).minus(given) : pool.isZero() ? d(0) : round2(d(x.l.exVat).times(d(docVat)).div(pool));
    given = given.plus(s);
    out[x.i] = money(s);
  });
  return out;
}

export function peakDocRows(docs: readonly PeakDocIn[], account: string): ExportCell[][] {
  const rows: ExportCell[][] = [];
  docs.forEach((doc, n) => {
    doc.lines.forEach((l, j) => {
      const first = j === 0;
      rows.push([
        n + 1, first ? yyyymmdd(doc.date) : '', first ? doc.no : '', first ? (doc.ref ?? '') : '', first ? doc.contactCode : '', first ? doc.contactName : '',
        first ? (doc.taxId ?? '') : '', first && doc.taxId ? (doc.branch || '00000') : '', first && doc.dueDate ? yyyymmdd(doc.dueDate) : '',
        first ? PRICE_TYPE[doc.vatMode] : '',
        l.sku, l.name, l.account ?? account, qty4(l.qty), qty4(l.unitPrice), money(l.discount), doc.vatMode === 'none' ? 'ไม่มี' : vatRate(l.vat), money(l.exVat), money(l.lineVat),
        first ? money(doc.billDiscount) : '', first ? (doc.note ?? '') : '',
      ]);
    });
  });
  return rows;
}

/**
 * PEAK accepts at most `max` data rows per file. Rows sharing ลำดับที่ (column 0) stay in one file and
 * ลำดับที่ restarts at 1 in every file. Returns the data rows of each file (headers are added by the caller).
 */
export function splitPeakFiles(rows: readonly ExportCell[][], max = 1000): ExportCell[][][] {
  const groups: ExportCell[][][] = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last[0]![0] === r[0]) last.push(r);
    else groups.push([r]);
  }
  const files: ExportCell[][][] = [];
  let cur: ExportCell[][][] = [];
  let count = 0;
  for (const g of groups) {
    if (g.length > max) throw new RangeError(`One record has ${g.length} rows, more than ${max} per file`);
    if (count + g.length > max) {
      files.push(renumber(cur));
      cur = [];
      count = 0;
    }
    cur.push(g);
    count += g.length;
  }
  if (cur.length || !files.length) files.push(renumber(cur));
  return files;
}
const renumber = (groups: ExportCell[][][]): ExportCell[][] => groups.flatMap((g, i) => g.map((r) => [i + 1, ...r.slice(1)]));

// ---------- FlowAccount / Express / generic (document level) ----------
export interface DocTotalsIn { date: string; no: string; type: string; contactCode: string; contactName: string; taxId: string | null; base7: Num; exempt: Num; vat: Num; total: Num; status?: 'active' | 'void' }
const sign = (t: string) => (t === 'CN' ? -1 : 1);
const signed = (x: Num, t: string) => money(d(x).times(sign(t)));

export const EXPRESS_HEAD = ['DOCNUM', 'DOCDAT', 'CUSCOD', 'AMOUNT', 'VATAMT', 'NETAMT'] as const;
export const expressRows = (docs: readonly DocTotalsIn[]): ExportCell[][] =>
  docs.map((x) => [x.no, thaiDateBE(x.date), x.contactCode, signed(d(x.base7).plus(d(x.exempt)), x.type), signed(x.vat, x.type), signed(x.total, x.type)]);

export const FLOWACCOUNT_HEAD = ['documentSerial', 'publishedOn', 'contactName', 'subTotal', 'vatAmount', 'grandTotal'] as const;
export const flowAccountRows = (docs: readonly DocTotalsIn[]): ExportCell[][] =>
  docs.map((x) => [x.no, x.date.slice(0, 10), x.contactName, signed(d(x.base7).plus(d(x.exempt)), x.type), signed(x.vat, x.type), signed(x.total, x.type)]);

export const GENERIC_BOOK_HEAD = ['เลขที่', 'วันที่', 'ประเภท', 'รหัสผู้ติดต่อ', 'ชื่อผู้ติดต่อ', 'เลขผู้เสียภาษี', 'มูลค่า VAT 7%', 'ยกเว้น/ไม่มี VAT', 'VAT', 'รวม', 'สถานะ'] as const;
export const genericBookRows = (docs: readonly DocTotalsIn[]): ExportCell[][] =>
  docs.map((x) => {
    const live = x.status !== 'void';
    const z = (v: Num) => (live ? signed(v, x.type) : '0.00');
    return [x.no, thaiDateBE(x.date), x.type, x.contactCode, x.contactName, x.taxId ?? '', z(x.base7), z(x.exempt), z(x.vat), z(x.total), live ? 'ปกติ' : 'ยกเลิก'];
  });

// ---------- general journal (REQ-M12-03) ----------
export interface JournalLine { date: string; no: string; account: string; label: string; debit: Money; credit: Money }
export interface JournalDocIn { date: string; no: string; side: 'sale' | 'purchase'; type: string; paid: boolean; base7: Num; exempt: Num; vat: Num; total: Num; discount?: Num }
export const JOURNAL_HEAD = ['วันที่', 'เลขที่', 'บัญชี', 'รายการ', 'เดบิต', 'เครดิต'] as const;

/** Double entry per document; throws if a document does not balance (debit = credit is an invariant). */
export function journalLines(docs: readonly JournalDocIn[], gl: GlMap): JournalLine[] {
  const out: JournalLine[] = [];
  for (const x of docs) {
    const net = d(x.base7).plus(d(x.exempt));
    const lines: { account: string; label: string; dr: ReturnType<typeof d>; cr: ReturnType<typeof d> }[] = [];
    const z = d(0);
    if (x.side === 'sale') {
      const cash = { account: x.paid ? gl.cash : gl.ar, label: x.paid ? GL_LABELS.cash : GL_LABELS.ar };
      const entries = [
        { ...cash, amt: d(x.total), debit: true },
        { account: gl.sale, label: GL_LABELS.sale, amt: net, debit: false },
        { account: gl.vatOut, label: GL_LABELS.vatOut, amt: d(x.vat), debit: false },
      ];
      const flip = x.type === 'CN';
      for (const e of entries) if (!e.amt.isZero()) lines.push({ account: e.account, label: e.label, dr: e.debit !== flip ? e.amt : z, cr: e.debit !== flip ? z : e.amt });
    } else {
      const disc = d(x.discount ?? 0);
      const entries = [
        { account: gl.buy, label: GL_LABELS.buy, amt: net.plus(disc), debit: true },
        { account: gl.vatIn, label: GL_LABELS.vatIn, amt: d(x.vat), debit: true },
        { account: gl.pdisc, label: GL_LABELS.pdisc, amt: disc, debit: false },
        { account: x.paid ? gl.cash : gl.ap, label: x.paid ? GL_LABELS.cash : GL_LABELS.ap, amt: d(x.total), debit: false },
      ];
      for (const e of entries) if (!e.amt.isZero()) lines.push({ account: e.account, label: e.label, dr: e.debit ? e.amt : z, cr: e.debit ? z : e.amt });
    }
    const dr = sum(lines.map((l) => l.dr));
    const cr = sum(lines.map((l) => l.cr));
    if (!dr.eq(cr)) throw new RangeError(`Journal for ${x.no} does not balance: debit ${money(dr)} credit ${money(cr)}`);
    for (const l of lines) out.push({ date: x.date, no: x.no, account: l.account, label: l.label, debit: l.dr.isZero() ? '' : money(l.dr), credit: l.cr.isZero() ? '' : money(l.cr) });
  }
  return out;
}
export const journalRows = (lines: readonly JournalLine[]): ExportCell[][] => lines.map((l) => [thaiDateBE(l.date), l.no, l.account, l.label, l.debit, l.credit]);
