import { describe, expect, it } from 'vitest';
import { dueDate, termLabel } from './terms';

describe('dueDate', () => {
  it('cash and X days', () => {
    expect(dueDate('2026-10-26', { t: 'cash' })).toBe('2026-10-26');
    expect(dueDate('2026-10-26', null)).toBe('2026-10-26');
    expect(dueDate('2026-10-26', { t: 'days', x: 30 })).toBe('2026-11-25');
    expect(dueDate('2026-12-15', { t: 'days', x: 30 })).toBe('2027-01-14');
  });
  it('day X of next month, clamped to month length', () => {
    expect(dueDate('2026-10-26', { t: 'nextDay', x: 5 })).toBe('2026-11-05');
    expect(dueDate('2026-01-31', { t: 'nextDay', x: 31 })).toBe('2026-02-28');
    expect(dueDate('2028-01-10', { t: 'nextDay', x: 30 })).toBe('2028-02-29');
    expect(dueDate('2026-12-01', { t: 'nextDay', x: 10 })).toBe('2027-01-10');
  });
  it('eom = end of the document month (mockup), eonm = end of next month', () => {
    expect(dueDate('2026-01-31', { t: 'eom' })).toBe('2026-01-31');
    expect(dueDate('2026-01-01', { t: 'eom' })).toBe('2026-01-31');
    expect(dueDate('2028-02-10', { t: 'eom' })).toBe('2028-02-29');
    expect(dueDate('2026-02-10', { t: 'eom' })).toBe('2026-02-28');
    expect(dueDate('2026-01-31', { t: 'eonm' })).toBe('2026-02-28');
    expect(dueDate('2028-01-31', { t: 'eonm' })).toBe('2028-02-29');
    expect(dueDate('2026-12-31', { t: 'eonm' })).toBe('2027-01-31');
  });
  it('labels', () => {
    expect(termLabel({ t: 'cash' })).toBe('เงินสด');
    expect(termLabel({ t: 'days', x: 30 })).toBe('เครดิต 30 วัน');
    expect(termLabel({ t: 'nextDay', x: 5 })).toBe('วันที่ 5 ของเดือนถัดไป');
    expect(termLabel({ t: 'eom' })).toBe('สิ้นเดือน');
    expect(termLabel({ t: 'eonm' })).toBe('สิ้นเดือนถัดไป');
  });
  it('rejects malformed dates', () => {
    expect(() => dueDate('26/10/2026', { t: 'days', x: 1 })).toThrow(RangeError);
  });
});
