import { parseISODate } from './dates';

export const DEFAULT_DOC_PATTERN = '{T}{YY}{MM}-{NNNN}';

export interface DocNoParts {
  /** Document type prefix, e.g. 'INV', 'ABB', 'QT'. */
  type: string;
  /** Document date 'YYYY-MM-DD'. */
  date: string;
  /** Running number within the counter bucket (see docPeriodKey). */
  seq: number;
  /** POS device code for offline numbering, used by {DEV}. */
  device?: string;
}

/**
 * Document number (mockup `fmtNo`). Tokens:
 * {T} type, {YYYY} year, {BBBB} Buddhist year, {YY}, {MM}, {DD}, {DEV} device, {N…} zero-padded seq.
 */
export function formatDocNo(pattern: string, p: DocNoParts): string {
  const { y, m, d } = parseISODate(p.date);
  const yyyy = String(y).padStart(4, '0');
  const pad = (n: number) => String(n).padStart(2, '0');
  return pattern
    .replace(/\{T\}/g, p.type)
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{BBBB\}/g, String(y + 543))
    .replace(/\{YY\}/g, yyyy.slice(2))
    .replace(/\{MM\}/g, pad(m))
    .replace(/\{DD\}/g, pad(d))
    .replace(/\{DEV\}/g, p.device ?? '')
    .replace(/\{(N+)\}/g, (_, k: string) => String(p.seq).padStart(k.length, '0'));
}

/**
 * Counter bucket implied by the pattern: the running number restarts whenever this key changes.
 * Day token → 'YYYY-MM-DD', month → 'YYYY-MM', year → 'YYYY', none → 'ALL'.
 * Combine with type (and device when {DEV} is used) to form the full counter key.
 */
export function docPeriodKey(pattern: string, date: string): string {
  const iso = date.slice(0, 10);
  parseISODate(iso);
  if (pattern.includes('{DD}')) return iso;
  if (pattern.includes('{MM}')) return iso.slice(0, 7);
  if (/\{(YYYY|YY|BBBB)\}/.test(pattern)) return iso.slice(0, 4);
  return 'ALL';
}
