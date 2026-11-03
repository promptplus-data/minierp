/**
 * Retail rules (module group C): shop promotions (M15), price resolution (BR-05) and production costing (M16).
 * Pure functions shared by the server and the POS screen so both compute the same prices.
 */
import { d, money, qty4, round2, round4, Decimal, type Money, type Num } from './money';
import type { LineVat, VatMode } from './vat';

// ---------- M15 promotions ----------

/** Stored status: a draft is never applied; closed is final (REQ-M15-04). */
export type PromoStatus = 'draft' | 'active' | 'closed';
/** Status the user sees: active promos are scheduled / live / expired by date. */
export type PromoState = 'draft' | 'scheduled' | 'live' | 'expired' | 'closed';
export type PromoMode = 'pct' | 'amt' | 'fixed';

/** Mockup `promoState`: dates are inclusive 'YYYY-MM-DD' in the shop's time zone. */
export function promoState(p: { status: PromoStatus; start: string; end: string }, today: string): PromoState {
  if (p.status === 'draft') return 'draft';
  if (p.status === 'closed') return 'closed';
  if (today < p.start) return 'scheduled';
  if (today > p.end) return 'expired';
  return 'live';
}

export const PROMO_STATE_TH: Record<PromoState, string> = {
  draft: 'ร่าง', scheduled: 'ยังไม่เริ่ม', live: 'กำลังใช้', expired: 'หมดอายุ', closed: 'ปิดแล้ว',
};

/**
 * Promo price of one unit (mockup `applyPromo`).
 * - pct: list × (1 − value/100)
 * - amt: list − value × factor (value is baht off per BASE unit, so a pack of 40 gets 40 × value off)
 * - fixed: value × factor (value is the promo price per base unit)
 * Rounded to the satang and clamped to [0, list]: a promo never raises a price.
 */
export function promoUnitPrice(mode: PromoMode, value: Num, list: Num, factor: Num = 1): Money {
  const l = d(list);
  const v = d(value);
  const f = d(factor);
  const raw = mode === 'pct' ? l.times(new Decimal(1).minus(v.div(100))) : mode === 'amt' ? l.minus(v.times(f)) : v.times(f);
  return money(Decimal.max(0, Decimal.min(l, round2(raw))));
}

/** Normal (non-promo) value of one set: Σ normal price × qty per set. */
export function bundleNormalPrice(comps: readonly { qtyPerSet: Num; normalPrice: Num }[]): Money {
  return money(comps.reduce((a, c) => a.plus(d(c.normalPrice).times(d(c.qtyPerSet))), new Decimal(0)));
}

/** Whole sets the stock can make (REQ-M07-11 "จัดได้ N ชุด"); a set is unavailable when any component is short. */
export function bundleSetsAvailable(comps: readonly { qtyPerSet: Num; have: Num }[]): number {
  if (!comps.length) return 0;
  let min: Decimal | null = null;
  for (const c of comps) {
    const q = d(c.qtyPerSet);
    if (!q.gt(0)) continue;
    const n = Decimal.max(0, d(c.have)).div(q).floor();
    if (min === null || n.lt(min)) min = n;
  }
  return min === null ? 0 : min.toNumber();
}

/** Price before VAT as BR-16 compares it: VAT-inclusive documents divide 7% lines by 1.07. 4 dp. */
export function priceExVat(price: Num, vatMode: VatMode, lineVat: LineVat): string {
  return qty4(vatMode === 'inc' && lineVat === 'v7' ? d(price).div('1.07') : d(price));
}

/**
 * REQ-M15-03 below-cost check at promo creation: promo price per base unit before VAT vs the FIFO cost the
 * next sale would take. Same half-satang tolerance as BR-16. Products without a cost are not checked.
 */
export function promoBelowCost(promoPriceExVatPerBase: Num, unitCost: Num | null | undefined): boolean {
  if (unitCost == null || !d(unitCost).gt(0)) return false;
  return d(promoPriceExVatPerBase).lt(d(unitCost).minus('0.005'));
}

