/**
 * SCG Family member coupons (M13, round 4 ข้อ 7) — CLOUD EDITION ONLY (OQ-A2).
 * Web ↔ server schemas for /api/scgf/*. Import it as '@erp/contracts/src/scgfamily', never via the package index
 * (a stubbed `export *` would defeat tree-shaking of the whole index in the on-prem bundle). The on-prem server
 * bundle stubs this file (build.lib.mjs); scripts/check-onprem.mjs fails either payload if any of it leaks.
 * Shapes follow docs/integrations/openapi/scgfamily.yaml (member lookup, coupon evaluate, reservation).
 */
import { z } from 'zod';
import { Dec, DecNN, Discount } from './core';

export const ScgfMember = z.object({
  memberId: z.string(), displayName: z.string(), memberTypeLabel: z.string(), tier: z.string(), phoneMasked: z.string().nullable(), couponCount: z.number().int(),
});
export type ScgfMember = z.infer<typeof ScgfMember>;
export const ScgfLookupReq = z.object({ by: z.enum(['sf_id', 'phone']), value: z.string().trim().min(1).max(40) });
/** Customer ↔ member link (customers.scgf_member_id). */
export const ScgfCustomerMember = z.object({ customerId: z.string(), memberId: z.string().nullable() });
export const ScgfCustomerMemberReq = z.object({ memberId: z.string().trim().max(40).nullable() });

/** promotion = ส่วนลดท้ายบิล, cash_card = Cash Card, points = แลกคะแนน (tabs of the picker). */
export const ScgfCouponKind = z.enum(['promotion', 'cash_card', 'points']);
export const ScgfCoupon = z.object({
  code: z.string(), kind: ScgfCouponKind, title: z.string(), description: z.string(), imageUrl: z.string().nullable(),
  validFrom: z.string(), validTo: z.string(),
  /** null = ไม่จำกัดสิทธิ */
  usage: z.object({ used: z.number().int(), limit: z.number().int() }).nullable(),
  conditionText: z.string(), conditions: z.array(z.string()),
  eligible: z.boolean(), discountAmount: Dec,
  /** Why it cannot be used with this cart (shown greyed out). */
  ineligibleReason: z.string().nullable(),
});
export type ScgfCoupon = z.infer<typeof ScgfCoupon>;

/** The cart as the web has it; the server prices it with calcDoc only to evaluate (the sale recomputes from its own bill). */
export const ScgfCart = z.object({
  vatMode: z.enum(['inc', 'exc', 'none']).default('inc'),
  lines: z.array(z.object({ productId: z.string(), qty: Dec, unitPrice: DecNN, discount: Discount.optional() })).max(300),
  billDiscount: DecNN.default('0'),
});
export type ScgfCart = z.infer<typeof ScgfCart>;
export const ScgfEvaluateReq = z.object({ memberId: z.string().trim().min(1).max(40), cart: ScgfCart });
export const ScgfEvaluateRes = z.object({ memberId: z.string(), maxCouponsPerBill: z.number().int(), coupons: z.array(ScgfCoupon) });
export type ScgfEvaluateRes = z.infer<typeof ScgfEvaluateRes>;
export const ScgfReserveReq = ScgfEvaluateReq.extend({ code: z.string().trim().min(1).max(60) });
export const ScgfReservation = z.object({ reservationId: z.string(), code: z.string(), title: z.string(), discountAmount: Dec, expiresAt: z.string() });
export type ScgfReservation = z.infer<typeof ScgfReservation>;
export const ScgfReleaseReq = z.object({ reservationId: z.string().min(1).max(120), reason: z.enum(['removed', 'member_changed', 'cart_cleared', 'held', 'redeem_aborted']).default('removed') });

/** Cloud-only routes; deliberately not in the shared route table so the on-prem payloads never carry the paths. */
export const scgfRoutes = {
  scgfCustomerMember: 'GET /api/scgf/customers/:id/member',
  scgfCustomerMemberSet: 'PATCH /api/scgf/customers/:id/member',
  scgfLookup: 'POST /api/scgf/members/lookup',
  scgfEvaluate: 'POST /api/scgf/coupons/evaluate',
  scgfReserve: 'POST /api/scgf/coupons/reserve',
  scgfRelease: 'POST /api/scgf/coupons/release',
} as const;
