/**
 * CLOUD ONLY. SCG Family member coupon calls (/api/scgf/*). Loaded only through ../cloud.ts behind the static
 * VITE_EDITION === 'cloud' test, so the on-prem build never emits this chunk (scripts/check-onprem.mjs).
 */
import {
  ScgfCustomerMember, ScgfEvaluateRes, ScgfMember, ScgfReservation, type ScgfCart,
} from '@erp/contracts/src/scgfamily';
import { ApiFail, api } from '../api';

export const memberOf = (customerId: string) =>
  api('GET', `/api/scgf/customers/${customerId}/member`, { schema: ScgfCustomerMember, silent: true });
export const setCustomerMember = (customerId: string, memberId: string | null) =>
  api('PATCH', `/api/scgf/customers/${customerId}/member`, { body: { memberId }, schema: ScgfCustomerMember, silent: true });
/** Phone when it looks like a Thai phone number, else a member id. */
export const lookupMember = (value: string) => {
  const digits = value.replace(/\D/g, '');
  const by = /^0\d{8,9}$/.test(digits) && !/^sf/i.test(value.trim()) ? 'phone' : 'sf_id';
  return api('POST', '/api/scgf/members/lookup', { body: { by, value: by === 'phone' ? digits : value.trim() }, schema: ScgfMember, silent: true });
};
export async function memberExists(memberId: string): Promise<boolean> {
  try {
    await lookupMember(memberId);
    return true;
  } catch (e) {
    if (e instanceof ApiFail && e.status === 404) return false;
    throw e;
  }
}
export const evaluate = (memberId: string, cart: ScgfCart) =>
  api('POST', '/api/scgf/coupons/evaluate', { body: { memberId, cart }, schema: ScgfEvaluateRes, silent: true });
export const reserve = (memberId: string, code: string, cart: ScgfCart) =>
  api('POST', '/api/scgf/coupons/reserve', { body: { memberId, code, cart }, schema: ScgfReservation, silent: true });
export const releaseCoupon = (reservationId: string, reason = 'removed') =>
  api('POST', '/api/scgf/coupons/release', { body: { reservationId, reason }, silent: true }).catch(() => undefined);
