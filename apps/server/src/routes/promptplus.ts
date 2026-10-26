/** Prompt Plus routes — CLOUD EDITION ONLY (registered inside `process.env.EDITION === 'cloud'`). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pageQuery } from '@erp/contracts';
import { PromptPlusClient } from '../adapters/promptplus';
import { requireAny } from '../lib/context';
import { AppError } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import type { Authed } from '../plugins/auth';

export function promptPlusRoutes(app: FastifyInstance, authed: Authed, client = new PromptPlusClient()): void {
  const tenantCode = async (tx: { query: (q: string) => Promise<{ rows: { code: string }[] }> }) => (await tx.query(`select code from tenants`)).rows[0]!.code;

  app.get('/api/promptplus/incoming', authed(async (tx, ctx, req) => {
    requireAny(ctx, ['inv.receive', 'inv.view']);
    pageQuery.parse(req.query);
    if (!client.configured) return { items: [], nextCursor: null };
    return { items: await client.incoming(await tenantCode(tx)), nextCursor: null };
  }));

  app.post('/api/promptplus/orders', authed(async (tx, ctx, req, reply) => {
    requireAny(ctx, ['inv.receive', 'sales.doc']);
    const body = z.object({ docNo: z.string(), lines: z.array(z.object({ sku: z.string(), qty: z.string() })).min(1) }).parse(req.body);
    if (!client.configured) throw new AppError(503, 'CONFLICT', 'Prompt Plus is not configured on this server');
    const r = await client.createOrder(await tenantCode(tx), body);
    await writeAudit(tx, ctx, [{ action: 'create', object: 'pp-order', ref: body.docNo, detail: r.orderId }]);
    reply.status(201);
    return r;
  }));
}
