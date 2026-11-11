/**
 * SCG Family member coupons on POS bills and sales orders — CLOUD EDITION ONLY (OQ-A2). Stubbed out of the on-prem
 * bundle; every caller sits inside `if (process.env.EDITION === 'cloud')`.
 *
 * Rules (round 4 ข้อ 7, spec docs/integrations/scgfamily.md §4–§8):
 * - one coupon per bill; its value always comes from the provider, recomputed on save (the client amount is only
 *   compared, never used);
 * - it is not a shop discount: no manager approval, no discount reason, kept apart in the totals (DocTotals.coupon);
 * - redeemed at bill close inside the sale transaction (failure rolls the whole bill back, BR-04 keeps the number);
 * - void reverses a redeemed coupon / releases a reserved one through the provider.
 */
import { calcDoc, d, money, type DocTotals, type VatMode } from '@erp/core';
import type { DocCoupon, DocCouponIn } from '@erp/contracts';
import type { ScgfCart } from '@erp/contracts/src/scgfamily';
import { ScgfError, scgfProvider, type ScgfProviderCart } from '../adapters/scgfamily';
import { E, isUuid } from '../lib/errors';
import type { Tx } from '@erp/db';

export interface CartItem { productId: string; sku: string; name: string; isScg: boolean; qty: string; unitPrice: string }

export async function scgfShopId(tx: Tx): Promise<string> {
  return (await tx.query<{ code: string }>(`select code from tenants`)).rows[0]!.code;
}

/** Spec §4.1 cart: line nets after line discounts (calcDoc lines), sub before bill discount and coupon. */
export function scgfCartOf(items: CartItem[], totals: DocTotals, vatMode: VatMode): ScgfProviderCart {
  return {
    vatMode,
    lines: items.map((x, i) => ({ lineNo: i + 1, productId: x.productId, sku: x.sku, name: x.name, isScg: x.isScg, qty: x.qty, unitPrice: x.unitPrice, lineNet: totals.lines[i]?.net ?? '0.00' })),
    totals: { gross: totals.gross, lineDiscount: totals.lineDisc, sub: totals.sub, shopBillDiscount: totals.billDisc },
  };
}

/** The cart the picker sends (evaluate / reserve): priced with calcDoc from the master's products. */
export async function scgfCartFromWeb(tx: Tx, cart: ScgfCart): Promise<ScgfProviderCart> {
  const ids = [...new Set(cart.lines.map((l) => l.productId))];
  if (ids.some((x) => !isUuid(x))) throw E.validation('Unknown product');
  const r = await tx.query<{ id: string; sku: string; name: string; is_scg: boolean; vat: 'v7' | 'exempt' }>(`select id, sku, name, is_scg, vat from products where id = any($1::uuid[])`, [ids]);
  const byId = new Map(r.rows.map((x) => [x.id, x]));
  if (byId.size !== ids.length) throw E.validation('Unknown product');
  const lines = cart.lines.map((l) => ({ l, p: byId.get(l.productId)! }));
  const totals = calcDoc(lines.map(({ l, p }) => ({ qty: l.qty, unitPrice: l.unitPrice, discount: l.discount ?? null, vat: p.vat })), cart.vatMode, cart.billDiscount);
  return scgfCartOf(lines.map(({ l, p }) => ({ productId: p.id, sku: p.sku, name: p.name, isScg: p.is_scg, qty: l.qty, unitPrice: l.unitPrice })), totals, cart.vatMode);
}

/** Provider errors → API errors (409 CONFLICT with details.reason the picker understands). */
export function scgfFail(e: unknown, reason = 'COUPON_NOT_ELIGIBLE'): never {
  if (e instanceof ScgfError) {
    if (e.code === 'MEMBER_NOT_FOUND') throw E.notFound(e.message, { reason: e.code });
    throw E.conflict(e.message, { reason: e.code === 'COUPON_AMOUNT_CHANGED' ? e.code : reason, providerCode: e.code, ...e.details });
  }
  throw e;
}

