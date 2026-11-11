import { describe, expect, it } from 'vitest';
import { poOverQty, poShortfall, poStatus } from './purchaseorder';

describe('purchase order status', () => {
  it('open until something arrives, partial, then received when every line is complete', () => {
    expect(poStatus('open', [{ qty: '10', received: '0' }, { qty: '5', received: '0' }])).toBe('open');
    expect(poStatus('open', [{ qty: '10', received: '4' }, { qty: '5', received: '0' }])).toBe('partial');
    expect(poStatus('partial', [{ qty: '10', received: '10' }, { qty: '5', received: '5' }])).toBe('received');
  });
  it('a voided receipt rolls received back to partial / open', () => {
    expect(poStatus('received', [{ qty: '10', received: '4' }])).toBe('partial');
    expect(poStatus('partial', [{ qty: '10', received: '0' }])).toBe('open');
  });
  it('closed and void stay as they are', () => {
    expect(poStatus('closed', [{ qty: '10', received: '10' }])).toBe('closed');
    expect(poStatus('void', [{ qty: '10', received: '0' }])).toBe('void');
  });
});

describe('shortfall to order', () => {
  it('ordered minus available, never below zero', () => {
    expect(poShortfall('10', '4')).toBe('6');
    expect(poShortfall('10', '12')).toBe('0');
  });
  it('negative available (over-reserved) counts as zero', () => {
    expect(poShortfall('10', '-3')).toBe('10');
  });
  it('subtracts what is already on order (unreceived), never below zero', () => {
    expect(poShortfall('10', '4', '3')).toBe('3');
    expect(poShortfall('10', '4', '8')).toBe('0');
    expect(poShortfall('10', '-2', '4')).toBe('6');
  });
});

describe('poOverQty', () => {
  it('excess beyond the ordered qty, counting only what this receipt adds', () => {
    expect(poOverQty('10', '4', '6')).toBe('0');
    expect(poOverQty('10', '4', '7')).toBe('1');
    expect(poOverQty('10', '12', '3')).toBe('3'); // already over: everything more is over
  });
});
