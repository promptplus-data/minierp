/**
 * Cell-level parsing rules for file imports (M04 Import Hub, M19-08 delivery files): numbers with thousands
 * separators / baht sign, dates in ISO, DD/MM/YYYY (CE or BE), yyyymmdd or Excel serial, VAT flags, Thai tax ids,
 * header matching and unit-name matching. Pure: no I/O, no clock.
 */
import { ymd } from './dates';
import { d } from './money';

export type Cell = string | number | boolean | Date | null | undefined;

const isValidYmd = (y: number, m: number, dd: number) => {
  if (m < 1 || m > 12 || dd < 1 || dd > 31 || y < 1900 || y > 2200) return false;
  return ymd(y, m, dd) === `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
};
const iso = (y: number, m: number, dd: number) => (isValidYmd(y, m, dd) ? ymd(y, m, dd) : null);
/** Year ≥ 2400 is Buddhist era. */
const ce = (y: number) => (y >= 2400 ? y - 543 : y);

/** Excel serial day (1900 date system) → 'YYYY-MM-DD'. */
export function excelSerialDate(n: number): string | null {
  if (!Number.isFinite(n) || n < 1 || n > 200000) return null;
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 864e5).toISOString().slice(0, 10);
}

/**
 * Date cell → 'YYYY-MM-DD' or null. Accepts Date objects, Excel serials, 'YYYY-MM-DD', 'yyyymmdd',
 * 'DD/MM/YYYY' / 'DD-MM-YYYY' / 'DD.MM.YYYY' (CE or BE; 2-digit years are not accepted).
 */
export function parseDateCell(v: Cell): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'number') return Number.isInteger(v) && v >= 19000101 && v <= 25991231 ? parseDateCell(String(v)) : excelSerialDate(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (r) return iso(ce(+r[1]!), +r[2]!, +r[3]!);
  r = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (r) return iso(ce(+r[1]!), +r[2]!, +r[3]!);
  r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (r) return iso(ce(+r[3]!), +r[2]!, +r[1]!);
  if (/^\d+(\.\d+)?$/.test(s)) return excelSerialDate(Number(s));
  return null;
}

/**
 * Number cell → decimal string or null. Strips '฿', spaces and thousands commas ("1,250.50" → "1250.50");
 * accepts a leading minus. Numbers from XLSX cells pass through.
 */
export function parseNumberCell(v: Cell): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? d(v).toFixed() : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/[฿\s]/g, '').replace(/^(-?)\(?(.*?)\)?$/, '$1$2');
  if (!/^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(s)) return null;
  return d(s.replace(/,/g, '')).toFixed();
}

/** Plain text cell, trimmed ('' for empty). Numbers keep their digits (codes such as 8100234561). */
export function textCell(v: Cell): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : d(v).toFixed();
  return String(v).trim();
}

/** VAT flag in a delivery file: Y / inc / รวม = price includes VAT; N / exc / ไม่รวม; none. Unknown → null. */
export function parseVatFlag(v: Cell): 'inc' | 'exc' | 'none' | null {
  const s = textCell(v).toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (['y', 'yes', 'inc', 'incl', 'included', 'รวม', 'รวมvat', 'true', '1'].includes(s)) return 'inc';
  if (['n', 'no', 'exc', 'excl', 'excluded', 'ไม่รวม', 'ไม่รวมvat', 'false', '0'].includes(s)) return 'exc';
  if (['none', 'novat', 'ไม่มี', 'ไม่มีvat'].includes(s)) return 'none';
  return null;
}

/** Thai tax id: 13 digits with the mod-11 check digit. */
export function taxIdValid(s: string): boolean {
  if (!/^\d{13}$/.test(s)) return false;
  let total = 0;
  for (let i = 0; i < 12; i++) total += Number(s[i]) * (13 - i);
  return (11 - (total % 11)) % 10 === Number(s[12]);
}

/** Header normalisation: trim, lower case, drop spaces / underscores / dots. */
export const normHeader = (s: string): string => s.trim().toLowerCase().replace(/[\s_.\-()/]+/g, '');

/**
 * Guesses column → field from header names. `fields` lists each field with the header aliases it accepts.
 * Returns field → column index (first matching column; each column used once).
 */
export function guessMapping(headers: readonly string[], fields: readonly { key: string; aliases: readonly string[] }[]): Record<string, number> {
  const out: Record<string, number> = {};
  const used = new Set<number>();
  const norm = headers.map(normHeader);
  for (const f of fields) {
    const want = new Set([f.key, ...f.aliases].map(normHeader));
    const i = norm.findIndex((h, j) => !used.has(j) && want.has(h));
    if (i >= 0) {
      out[f.key] = i;
      used.add(i);
    }
  }
  return out;
}

/** Unit synonyms (Thai ↔ English) used when matching a file's unit text to a product unit name. */
const UNIT_SYNONYMS: readonly (readonly string[])[] = [
  ['ถุง', 'bag', 'bags'], ['แผ่น', 'sheet', 'sheets', 'pcs.sheet'], ['ชิ้น', 'pc', 'pcs', 'piece', 'ea', 'each'],
  ['เส้น', 'bar', 'rod', 'length'], ['พาเลท', 'pallet', 'plt'], ['ก้อน', 'block', 'blocks'], ['ถัง', 'bucket', 'pail', 'can'],
  ['คิว', 'cu.m', 'cum', 'm3', 'ลบ.ม.'], ['มัด', 'bundle', 'bdl'], ['กล่อง', 'box', 'carton', 'ctn'], ['ม้วน', 'roll'],
  ['เมตร', 'm', 'meter', 'metre'], ['กก.', 'kg', 'กิโลกรัม'], ['ตัน', 'ton', 'tonne'], ['วง', 'ring'], ['ต้น', 'post'],
];
const unitKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '');

/** Index of the product unit matching a file unit text (exact, then synonyms, then prefix), or -1. */
export function matchUnit(text: string, units: readonly { name: string }[]): number {
  const t = unitKey(text);
  if (!t) return -1;
  const names = units.map((u) => unitKey(u.name));
  let i = names.indexOf(t);
  if (i >= 0) return i;
  const group = UNIT_SYNONYMS.find((g) => g.some((x) => unitKey(x) === t));
  if (group) {
    i = names.findIndex((n) => group.some((x) => unitKey(x) === n || n.startsWith(unitKey(x))));
    if (i >= 0) return i;
  }
  return names.findIndex((n) => n.startsWith(t) || t.startsWith(n));
}

/** Price incl. VAT → ex VAT (VAT shop), up to 4 dp half-up: 129.47 → "121". */
export const exVat = (price: string): string => d(price).div('1.07').toDecimalPlaces(4).toFixed();
