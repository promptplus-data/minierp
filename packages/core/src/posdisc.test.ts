import { describe, expect, it } from 'vitest';
import { approverCovers, discReasonText, margin, needsOverride, scopeCovers } from './posdisc';

describe('POS manager override (M07)', () => {
  const scope = { maxAmount: '100', maxPct: '10', prices: [{ productId: 'p1', unitIdx: 0, price: '90' }] };
  it('covers a discount at or below the approved amount and %', () => {
    const c = { checkDiscount: true, checkPrices: false };
    expect(scopeCovers(scope, { gross: '1000', discount: '100', prices: [] }, c)).toEqual({ ok: true });
    expect(scopeCovers(scope, { gross: '1000', discount: '50', prices: [] }, c)).toEqual({ ok: true });
    expect(scopeCovers(scope, { gross: '1000', discount: '100.01', prices: [] }, c)).toMatchObject({ ok: false, why: 'DISCOUNT' });
    // fewer items: same amount is now a larger share of the bill → re-ask
    expect(scopeCovers(scope, { gross: '500', discount: '100', prices: [] }, c)).toMatchObject({ ok: false, why: 'DISCOUNT' });
  });
  it('covers a changed price at or above the approved price only', () => {
    const c = { checkDiscount: false, checkPrices: true };
    expect(scopeCovers(scope, { gross: '0', discount: '0', prices: [{ productId: 'p1', unitIdx: 0, price: '95' }] }, c).ok).toBe(true);
    expect(scopeCovers(scope, { gross: '0', discount: '0', prices: [{ productId: 'p1', unitIdx: 0, price: '89.99' }] }, c)).toMatchObject({ ok: false, why: 'PRICE', productId: 'p1' });
    expect(scopeCovers(scope, { gross: '0', discount: '0', prices: [{ productId: 'p1', unitIdx: 1, price: '95' }] }, c).ok).toBe(false);
    expect(scopeCovers(scope, { gross: '0', discount: '0', prices: [{ productId: 'p2', unitIdx: 0, price: '95' }] }, c).ok).toBe(false);
  });
  it('needs an override over the role cap or for a price change without pos.price', () => {
    expect(needsOverride({ gross: '1000', discount: '1', prices: [] }, 0, false)).toMatchObject({ discount: true, price: false });
    expect(needsOverride({ gross: '1000', discount: '100', prices: [] }, 10, false)).toMatchObject({ discount: false, pct: '10' });
    expect(needsOverride({ gross: '1000', discount: '0', prices: [{ productId: 'p', unitIdx: 0, price: 1 }] }, 0, false).price).toBe(true);
    expect(needsOverride({ gross: '1000', discount: '0', prices: [{ productId: 'p', unitIdx: 0, price: 1 }] }, 0, true).price).toBe(false);
  });
  it('an approver approves up to their own cap', () => {
    expect(approverCovers(20, '20')).toBe(true);
    expect(approverCovers(20, '20.5')).toBe(false);
    expect(approverCovers(100, '60')).toBe(true);
  });
  it('reason text: chip label, extra text, "other" needs text', () => {
    expect(discReasonText({ code: 'bulk' })).toBe('ซื้อจำนวนมาก');
    expect(discReasonText({ code: 'defect', text: 'สีถลอก' })).toBe('สินค้ามีตำหนิ · สีถลอก');
    expect(discReasonText({ code: 'other' })).toBeNull();
    expect(discReasonText({ code: 'other', text: ' ญาติ ' })).toBe('อื่นๆ: ญาติ');
    expect(discReasonText(null)).toBeNull();
    expect(discReasonText({ code: 'bogus' as 'bulk' })).toBeNull();
  });
  it('margin amount and %', () => {
    expect(margin('100', '80')).toEqual({ amount: '20.00', pct: '20.00' });
    expect(margin('100', '120')).toEqual({ amount: '-20.00', pct: '-20.00' });
    expect(margin('0', '10')).toEqual({ amount: '-10.00', pct: null });
    expect(margin('300', '200')).toEqual({ amount: '100.00', pct: '33.33' });
  });
});
