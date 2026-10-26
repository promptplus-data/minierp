import { describe, expect, it } from 'vitest';
import { DEFAULT_DOC_PATTERN, docPeriodKey, formatDocNo } from './docno';

describe('formatDocNo', () => {
  it('default pattern matches mockup numbers like INV2610-0040', () => {
    expect(formatDocNo(DEFAULT_DOC_PATTERN, { type: 'INV', date: '2026-10-21', seq: 40 })).toBe('INV2610-0040');
  });
  it('supports all tokens', () => {
    expect(formatDocNo('{T}-{YYYY}{MM}{DD}-{NN}', { type: 'QT', date: '2026-03-07', seq: 5 })).toBe('QT-20260307-05');
    expect(formatDocNo('{T}{BBBB}/{NNNN}', { type: 'ABB', date: '2026-10-26', seq: 12 })).toBe('ABB2569/0012');
    expect(formatDocNo('{T}{DEV}-{YY}{MM}-{NNNN}', { type: 'ABB', date: '2026-10-26', seq: 1, device: 'P01' })).toBe('ABBP01-2610-0001');
  });
  it('seq wider than padding is not truncated', () => {
    expect(formatDocNo('{T}{NN}', { type: 'X', date: '2026-01-01', seq: 1234 })).toBe('X1234');
  });
});

describe('docPeriodKey', () => {
  it('counter resets by the smallest period in the pattern', () => {
    expect(docPeriodKey('{T}{YY}{MM}-{NNNN}', '2026-10-26')).toBe('2026-10');
    expect(docPeriodKey('{T}{YYYY}{MM}{DD}{NN}', '2026-10-26')).toBe('2026-10-26');
    expect(docPeriodKey('{T}{BBBB}-{NNNN}', '2026-10-26')).toBe('2026');
    expect(docPeriodKey('{T}-{NNNNNN}', '2026-10-26')).toBe('ALL');
  });
});
