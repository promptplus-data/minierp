/** Stock, shifts, POS sales, documents, returns. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AdjustListQuery, AdjustRequestReq, CashMoveReq, CloseShiftReq, EligibleQuery, IssueReq, ManualReceiptReq, OpenShiftReq, PosSaleReq, ReturnReq,
  TransferReq, VoidReq, pageQuery,
} from '@erp/contracts';
import { requireAny, type Deps } from '../lib/context';
import type { Authed } from '../plugins/auth';
import { approveAdjust, balances, issue, listAdjust, lots, receipt, rejectAdjust, requestAdjust, transfer } from '../services/inventory';
import { createReturn, eligible } from '../services/returns';
import { getDoc, listDocs, posSale, voidDoc } from '../services/sales';
import { cashMove, closeShift, currentShift, openShift } from '../services/shifts';
import { runBackupHook } from '../backup';

const idParam = (req: FastifyRequest) => (req.params as { id: string }).id;
const stockQuery = pageQuery.extend({ warehouseId: z.string().optional(), productId: z.string().optional() });

export function opsRoutes(app: FastifyInstance, deps: Deps, authed: Authed): void {
  // ---------- stock ----------
  app.get('/api/stock', authed(async (tx, ctx, req) => {
    requireAny(ctx, ['inv.view', 'pos.sell', 'sales.doc'], { readOnly: true });
    return balances(tx, stockQuery.parse(req.query));
  }));
  app.get('/api/stock/lots', authed(async (tx, ctx, req) => lots(tx, ctx, stockQuery.parse(req.query))));
  app.post('/api/stock/receipts', authed(async (tx, ctx, req, reply) => {
    reply.status(201);
    return receipt(tx, deps, ctx, ManualReceiptReq.parse(req.body));
  }));
  app.post('/api/stock/transfers', authed(async (tx, ctx, req, reply) => {
    reply.status(201);
    return transfer(tx, deps, ctx, TransferReq.parse(req.body));
  }));
  app.post('/api/stock/issues', authed(async (tx, ctx, req, reply) => {
    reply.status(201);
    return issue(tx, deps, ctx, IssueReq.parse(req.body));
  }));
  app.post('/api/stock/adjust-requests', authed(async (tx, ctx, req, reply) => {
    reply.status(201);
    return requestAdjust(tx, deps, ctx, AdjustRequestReq.parse(req.body));
  }));
  app.get('/api/stock/adjust-requests', authed(async (tx, ctx, req) => listAdjust(tx, ctx, AdjustListQuery.parse(req.query))));
  app.post('/api/stock/adjust-requests/:id/approve', authed(async (tx, ctx, req) => approveAdjust(tx, deps, ctx, idParam(req))));
  app.post('/api/stock/adjust-requests/:id/reject', authed(async (tx, ctx, req) =>
    rejectAdjust(tx, ctx, idParam(req), z.object({ note: z.string().optional() }).parse(req.body ?? {}).note)));

  // ---------- shifts ----------
  app.get('/api/shifts/current', authed(async (tx, ctx) => currentShift(tx, ctx)));
  app.post('/api/shifts/open', authed(async (tx, ctx, req, reply) => {
    reply.status(201);
    return openShift(tx, deps, ctx, OpenShiftReq.parse(req.body));
  }));
  app.post('/api/shifts/:id/cash-moves', authed(async (tx, ctx, req) => cashMove(tx, ctx, idParam(req), CashMoveReq.parse(req.body))));
  const close = authed(async (tx, ctx, req) => closeShift(tx, deps, ctx, idParam(req), CloseShiftReq.parse(req.body)));
  app.post('/api/shifts/:id/close', async (req, reply) => {
    const out = await close(req, reply);
    // On-prem: back up after the close has committed. Fire-and-forget; never blocks or fails the close.
    if (deps.edition === 'onprem' && deps.backupScript) runBackupHook(deps.backupScript, req.log);
    return out;
  });

  // ---------- POS + documents ----------
  const sale = authed(async (tx, ctx, req, reply) => {
    const r = await posSale(tx, deps, ctx, PosSaleReq.parse(req.body));
    reply.status(r.replay ? 200 : 201);
    return r.doc;
  });
  const replay = authed(async (tx, ctx, req) => {
    const key = (req.body as { idempotencyKey: string }).idempotencyKey;
    const r = await tx.query<{ no: string }>(`select no from docs where idempotency_key = $1`, [key]);
    return getDoc(tx, ctx, r.rows[0]!.no);
  });
  app.post('/api/sales/pos', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await sale(req, reply);
    } catch (err) {
      // Two concurrent requests with one idempotency key: the loser hits the unique index; answer with the winner's bill.
      if ((err as { code?: string; constraint?: string }).constraint === 'docs_tenant_idem') {
        reply.status(200);
        return replay(req, reply);
      }
      throw err;
    }
  });
  app.get('/api/sales/docs', authed(async (tx, ctx, req) => {
    requireAny(ctx, ['sales.doc', 'pos.sell', 'fin.ar'], { readOnly: true });
    return listDocs(tx, pageQuery.extend({ type: z.enum(['ABB', 'INV', 'RC', 'CN', 'QT', 'SO', 'DO']).optional() }).parse(req.query));
  }));
  app.get('/api/sales/docs/:no', authed(async (tx, ctx, req) => {
    requireAny(ctx, ['sales.doc', 'pos.sell', 'fin.ar'], { readOnly: true });
    return getDoc(tx, ctx, (req.params as { no: string }).no);
  }));
  app.post('/api/sales/docs/:no/void', authed(async (tx, ctx, req) => voidDoc(tx, deps, ctx, (req.params as { no: string }).no, VoidReq.parse(req.body))));

  // ---------- returns ----------
  app.get('/api/returns/eligible', authed(async (tx, ctx, req) => {
    requireAny(ctx, ['sales.return', 'pos.sell', 'sales.doc']);
    return eligible(tx, deps, EligibleQuery.parse(req.query));
  }));
  app.post('/api/returns', authed(async (tx, ctx, req, reply) => {
    reply.status(201);
    return createReturn(tx, deps, ctx, ReturnReq.parse(req.body));
  }));

}
