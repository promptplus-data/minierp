/**
 * SCG Family (M13) coupon provider — CLOUD EDITION ONLY (OQ-A2). The on-prem bundle replaces this file with an empty
 * module (build.lib.mjs) and every call site sits inside `if (process.env.EDITION === 'cloud')`.
 *
 * The interface mirrors docs/integrations/openapi/scgfamily.yaml (member lookup, coupon evaluate, reservation,
 * redeem, release, reverse). The real API is not available yet, so there are two implementations:
 *   - stub (default): no member data, no coupons;
 *   - demo (env SCGF_DEMO=1): two sample members and a realistic coupon wallet evaluated against the cart.
 * SCG Family owns the coupon rules (spec §4): the ERP never computes a coupon value itself, it asks the provider.
 */
import { randomUUID } from 'node:crypto';
import { d, money } from '@erp/core';
import type { ScgfCoupon, ScgfMember } from '@erp/contracts/src/scgfamily';

export function scgFamilyCapabilities(): { scgFamily: boolean } {
  return { scgFamily: true };
}

export interface ScgfCartLine { lineNo: number; productId: string; sku: string; name: string; isScg: boolean; qty: string; unitPrice: string; lineNet: string }
/** Cart payload of evaluate / reserve / redeem (spec §4.1): line nets after line discounts, before bill discount and coupon. */
export interface ScgfProviderCart {
  vatMode: 'inc' | 'exc' | 'none';
  lines: ScgfCartLine[];
  totals: { gross: string; lineDiscount: string; sub: string; shopBillDiscount: string };
}
export interface ScgfEvaluation { memberId: string; maxCouponsPerBill: number; coupons: ScgfCoupon[] }
export interface ScgfReservationOut { reservationId: string; code: string; title: string; discountAmount: string; expiresAt: string }
export interface ScgfRedeemIn { memberId: string; code: string; billNo: string; expectedAmount: string; cart: ScgfProviderCart }

