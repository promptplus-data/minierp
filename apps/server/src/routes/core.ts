/** Auth, master data, audit log, users. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CustomerCreate, CustomerMasterQuery, CustomerUpdate, ShopRoleCreate, ShopRoleUpdate, LoginReq, ProductUpsert, VendorCreate, WarehouseUpsert, pageQuery } from '@erp/contracts';
import type { Tx } from '@erp/db';
import { writeAudit } from '../lib/audit';
import { d } from '@erp/core';
import { can, requireAny, requirePerm, type Ctx, type Deps } from '../lib/context';
import { E } from '../lib/errors';
import { createRole, deleteRole, listRoles, updateRole } from '../services/roles';
import { signToken, type Authed } from '../plugins/auth';
import { auditLog, verifyAudit } from '../services/admin';
import { login, sessionUser, unlockUser } from '../services/auth';
import { customerMaster, updateCustomer, createCustomer, createProduct, createVendor, listCustomers, getCustomer, listProducts, listVendors, listWarehouses, updateProduct, createWarehouse, updateWarehouse } from '../services/master';

export function coreRoutes(app: FastifyInstance, deps: Deps, authed: Authed): void {
  app.post('/api/auth/login', async (req) => {
    const ctx = await login(deps.pool, LoginReq.parse(req.body), deps.tenantGuards);
    return { token: signToken(app, ctx), user: sessionUser(ctx) };
  });
  app.get('/api/auth/me', authed(async (_tx, ctx) => sessionUser(ctx)));
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
  app.get('/api/customers/master', authed(async (tx, ctx, req) => {
    requireAny(ctx, ['data.master', 'sales.doc', 'fin.ar'], { readOnly: true });
    return customerMaster(tx, CustomerMasterQuery.parse(req.query), deps.today());
  }));
  app.patch('/api/customers/:id', authed(async (tx, ctx, req) => {
    requirePerm(ctx, 'data.master');
    const body = CustomerUpdate.parse(req.body);
    const { before, after } = await updateCustomer(tx, (req.params as { id: string }).id, body);
    // Credit limit and payment term decide who may buy on credit: manager / owner (sales.creditApv) only.
    if ((body.creditLimit !== undefined && !d(body.creditLimit).eq(d(before.creditLimit))) || (body.term !== undefined && JSON.stringify(body.term) !== JSON.stringify(before.term))) {
      if (can(ctx, 'sales.creditApv') !== 1) throw E.forbidden('แก้วงเงินเครดิตหรือเครดิตเทอมได้เฉพาะผู้จัดการหรือเจ้าของร้าน', { perm: 'sales.creditApv' });
    }
    const ch: string[] = [];
    for (const k of Object.keys(body) as (keyof typeof body)[]) {
      const a = JSON.stringify(before[k]); const b = JSON.stringify(after[k]);
      if (a !== b) ch.push(k === 'creditLimit' ? `วงเงินเครดิต: ${before.creditLimit} → ${after.creditLimit}` : k === 'active' ? (after.active ? 'เปิดใช้งาน' : 'ปิดใช้งาน') : `${k}: ${a} → ${b}`);
    }
    await writeAuditFor(tx, ctx, 'update', 'customer', after.code, ch.join(', ') || 'ไม่มีการเปลี่ยนแปลง');
    return after;
  }));
  app.get('/api/roles', authed(async (tx, ctx) => listRoles(tx, ctx)));
  app.post('/api/roles', authed(async (tx, ctx, req, reply) => { reply.status(201); return createRole(tx, ctx, ShopRoleCreate.parse(req.body)); }));
  app.patch('/api/roles/:id', authed(async (tx, ctx, req) => updateRole(tx, ctx, (req.params as { id: string }).id, ShopRoleUpdate.parse(req.body))));
  app.post('/api/roles/:id/delete', authed(async (tx, ctx, req) => deleteRole(tx, ctx, (req.params as { id: string }).id)));
  app.get('/api/customers/:id', authed(async (tx, _ctx, req) => getCustomer(tx, (req.params as { id: string }).id)));
  app.post('/api/customers', authed(async (tx, ctx, req, reply) => {
    requireAny(ctx, ['data.master', 'sales.doc', 'pos.sell']);
    const c = await createCustomer(tx, ctx, CustomerCreate.parse(req.body));
    await writeAuditFor(tx, ctx, 'create', 'customer', c.code, c.name);
    reply.status(201);
    return c;
  }));
  app.get('/api/vendors', authed(async (tx, _ctx, req) => listVendors(tx, pageQuery.parse(req.query))));
  app.post('/api/vendors', authed(async (tx, ctx, req, reply) => {
    requirePerm(ctx, 'data.master');
    const v = await createVendor(tx, ctx, VendorCreate.parse(req.body));
    await writeAuditFor(tx, ctx, 'create', 'vendor', v.code, v.name);
    reply.status(201);
    return v;
  }));
  app.get('/api/warehouses', authed(async (tx, _ctx, req) => listWarehouses(tx, pageQuery.extend({ kind: z.enum(['normal', 'damaged']).optional() }).parse(req.query))));
  app.post('/api/warehouses', authed(async (tx, ctx, req, reply) => { reply.status(201); return createWarehouse(tx, ctx, WarehouseUpsert.parse(req.body)); }));
  app.patch('/api/warehouses/:id', authed(async (tx, ctx, req) => updateWarehouse(tx, ctx, (req.params as { id: string }).id, WarehouseUpsert.partial().parse(req.body))));

  app.get('/api/audit-log', authed(async (tx, ctx, req) => auditLog(tx, ctx, pageQuery.parse(req.query))));
  app.get('/api/audit-log/verify', authed(async (tx, ctx) => verifyAudit(tx, ctx)));
}

const writeAuditFor = (tx: Tx, ctx: Ctx, action: string, object: string, ref: string, detail = '') => writeAudit(tx, ctx, [{ action, object, ref, detail }]);
