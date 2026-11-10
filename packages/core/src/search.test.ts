import { describe, expect, it } from 'vitest';
import { matchesSearch, searchRank, searchTokens } from './search';

describe('search', () => {
  it('segments Thai words', () => {
    expect(searchTokens('ปูนซีเมนต์ตราช้าง')).toEqual(['ปูนซีเมนต์', 'ตรา', 'ช้าง']);
    expect(searchTokens('  PVC  ท่อ ')).toEqual(['pvc', 'ท่อ']);
  });
  it('matches parts of Thai words in any order', () => {
    const name = 'ปูนซีเมนต์ตราช้าง 50 กก.';
    expect(matchesSearch(name, 'ปูนช้าง')).toBe(true);
    expect(matchesSearch(name, 'ช้าง ปูน')).toBe(true);
    expect(matchesSearch(name, 'ซีเมนต์')).toBe(true);
    expect(matchesSearch(name, 'ตราเสือ')).toBe(false);
    expect(matchesSearch(name, '')).toBe(true);
  });
  it('matches codes and phones ignoring case and spaces', () => {
    expect(matchesSearch('C00012 บจก.สมหวังก่อสร้าง 081-234-5678', 'c0001')).toBe(true);
    expect(matchesSearch('MK-POST-15 เสาหล่อ', 'mk post')).toBe(true);
    expect(matchesSearch('สมหวัง ก่อสร้าง', 'สมหวังก่อสร้าง')).toBe(true);
  });
  it('ranks prefix first', () => {
    expect(searchRank('ท่อ PVC', 'ท่อ')).toBe(0);
    expect(searchRank('ข้อต่อท่อ', 'ท่อ')).toBe(1);
    expect(searchRank('ท่อ', 'ปูน')).toBe(9);
  });
});
