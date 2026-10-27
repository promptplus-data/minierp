/**
 * SCG Family (M13) adapter — interface only in this phase (member lookup / coupons are out of scope).
 * Cloud: required (OQ-A2). On-prem: never offered — SCG Family confirmed on-prem shops do not need coupons (OQ-A2).
 */
import type { Edition } from '../lib/context';

export interface ScgFamilyMember { id: string; name: string; tier: string }
export interface ScgFamilyCoupon { code: string; title: string; expiresAt: string }

export interface ScgFamilyAdapter {
  available(edition: Edition): boolean;
  /** TODO(M13): look up a member by id; null when not found. Must answer within 3 s or the POS continues without it. */
  lookupMember(memberId: string): Promise<ScgFamilyMember | null>;
  /** TODO(M13): coupons bound to a member. */
  coupons(memberId: string): Promise<ScgFamilyCoupon[]>;
}

export const scgFamily: ScgFamilyAdapter = {
  available: (edition) => edition === 'cloud',
  lookupMember: async () => null,
  coupons: async () => [],
};
