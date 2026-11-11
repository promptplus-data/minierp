import { describe, expect, it } from 'vitest';
import { returnArSplit } from './arreturn';

describe('return against an owed bill', () => {
  it('all of it reduces the receivable while the bill is owed', () => {
    expect(returnArSplit('300', '1000')).toEqual({ toAr: '300.00', over: '0.00' });
  });
  it('only up to what is still owed; the rest goes back to the customer', () => {
    expect(returnArSplit('300', '120.50')).toEqual({ toAr: '120.50', over: '179.50' });
  });
  it('a paid bill (or a cash bill) refunds everything', () => {
    expect(returnArSplit('300', '0')).toEqual({ toAr: '0.00', over: '300.00' });
    expect(returnArSplit('300', '-5')).toEqual({ toAr: '0.00', over: '300.00' });
  });
});