/**
 * Save-time check of the bill's coupon: re-evaluates the final cart with the provider and returns the value to put
 * into calcDoc. A coupon no longer offered / not eligible, or a value different from what the cashier saw, is a 409.
 */
export async function scgfCouponValue(tx: Tx, coupon: DocCouponIn, cart: ScgfProviderCart): Promise<{ amount: string; title: string }> {
  let ev;
  try {
    ev = await scgfProvider().evaluateCoupons(await scgfShopId(tx), coupon.memberId, cart);
  } catch (e) {
    scgfFail(e);
  }
  const c = ev.coupons.find((x) => x.code === coupon.code);
  if (!c || !c.eligible) {
    throw E.conflict(`Coupon ${coupon.code} cannot be used with this bill`, { reason: 'COUPON_NOT_ELIGIBLE', why: c?.ineligibleReason ?? null });
  }
  if (!d(c.discountAmount).eq(d(coupon.amount))) {
    throw E.conflict(`Coupon ${coupon.code} is now ${c.discountAmount}`, { reason: 'COUPON_AMOUNT_CHANGED', newAmount: c.discountAmount });
  }
  return { amount: money(c.discountAmount), title: c.title };
}

/**
 * Bill close: redeem with the provider (spec §6), then store code / reservation / redemption and the applied value on
 * the doc. Called inside the save transaction after the number is issued; a provider failure aborts the save.
 */
export async function scgfRedeemOnDoc(
  tx: Tx, table: 'docs' | 'sales_orders', id: string, no: string, coupon: DocCouponIn, value: { amount: string; title: string }, cart: ScgfProviderCart,
): Promise<DocCoupon> {
  let r;
  try {
    r = await scgfProvider().redeem(await scgfShopId(tx), coupon.reservationId, { memberId: coupon.memberId, code: coupon.code, billNo: no, expectedAmount: value.amount, cart });
  } catch (e) {
    scgfFail(e, 'COUPON_REDEEM_FAILED');
  }
  const stored: DocCoupon = {
    code: coupon.code, title: value.title, amount: value.amount, memberId: coupon.memberId, reservationId: coupon.reservationId, redemptionId: r.redemptionId, status: 'redeemed',
  };
  if (table === 'docs') await tx.query(`update docs set coupon = $2, coupon_amount = $3, member_id = $4 where id = $1`, [id, JSON.stringify(stored), value.amount, coupon.memberId]);
  else await tx.query(`update sales_orders set coupon = $2, coupon_amount = $3 where id = $1`, [id, JSON.stringify(stored), value.amount]);
  return stored;
}

/** Void: give the coupon back (reverse a redemption, release a reservation). The void itself never fails on this. */
export async function scgfReturnOnVoid(tx: Tx, table: 'docs' | 'sales_orders', id: string, no: string): Promise<void> {
  const row = (await tx.query<{ coupon: DocCoupon | null }>(`select coupon from ${table} where id = $1`, [id])).rows[0];
  const c = row?.coupon;
  if (!c || c.status === 'released' || c.status === 'reversed') return;
  const shop = await scgfShopId(tx);
  try {
    if (c.status === 'redeemed' && c.redemptionId) await scgfProvider().reverse(shop, c.redemptionId, { billNo: no, reason: 'bill_void' });
    else await scgfProvider().release(shop, c.reservationId, 'bill_void');
  } catch {
    return; // stays redeemed; the daily reconciliation (spec §10) picks it up
  }
  await tx.query(`update ${table} set coupon = coupon || $2::jsonb where id = $1`, [id, JSON.stringify({ status: c.status === 'redeemed' ? 'reversed' : 'released' })]);
}

export async function scgfDocCoupon(tx: Tx, table: 'docs' | 'sales_orders', id: string): Promise<DocCoupon | null> {
  return (await tx.query<{ coupon: DocCoupon | null }>(`select coupon from ${table} where id = $1`, [id])).rows[0]?.coupon ?? null;
}
