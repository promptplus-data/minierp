import { describe, expect, it } from 'vitest';
import { poShortfall, poStatus } from './purchaseorder';

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
});