// ---------- BR-05 price resolution ----------

export type PriceSource = 'quotation' | 'customer' | 'group' | 'retail' | 'promo';
export interface PriceListEntry { source: 'customer' | 'group'; unitIdx: number; minQty: Num; price: Num }

/**
 * Price list step of BR-05: the customer's own list beats the customer-group list; inside one list the entry
 * with the largest qty break not above `qty` wins. Entries must already be filtered to valid dates.
 */
export function pickRetailListPrice(entries: readonly PriceListEntry[], unitIdx: number, qty: Num): { price: Money; source: 'customer' | 'group' } | null {
  const q = d(qty);
  for (const source of ['customer', 'group'] as const) {
    let best: PriceListEntry | null = null;
    for (const e of entries) {
      if (e.source !== source || e.unitIdx !== unitIdx || d(e.minQty).gt(q)) continue;
      if (!best || d(e.minQty).gt(d(best.minQty))) best = e;
    }
    if (best) return { price: money(best.price), source };
  }
  return null;
}

/** A price list stored with or without VAT, converted to the document's price basis (REQ-M03-07). */
export function listPriceForDoc(price: Num, listVatIncluded: boolean, docMode: VatMode, lineVat: LineVat): Money {
  if (lineVat !== 'v7' || docMode === 'none') return money(price);
  if (docMode === 'inc' && !listVatIncluded) return money(d(price).times('1.07'));
  if (docMode === 'exc' && listVatIncluded) return money(d(price).div('1.07'));
  return money(price);
}

export interface PriceResolution { unitPrice: Money; source: PriceSource; promoId: string | null; listPrice: Money }

/**
 * BR-05: valid quotation price → customer price list → customer-group price list (qty breaks) → retail.
 * A live POS / B2B promo applies to the retail price; the customer gets the promo only when it is lower than
 * their list price (a contract price is never made worse by a promo).
 */
export function resolvePrice(a: { retail: Num; quotation?: Num | null; list?: { price: Num; source: 'customer' | 'group' } | null; promo?: { id: string; price: Num } | null }): PriceResolution {
  const retail = money(a.retail);
  if (a.quotation != null) return { unitPrice: money(a.quotation), source: 'quotation', promoId: null, listPrice: retail };
  const base = a.list ? { price: money(a.list.price), source: a.list.source as PriceSource } : { price: retail, source: 'retail' as PriceSource };
  if (a.promo && d(a.promo.price).lt(d(base.price))) return { unitPrice: money(a.promo.price), source: 'promo', promoId: a.promo.id, listPrice: retail };
  return { unitPrice: base.price, source: base.source, promoId: null, listPrice: retail };
}

// ---------- M16 production ----------

/** Suggested material issue for a manufacturing order: qty per unit × planned qty (4 dp). */
export const bomSuggest = (perUnit: Num, planQty: Num): string => qty4(d(perUnit).times(d(planQty)));

/**
 * REQ-M16-03 unit cost of the finished good: (materials issued − materials returned + labour + overhead) ÷ good qty.
 * Rejects carry no stock, so their share of the cost lands on the good units. 4 dp (lot unit cost precision).
 */
export function moUnitCost(a: { materials: Num; labour?: Num; overhead?: Num; good: Num }): string {
  const good = d(a.good);
  if (!good.gt(0)) throw new RangeError('good qty must be > 0');
  return round4(d(a.materials).plus(d(a.labour ?? 0)).plus(d(a.overhead ?? 0)).div(good)).toFixed(4);
}

/** Yield % of good output vs plan, 2 dp ("93.33"). Plan 0 → "0.00". */
export function yieldPct(good: Num, plan: Num): string {
  const p = d(plan);
  return p.gt(0) ? round2(d(good).div(p).times(100)).toFixed(2) : '0.00';
}
