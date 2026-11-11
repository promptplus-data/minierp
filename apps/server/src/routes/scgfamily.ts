/**
 * SCG Family member coupon routes — CLOUD EDITION ONLY (registered inside `process.env.EDITION === 'cloud'`).
 * Paths: packages/contracts/src/scgfamily.ts (scgfRoutes). Provider: adapters/scgfamily.ts (stub, or demo with SCGF_DEMO=1).
 */
import type { FastifyInstance } from 'fastify';
import {
  ScgfCustomerMemberReq, ScgfEvaluateReq, ScgfLookupReq, ScgfReleaseReq, ScgfReserveReq, type ScgfEvaluateRes, type ScgfReservation,
} from '@erp/contracts/src/scgfamily';
import { scgfProvider } from '../adapters/scgfamily';
import { writeAudit } from '../lib/audit';
import { requireAny } from '../lib/context';
import { E, isUuid } from '../lib/errors';
import type { Authed } from '../plugins/auth';
import { scgfCartFromWeb, scgfFail, scgfShopId } from '../services/scgfamily';

const SELLERS = ['pos.sell', 'sales.doc'] as const;

export function scgFamilyRoutes(app: FastifyInstance, authed: Authed): void {
  app.get('/api/scgf/customers/:id/member', authed(async (tx, ctx, req) => {
    requireAny(ctx, [...SELLERS], { readOnly: true });
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw E.notFound('Unknown customer');
    const r = await tx.query<{ scgf_member_id: string | null }>(`select scgf_member_id from customers where id = $1`, [id]);
    if (!r.rows[0]) throw E.notFound('Unknown customer');
    return { customerId: id, memberId: r.rows[0].scgf_member_id };
  }));

  /** Link (or unlink with null) a member id to the customer; the id must be known to SCG Family. */
  app.patch('/api/scgf/customers/:id/member', authed(async (tx, ctx, req) => {
    requireAny(ctx, [...SELLERS, 'data.master']);
    const { id } = req.params as { id: string };
    const body = ScgfCustomerMemberReq.parse(req.body);
    if (!isUuid(id)) throw E.notFound('Unknown customer');
    const memberId = body.memberId ? body.memberId.toUpperCase() : null;
    if (memberId && !(await scgfProvider().lookupMember(await scgfShopId(tx), 'sf_id', memberId))) {
      throw E.notFound(`Member ${memberId} not found`, { reason: 'MEMBER_NOT_FOUND' });
    }
    const r = await tx.query<{ name: string }>(`update customers set scgf_member_id = $2 where id = $1 returning name`, [id, memberId]);
    if (!r.rows[0]) throw E.notFound('Unknown customer');
    await writeAudit(tx, ctx, [{ action: 'update', object: 'customer', ref: r.rows[0].name, detail: memberId ? `ผูกรหัสสมาชิก SCG Family ${memberId}` : 'ยกเลิกการผูกรหัสสมาชิก SCG Family' }]);
    return { customerId: id, memberId };
  }));

  /** Spec §3: by member id or phone. Only the member id is ever stored (PDPA). */
  app.post('/api/scgf/members/lookup', authed(async (tx, ctx, req) => {
    requireAny(ctx, [...SELLERS], { readOnly: true });
    const body = ScgfLookupReq.parse(req.body);
    const m = await scgfProvider().lookupMember(await scgfShopId(tx), body.by, body.by === 'sf_id' ? body.value.toUpperCase() : body.value);
    if (!m) throw E.notFound('Member not found', { reason: 'MEMBER_NOT_FOUND' });
    return m;
  }));

  /** Spec §4: the member's coupons valid at this shop, each eligible or with the reason it is not. */
  app.post('/api/scgf/coupons/evaluate', authed(async (tx, ctx, req): Promise<ScgfEvaluateRes> => {
    requireAny(ctx, [...SELLERS], { readOnly: true });
    const body = ScgfEvaluateReq.parse(req.body);
    const cart = await scgfCartFromWeb(tx, body.cart);
    try {
      const ev = await scgfProvider().evaluateCoupons(await scgfShopId(tx), body.memberId.toUpperCase(), cart);
      return { memberId: ev.memberId, maxCouponsPerBill: ev.maxCouponsPerBill, coupons: ev.coupons };
    } catch (e) {
      scgfFail(e);
    }
  }));

  /** Spec §5: reserve the chosen coupon; the bill carries the reservation id until it is closed or the coupon removed. */
  app.post('/api/scgf/coupons/reserve', authed(async (tx, ctx, req, reply): Promise<ScgfReservation> => {
    requireAny(ctx, [...SELLERS]);
    const body = ScgfReserveReq.parse(req.body);
    const cart = await scgfCartFromWeb(tx, body.cart);
    try {
      const r = await scgfProvider().reserve(await scgfShopId(tx), body.memberId.toUpperCase(), body.code, cart);
      reply.status(201);
      return r;
    } catch (e) {
      scgfFail(e);
    }
  }));

  /** Spec §8.1: idempotent; called when the coupon is removed, the member changes or the bill is cleared / held. */
  app.post('/api/scgf/coupons/release', authed(async (tx, ctx, req) => {
    requireAny(ctx, [...SELLERS]);
    const body = ScgfReleaseReq.parse(req.body);
    await scgfProvider().release(await scgfShopId(tx), body.reservationId, body.reason);
    return { reservationId: body.reservationId, status: 'released' };
  }));
}
