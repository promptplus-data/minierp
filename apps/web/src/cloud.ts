/**
 * Cloud-only UI, loaded lazily. Every reference sits behind the static `import.meta.env.VITE_EDITION === 'cloud'`
 * test, which Vite replaces with a literal, so the on-prem build drops these branches and never emits the chunks
 * under ./promptplus/ and ./scgfamily/ (scripts/check-onprem.mjs fails the build otherwise). Do not import those
 * folders anywhere else.
 */
import { lazy } from 'react';
import type { DocCouponIn } from '@erp/contracts';

export const IS_CLOUD = import.meta.env.VITE_EDITION === 'cloud';

export const CloudSsoButton = import.meta.env.VITE_EDITION === 'cloud' ? lazy(() => import('./promptplus/SsoButton')) : null;
export const CloudIncomingCard = import.meta.env.VITE_EDITION === 'cloud' ? lazy(() => import('./promptplus/IncomingCard')) : null;
export const CloudReorderButton = import.meta.env.VITE_EDITION === 'cloud' ? lazy(() => import('./promptplus/ReorderButton')) : null;

/** Member coupon on a POS bill / sales order being built (cloud only; always null on-prem). */
export type AppliedCoupon = DocCouponIn & { title: string; customerId: string | null };
/** Coupon slot (button + picker modal) and its totals row. */
export const CloudCouponSlot = import.meta.env.VITE_EDITION === 'cloud' ? lazy(() => import('./scgfamily/CouponSlot')) : null;
export const CloudCouponTotal = import.meta.env.VITE_EDITION === 'cloud' ? lazy(() => import('./scgfamily/CouponTotal')) : null;
/** Gives a reserved coupon back (bill cleared / held). */
export const cloudReleaseCoupon = import.meta.env.VITE_EDITION === 'cloud'
  ? (c: AppliedCoupon | null, reason: string) => { if (c) void import('./scgfamily/api').then((m) => m.releaseCoupon(c.reservationId, reason)); }
  : () => {};
/** Customer form: check / link the member id. */
export const cloudMemberExists = import.meta.env.VITE_EDITION === 'cloud' ? (id: string) => import('./scgfamily/api').then((m) => m.memberExists(id)) : null;
export const cloudLinkMember = import.meta.env.VITE_EDITION === 'cloud' ? (customerId: string, id: string) => import('./scgfamily/api').then((m) => m.setCustomerMember(customerId, id)) : null;
