/**
 * Partial search with Thai word segmentation (REQ: every picker searches by part of a word, Thai has no spaces).
 * "ปูนช้าง" finds "ปูนซีเมนต์ตราช้าง": the query is split into words, and a row matches when it contains the whole
 * query, or every word of it, anywhere (case-insensitive). Used by the web pickers and by the server's ILIKE filters.
 */

const seg: Intl.Segmenter | null = (() => {
  try {
    return typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
  } catch {
    return null;
  }
})();

/** Lower-cases, trims and folds runs of whitespace; drops zero-width characters often pasted with Thai text. */
export function normSearch(s: string | null | undefined): string {
  return (s ?? '').replace(/[​-‍﻿]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Words of a query: split on whitespace, then each chunk by the Thai/ICU word segmenter. Punctuation is dropped. */
export function searchTokens(q: string | null | undefined): string[] {
  const out: string[] = [];
  for (const chunk of normSearch(q).split(' ').filter(Boolean)) {
    if (!seg || /^[\x20-\x7e]+$/.test(chunk)) {
      out.push(chunk);
      continue;
    }
    for (const s of seg.segment(chunk)) if (s.isWordLike !== false && s.segment.trim()) out.push(s.segment);
  }
  return [...new Set(out)];
}

/** True when `hay` contains the whole query or every token of it. An empty query matches everything. */
export function matchesSearch(hay: string | null | undefined, q: string | null | undefined): boolean {
  const n = normSearch(q);
  if (!n) return true;
  const h = normSearch(hay);
  if (h.includes(n) || h.replace(/ /g, '').includes(n.replace(/ /g, ''))) return true;
  const toks = searchTokens(n);
  return toks.length > 0 && toks.every((t) => h.includes(t));
}

/** Rank for sorting matches: prefix of the whole text 0, whole query inside 1, token match 2, no match 9. */
export function searchRank(hay: string | null | undefined, q: string | null | undefined): number {
  const n = normSearch(q);
  if (!n) return 0;
  const h = normSearch(hay);
  if (h.startsWith(n)) return 0;
  if (h.includes(n)) return 1;
  return matchesSearch(h, n) ? 2 : 9;
}
