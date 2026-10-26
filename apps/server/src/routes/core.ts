/** Auth, master data, audit log, users. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CustomerCreate, LoginReq, ProductUpsert, pageQuery } from '@erp/contracts';
import type { Tx } from '@erp/db';
import { writeAudit } from '../lib/audit';
import { requireAny, requirePerm, type Ctx, type Deps } from '../lib/context';
import { signToken, type Authed } from '../plugins/auth';
import { auditLog, verifyAudit } from '../services/admin';
import { login, sessionUser, unlockUser } from '../services/auth';
import { createCustomer, createProduct, listCustomers, listProducts, listVendors, listWarehouses, updateProduct } from '../services/master';

export function coreRoutes(app: FastifyInstance, deps: Deps, authed: Authed): void {
  app.post('/api/auth/login', async (req) => {
    const ctx = await login(deps.pool, LoginReq.parse(req.body));
    return { token: signToken(app, ctx), user: sessionUser({ id: ctx.userId, name: ctx.name, role: ctx.role }) };
  });
  app.get('/api/auth/me', authed(async (_tx, ctx) => sessionUser({ id: ctx.userId, name: ctx.name, role: ctx.role })));
  // Who can approve with a PIN (owner, manager): the UI needs their ids for discount / below-cost / void / return approvals.
  app.get('/api/users/approvers', authed(async (tx) => {
    const r = await tx.query<{ id: string; name: string; role: 'owner' | 'manager' }>(
      `select id, name, role from users where status = 'active' and role in ('owner','manager') order by case role when 'owner' then 0 else 1 end, name`,
    );
    return { items: r.rows };
  }));
  app.post('/api/users/:id/unlock', authed(async (tx, ctx, req) => unlockUser(tx, ctx, (req.params as { id: string }).id)));

  app.get('/api/products', authed(async (tx, ctx, req) => {
    const q = pageQuery.extend({ all: z.coerce.boolean().optional() }).parse(req.query);
    return listProducts(tx, ctx, q);
  }));
  app.post('/api/products', authed(async (tx, ctx, req, reply) => {
    requirePerm(ctx, 'data.master');
    const p = await createProduct(tx, ctx, ProductUpsert.parse(req.body));
    await writeAuditFor(tx, ctx, 'create', 'product', p.sku);
    reply.status(201);
    return p;
  }));
  app.patch('/api/products/:id', authed(async (tx, ctx, req) => {
    requirePerm(ctx, 'data.master');
    const p = await updateProduct(tx, ctx, (req.params as { id: string }).id, ProductUpsert.partial().parse(req.body));
    await writeAuditFor(tx, ctx, 'update', 'product', p.sku, Object.keys(req.body as object).join(', '));
    return p;
  }));

  app.get('/api/customers', authed(async (tx, _ctx, req) => listCustomers(tx, pageQuery.parse(req.query))));
  app.post('/api/customers', authed(async (tx, ctx, req, reply) => {
    requireAny(ctx, ['data.master', 'sales.doc', 'pos.sell']);
    const c = await createCustomer(tx, ctx, CustomerCreate.parse(req.body));
    await writeAuditFor(tx, ctx, 'create', 'customer', c.code, c.name);
    reply.status(201);
    return c;
  }));
  app.get('/api/vendors', authed(async (tx, _ctx, req) => listVendors(tx, pageQuery.parse(req.query))));
  app.get('/api/warehouses', authed(async (tx, _ctx, req) => listWarehouses(tx, pageQuery.parse(req.query))));

  app.get('/api/audit-log', authed(async (tx, ctx, req) => auditLog(tx, ctx, pageQuery.parse(req.query))));
  app.get('/api/audit-log/verify', authed(async (tx, ctx) => verifyAudit(tx, ctx)));
}

const writeAuditFor = (tx: Tx, ctx: Ctx, action: string, object: string, ref: string, detail = '') => writeAudit(tx, ctx, [{ action, object, ref, detail }]);
