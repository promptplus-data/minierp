import { describe, expect, it } from 'vitest';
import { InsufficientStockError, movingAverage, takeLots, type Lot } from './fifo';

const lots: Lot[] = [
  { id: 'L2', receivedAt: '2026-10-05', qty: '100', unitCost: '130' },
  { id: 'L1', receivedAt: '2026-10-01', qty: '100', unitCost: '120' },
];

describe('takeLots (BR-07)', () => {
  it('BRD: 100@120 + 100@130, take 150 → COGS 18,500, oldest first', () => {
    const r = takeLots(lots, 150);
    expect(r.cogs).toBe('18500.00');
    expect(r.takes).toEqual([
      { lotId: 'L1', qty: '100', unitCost: '120' },
      { lotId: 'L2', qty: '50', unitCost: '130' },
    ]);
  });
  it('ties on date break by numeric id (L2 before L10)', () => {
    const r = takeLots([
      { id: 'L10', receivedAt: '2026-10-01', qty: 5, unitCost: 2 },
      { id: 'L2', receivedAt: '2026-10-01', qty: 5, unitCost: 1 },
    ], 5);
    expect(r.takes[0]!.lotId).toBe('L2');
  });
  it('exactly exhausting all lots works', () => {
    const r = takeLots(lots, '200');
    expect(r.cogs).toBe('25000.00');
    expect(r.takes).toHaveLength(2);
  });
  it('throws InsufficientStockError with need/have; negative stock forbidden', () => {
    expect(() => takeLots(lots, '200.0001')).toThrow(InsufficientStockError);
    try { takeLots(lots, 250); } catch (e) {
      expect(e).toBeInstanceOf(InsufficientStockError);
      expect((e as InsufficientStockError).need).toBe('250');
      expect((e as InsufficientStockError).have).toBe('200');
    }
    expect(() => takeLots([], 1)).toThrow(InsufficientStockError);
  });
  it('zero qty takes nothing; empty and depleted lots are skipped', () => {
    expect(takeLots(lots, 0)).toEqual({ takes: [], cogs: '0.00' });
    const r = takeLots([{ id: 'L0', receivedAt: '2026-01-01', qty: 0, unitCost: 1 }, ...lots], 1);
    expect(r.takes[0]!.lotId).toBe('L1');
  });
  it('fractional quantities are exact', () => {
    const r = takeLots([{ id: 'A', receivedAt: '2026-01-01', qty: '0.3', unitCost: '10.1' }, { id: 'B', receivedAt: '2026-01-02', qty: '1', unitCost: '3' }], '0.4');
    expect(r.takes.map((t) => t.qty)).toEqual(['0.3', '0.1']);
    expect(r.cogs).toBe('3.33');
  });
  it('rejects negative qty', () => {
    expect(() => takeLots(lots, -1)).toThrow(RangeError);
  });
});

describe('movingAverage', () => {
  it('BRD: 100@120 + 100@130 → 125', () => {
    expect(movingAverage(100, 120, 100, 130)).toBe('125');
  });
  it('keeps 4 dp; treats negative prior stock as zero; first receipt takes incoming cost', () => {
    expect(movingAverage(3, 10, 4, 11)).toBe('10.5714');
    expect(movingAverage(-5, 99, 10, 12)).toBe('12');
    expect(movingAverage(0, 0, 0, 7)).toBe('7');
  });
});
