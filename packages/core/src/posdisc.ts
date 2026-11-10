/**
 * POS manager override (M07): what a discount / price-change approval covers, required discount reasons, and the
 * margin numbers shown to data.cost users while selling. Pure rules shared by apps/server and apps/web.
 */
import { d, money, round4, type Num } from './money';
import { discountPct, exceedsCap } from './discount';

/** Reason chips required whenever a bill has a manual discount or a changed price (stored on the doc + audit). */
export const DISC_REASONS = {
  regular: 'ลูกค้าประจำ',
  defect: 'สินค้ามีตำหนิ',
  bulk: 'ซื้อจำนวนมาก',
  competitor: 'สู้ราคาคู่แข่ง',
  other: 'อื่นๆ',
} as const;
export type DiscReasonCode = keyof typeof DISC_REASONS;
export interface DiscReason { code: DiscReasonCode; text?: string }

/** Text stored on the document: the chip label, plus the typed text ("อื่นๆ" needs it). Null when invalid. */
export function discReasonText(r: DiscReason | null | undefined): string | null {
  if (!r || !(r.code in DISC_REASONS)) return null;
  const t = (r.text ?? '').trim();
  if (r.code === 'other') return t ? `${DISC_REASONS.other}: ${t}` : null;
  return t ? `${DISC_REASONS[r.code]} · ${t}` : DISC_REASONS[r.code];
}

/** A changed unit price: the line sells at `price` per unit of `unitIdx` instead of the expected price. */
export interface PriceChange { productId: string; unitIdx: number; price: Num }

/** What a manager approved for one bill: the discount ceiling (amount and % of gross) and the lowest prices. */
export interface DiscScope { maxAmount: Num; maxPct: Num; prices: readonly PriceChange[] }

/** The discount and price changes a bill actually carries. */
export interface BillDisc { gross: Num; discount: Num; prices: readonly PriceChange[] }

export type CoverResult = { ok: true } | { ok: false; why: 'DISCOUNT' | 'PRICE'; productId?: string };

/**
 * Whether an approval scope covers a bill. The discount must not exceed the approved amount nor the approved %;
 * every changed price must be at or above the approved price for that product and unit. Lowering the discount or
 * raising a price stays covered; anything beyond the approval must be approved again.
 */
export function scopeCovers(scope: DiscScope, bill: BillDisc, opts: { checkDiscount: boolean; checkPrices: boolean }): CoverResult {
  if (opts.checkDiscount) {
    const pct = discountPct(bill.gross, bill.discount);
    if (d(bill.discount).gt(d(scope.maxAmount)) || d(pct).gt(d(scope.maxPct))) return { ok: false, why: 'DISCOUNT' };
  }
  if (opts.checkPrices) {
    for (const p of bill.prices) {
      const a = scope.prices.find((x) => x.productId === p.productId && x.unitIdx === p.unitIdx);
      if (!a || d(p.price).lt(d(a.price))) return { ok: false, why: 'PRICE', productId: p.productId };
    }
  }
  return { ok: true };
}

/** What a bill needs from a manager: discount over the role cap, and / or a changed price without pos.price. */
export function needsOverride(bill: BillDisc, capPct: Num, canChangePrice: boolean): { discount: boolean; price: boolean; pct: string } {
  const pct = discountPct(bill.gross, bill.discount);
  return { discount: exceedsCap(pct, capPct), price: !canChangePrice && bill.prices.length > 0, pct };
}

/** An approver may approve a discount only up to their own role cap. */
export const approverCovers = (approverCapPct: Num, pct: Num): boolean => !exceedsCap(pct, approverCapPct);

/** Line margin from net revenue ex VAT and FIFO cost: amount (2 dp) and % of revenue (2 dp, null when revenue is 0). */
export function margin(revenueExVat: Num, cost: Num): { amount: string; pct: string | null } {
  const rev = d(revenueExVat);
  const amt = rev.minus(d(cost));
  return { amount: money(amt), pct: rev.isZero() ? null : round4(amt.div(rev).times(100)).toDecimalPlaces(2).toFixed(2) };
}
