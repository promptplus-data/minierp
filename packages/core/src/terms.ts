import { addDays, parseISODate, ymd } from './dates';

/**
 * Payment terms, same set as PEAK (mockup `TERMS`):
 * cash, X days after doc date, day X of next month, end of the doc's month, end of next month.
 */
export type PaymentTerm =
  | { t: 'cash' }
  | { t: 'days'; x: number }
  | { t: 'nextDay'; x: number }
  | { t: 'eom' }
  | { t: 'eonm' };

/** Due date. Mirrors mockup `dueDate`. */
export function dueDate(docDate: string, term: PaymentTerm | null | undefined): string {
  if (!term || term.t === 'cash') return docDate;
  if (term.t === 'days') return addDays(docDate, term.x || 0);
  const { y, m } = parseISODate(docDate);
  switch (term.t) {
    case 'nextDay': {
      const last = +ymd(y, m + 2, 0).slice(8);
      return ymd(y, m + 1, Math.min(term.x || 1, last));
    }
    case 'eom':
      return ymd(y, m + 1, 0);
    case 'eonm':
      return ymd(y, m + 2, 0);
  }
}

/** Thai label shown on documents. Mirrors mockup `termLabel`. */
export function termLabel(term: PaymentTerm | null | undefined): string {
  if (!term || term.t === 'cash') return 'เงินสด';
  switch (term.t) {
    case 'days': return `เครดิต ${term.x} วัน`;
    case 'nextDay': return `วันที่ ${term.x} ของเดือนถัดไป`;
    case 'eom': return 'สิ้นเดือน';
    case 'eonm': return 'สิ้นเดือนถัดไป';
  }
}