/** Provider error with the spec's error code (§3.2, §5.2, §6.3). */
export class ScgfError extends Error {
  constructor(readonly code: string, message: string, readonly status = 422, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface ScgfProvider {
  readonly name: 'stub' | 'demo';
  lookupMember(shopId: string, by: 'sf_id' | 'phone', value: string): Promise<ScgfMember | null>;
  evaluateCoupons(shopId: string, memberId: string, cart: ScgfProviderCart): Promise<ScgfEvaluation>;
  reserve(shopId: string, memberId: string, code: string, cart: ScgfProviderCart): Promise<ScgfReservationOut>;
  /** Bill close (BR-11): idempotent per bill no + coupon code on the real API. */
  redeem(shopId: string, reservationId: string, req: ScgfRedeemIn): Promise<{ redemptionId: string; discountAmount: string }>;
  release(shopId: string, reservationId: string, reason: string): Promise<void>;
  reverse(shopId: string, redemptionId: string, req: { billNo: string; reason: string }): Promise<void>;
}

const MEMBER_ID = /^SF\d{8}$/;

/** Default until the real API exists: knows no members' coupons. */
export const stubProvider: ScgfProvider = {
  name: 'stub',
  async lookupMember(_shop, by, value) {
    if (by !== 'sf_id' || !MEMBER_ID.test(value)) return null;
    return { memberId: value, displayName: 'สมาชิก SCG Family', memberTypeLabel: 'สมาชิก', tier: '-', phoneMasked: null, couponCount: 0 };
  },
  async evaluateCoupons(_shop, memberId) {
    return { memberId, maxCouponsPerBill: 1, coupons: [] };
  },
  async reserve() {
    throw new ScgfError('COUPON_NOT_ELIGIBLE', 'Coupon not available');
  },
  async redeem() {
    throw new ScgfError('COUPON_NOT_ELIGIBLE', 'Coupon not available');
  },
  async release() {},
  async reverse() {},
};

// ---------- demo ----------
interface DemoCoupon {
  code: string; kind: ScgfCoupon['kind']; title: string; description: string; usage: ScgfCoupon['usage'];
  minSpend: number; value: (sub: string) => string; conditions: string[]; shop?: string;
}
const fixed = (n: number) => (sub: string) => money(d(sub).lt(n) ? sub : n);
const thb = (n: number) => n.toLocaleString('en-US');
const minText = (n: number) => (n > 0 ? `ซื้อสินค้ายอดรวมร่วมรายการขั้นต่ำ ฿${thb(n)}` : 'ไม่มียอดขั้นต่ำ');
const DEMO_COUPONS: DemoCoupon[] = [
  { code: 'SFC-100-1K', kind: 'promotion', title: 'ส่วนลดท้ายบิล ฿100', description: 'ส่วนลดเงินสดท้ายบิลสำหรับสมาชิก SCG Family', usage: { used: 8, limit: 100 }, minSpend: 1000, value: fixed(100),
    conditions: ['ใช้ได้ 1 ใบต่อบิล', 'ใช้ร่วมกับส่วนลดของร้านได้', 'ไม่สามารถแลกเปลี่ยนเป็นเงินสด'] },
  { code: 'SFC-5PCT', kind: 'promotion', title: 'ส่วนลด 5% สูงสุด ฿200', description: 'ลด 5% จากยอดสินค้าหลังส่วนลดรายการ', usage: { used: 41, limit: 200 }, minSpend: 2000,
    value: (sub) => money(Math.min(200, d(sub).times(0.05).toDecimalPlaces(2).toNumber())), conditions: ['ลดสูงสุด ฿200 ต่อบิล', 'ใช้ได้ 1 ใบต่อบิล'] },
  { code: 'SFC-300-15K', kind: 'promotion', title: 'ส่วนลดท้ายบิล ฿300', description: 'สำหรับงานใหญ่ ซื้อครบรับส่วนลดทันที', usage: null, minSpend: 15000, value: fixed(300),
    conditions: ['ใช้ได้ 1 ใบต่อบิล', 'ไม่จำกัดจำนวนสิทธิ์ตลอดแคมเปญ'] },
  { code: 'SFC-200-5K', kind: 'promotion', title: 'ส่วนลดท้ายบิล ฿200', description: 'ช่างซื้อของเข้าหน้างาน ลดเพิ่ม', usage: { used: 12, limit: 50 }, minSpend: 5000, value: fixed(200),
    conditions: ['ใช้ได้ 1 ใบต่อบิล'] },
  { code: 'SCC-50', kind: 'cash_card', title: 'Cash Card ฿50', description: 'บัตรเงินสดจากการสะสมคะแนน ใช้แทนเงินสด', usage: { used: 99, limit: 100 }, minSpend: 0, value: fixed(50),
    conditions: ['ใช้ได้ทุกบิล ไม่มีขั้นต่ำ', 'มูลค่าไม่เกินยอดบิล'] },
  { code: 'SCC-500', kind: 'cash_card', title: 'Cash Card ฿500', description: 'บัตรเงินสดสำหรับช่าง Gold', usage: null, minSpend: 3000, value: fixed(500),
    conditions: ['ใช้ได้ 1 ใบต่อบิล', 'ไม่ทอนเงิน'] },
  // valid at another shop only: never offered here (spec: only coupons valid for this shop and member)
  { code: 'SFC-OTHER', kind: 'promotion', title: 'ส่วนลดท้ายบิล ฿150', description: 'เฉพาะสาขาอื่น', usage: null, minSpend: 0, value: fixed(150), conditions: [], shop: 'SFM-BKK-00001' },
];
const DEMO_MEMBERS: Record<string, ScgfMember & { phone: string; wallet: boolean }> = {
  SF22018834: { memberId: 'SF22018834', displayName: 'ช่างสมชาย ใ.', memberTypeLabel: 'ช่าง', tier: 'Gold', phoneMasked: '081-xxx-5678', couponCount: 6, phone: '0812345678', wallet: true },
  SF10000001: { memberId: 'SF10000001', displayName: 'คุณวิไล ส.', memberTypeLabel: 'เจ้าของบ้าน', tier: 'Silver', phoneMasked: '089-xxx-0001', couponCount: 0, phone: '0890000001', wallet: false },
};
const VALID_FROM = '2026-10-01';
const VALID_TO = '2026-12-31';

function demoEvaluate(memberId: string, cart: ScgfProviderCart): ScgfCoupon[] {
  const m = DEMO_MEMBERS[memberId];
  if (!m?.wallet) return [];
  const sub = cart.totals.sub;
  return DEMO_COUPONS.filter((c) => !c.shop).map((c) => {
    const short = d(sub).lt(c.minSpend);
    const amount = short || !d(sub).gt(0) ? '0.00' : c.value(sub);
    return {
      code: c.code, kind: c.kind, title: c.title, description: c.description, imageUrl: null, validFrom: VALID_FROM, validTo: VALID_TO, usage: c.usage,
      conditionText: minText(c.minSpend), conditions: c.conditions, eligible: !short && d(amount).gt(0), discountAmount: amount,
      ineligibleReason: short ? `ยอดสินค้า ฿${thb(d(sub).toNumber())} ยังไม่ถึงขั้นต่ำ ฿${thb(c.minSpend)}` : !d(sub).gt(0) ? 'ยังไม่มีสินค้าในบิล' : null,
    };
  });
}

function demoPick(memberId: string, code: string, cart: ScgfProviderCart): ScgfCoupon {
  const c = demoEvaluate(memberId, cart).find((x) => x.code === code);
  if (!c) throw new ScgfError('COUPON_NOT_FOUND', `Coupon ${code} is not in this member's wallet`, 404);
  if (!c.eligible) throw new ScgfError('COUPON_NOT_ELIGIBLE', c.ineligibleReason ?? 'Coupon not eligible', 422);
  return c;
}

/** Stateless demo: the reservation id carries member and code so redeem can check them. */
export const demoProvider: ScgfProvider = {
  name: 'demo',
  async lookupMember(_shop, by, value) {
    const v = value.replace(/\D/g, '');
    const m = by === 'sf_id' ? DEMO_MEMBERS[value.toUpperCase()] : Object.values(DEMO_MEMBERS).find((x) => x.phone === v);
    if (!m) return null;
    const { phone: _p, wallet: _w, ...out } = m;
    return out;
  },
  async evaluateCoupons(_shop, memberId, cart) {
    return { memberId, maxCouponsPerBill: 1, coupons: demoEvaluate(memberId, cart) };
  },
  async reserve(_shop, memberId, code, cart) {
    const c = demoPick(memberId, code, cart);
    return {
      reservationId: `rsv_demo.${memberId}.${c.code}.${randomUUID().slice(0, 8)}`, code: c.code, title: c.title, discountAmount: c.discountAmount,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
  },
  async redeem(_shop, reservationId, req) {
    const [, member, code] = reservationId.split('.');
    if (!reservationId.startsWith('rsv_demo.') || member !== req.memberId || code !== req.code) throw new ScgfError('RESERVATION_NOT_FOUND', 'Unknown reservation', 410);
    const c = demoPick(req.memberId, req.code, req.cart);
    if (!d(c.discountAmount).eq(d(req.expectedAmount))) throw new ScgfError('COUPON_AMOUNT_CHANGED', 'Coupon amount changed', 409, { discountAmount: c.discountAmount });
    return { redemptionId: `rdm_demo.${randomUUID().slice(0, 12)}`, discountAmount: c.discountAmount };
  },
  async release() {},
  async reverse() {},
};

/** Read per call so tests (and ops) can switch with the env var. */
export function scgfProvider(): ScgfProvider {
  return process.env.SCGF_DEMO === '1' ? demoProvider : stubProvider;
}
