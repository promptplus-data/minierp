/** BR-14 tenant isolation (RLS), BR-18 audit log, edition capabilities, route table, on-prem pairing + backup hook. */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Meta, routes } from '@erp/contracts';
import { seedMinimalTenant, withTenant, type SeedResult } from '@erp/db';
import { buildApp } from '../src/app';
import { client, login, openShift, saleBody, setupEnv, TODAY, type Env } from './helpers';

let env: Env;
let b: SeedResult;
let saleNo: string;

beforeAll(async () => {
  env = await setupEnv();
  b = await seedMinimalTenant(env.pool, 'shopb', 'ร้าน B');
  const prae = await login(env.app, 'prae');
  const shift = await openShift(prae);
  saleNo = (await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00'))).body.no;
});
afterAll(async () => { await env.close(); });

describe('BR-14 tenant isolation (RLS)', () => {
  it('a query that forgets WHERE tenant_id still only sees its own tenant', async () => {
    const a = env.seed.tenantId;
    const rows = await withTenant(env.pool, a, (tx) => tx.query<{ tenant_id: string; sku: string }>(`select tenant_id, sku from products`));
    expect(rows.rows.length).toBe(12);
    expect(rows.rows.every((r) => r.tenant_id === a)).toBe(true);
    const bRows = await withTenant(env.pool, b.tenantId, (tx) => tx.query<{ sku: string }>(`select sku from products`));
    expect(bRows.rows.map((r) => r.sku)).toEqual(['B-ONLY']);
    const docs = await withTenant(env.pool, b.tenantId, (tx) => tx.query(`select * from docs`));
    expect(docs.rowCount).toBe(0);
    const lots = await withTenant(env.pool, b.tenantId, (tx) => tx.query(`select * from stock_lots`));
    expect(lots.rowCount).toBe(1);
  });

  it('no tenant set → no rows at all', async () => {
    const r = await withTenant(env.pool, null, (tx) => tx.query(`select * from products`));
    expect(r.rowCount).toBe(0);
  });

  it('cannot write a row into another tenant', async () => {
    await expect(withTenant(env.pool, env.seed.tenantId, (tx) =>
      tx.query(`insert into customers (tenant_id, code, name) values ($1, 'X1', 'แอบใส่')`, [b.tenantId]))).rejects.toThrow(/row-level security/);
  });

  it('through the API: tenant B sees only its products and cannot open tenant A documents', async () => {
    const owner = await login(env.app, 'owner'); // username exists only in tenant B
    const products = await owner.get('/api/products');
    expect(products.body.items.map((p: { sku: string }) => p.sku)).toEqual(['B-ONLY']);
    const doc = await owner.get(`/api/sales/docs/${saleNo}`);
    expect(doc.status).toBe(404);
  });
});

describe('BR-18 audit log', () => {
  it('every mutation is logged with a valid per-tenant hash chain', async () => {
    const owner = await login(env.app, 'charoen');
    const page = await owner.get('/api/audit-log?limit=100');
    const actions = page.body.items.map((e: { action: string; object: string; ref: string }) => `${e.action}:${e.object}`);
    expect(actions).toEqual(expect.arrayContaining(['open:shift', 'create:ABB', 'login:user', 'seed:tenant']));
    const v = await owner.get('/api/audit-log/verify');
    expect(v.body).toMatchObject({ ok: true, brokenAt: null });
    const chain = await env.pool.query(`select chain_seq, prev_hash, hash from audit_log where tenant_id = $1 order by chain_seq`, [env.seed.tenantId]);
    chain.rows.forEach((r, i) => {
      expect(Number(r.chain_seq)).toBe(i + 1);
      expect(r.prev_hash).toBe(i === 0 ? '' : chain.rows[i - 1].hash);
    });
  });

  it('cannot be updated or deleted (app role, and trigger even for a superuser)', async () => {
    await expect(withTenant(env.pool, env.seed.tenantId, (tx) => tx.query(`update audit_log set detail = 'แก้'`))).rejects.toThrow(/permission denied/);
    await expect(withTenant(env.pool, env.seed.tenantId, (tx) => tx.query(`delete from audit_log`))).rejects.toThrow(/permission denied/);
    await expect(env.pool.query(`update audit_log set detail = 'แก้'`)).rejects.toThrow(/append-only/);
    await expect(env.pool.query(`delete from audit_log`)).rejects.toThrow(/append-only/);
  });

  it('tampering is detected by the chain check', async () => {
    const c = await env.pool.connect();
    try {
      await c.query('begin');
      await c.query(`alter table audit_log disable trigger audit_log_no_update`);
      await c.query(`update audit_log set detail = 'แก้ไขย้อนหลัง' where tenant_id = $1 and chain_seq = 2`, [env.seed.tenantId]);
      const r = await c.query(`select erp_audit_verify($1)::int broken`, [env.seed.tenantId]);
      expect(r.rows[0].broken).toBe(2);
      await c.query('rollback');
    } finally {
      c.release();
    }
  });
});

describe('editions (M19)', () => {
  const metaOf = async (edition: 'cloud' | 'onprem') => {
    const prev = process.env.EDITION;
    process.env.EDITION = edition; // what the bundler bakes in
    try {
      const app = await buildApp({ pool: env.pool, edition, jwtSecret: 'x', today: () => TODAY });
      const r = await client(app).get('/api/meta');
      const allRoutes = Object.entries(routes).map(([k, v]) => {
        const [method, url] = v.split(' ') as ['GET' | 'POST' | 'PATCH', string];
        return { k, registered: app.hasRoute({ method, url }) };
      });
      await app.close();
      return { body: r.body, allRoutes };
    } finally {
      process.env.EDITION = prev;
    }
  };

  it('onprem: Prompt Plus capabilities false, routes not registered, shop from the single tenant', async () => {
    const { body, allRoutes } = await metaOf('onprem');
    expect(body.edition).toBe('onprem');
    expect(Object.keys(body.capabilities)).toEqual(['scgFamily']); // nothing cloud-only in the on-prem response
    expect(Meta.parse(body).capabilities).toMatchObject({ promptPlusOrders: false, promptPlusSso: false });
    expect(body.shop).toMatchObject({ name: 'ร้านวัสดุเจริญชัย', taxId: '0505561004321', vatRegistered: true, b2bVatMode: 'exc' });
    const missing = allRoutes.filter((r) => !r.registered).map((r) => r.k);
    expect(missing.sort()).toEqual(['ppIncoming', 'ppOrderFromDoc']);
  });

  it('cloud: Prompt Plus capabilities true, every contract route registered except on-prem pairing', async () => {
    const { body, allRoutes } = await metaOf('cloud');
    expect(body.edition).toBe('cloud');
    expect(Meta.parse(body).capabilities).toEqual({ promptPlusOrders: true, promptPlusSso: true, scgFamily: true });
    expect(allRoutes.filter((r) => !r.registered).map((r) => r.k).sort()).toEqual(['pair', 'pairingCode']);
  });
});

describe('on-prem pairing and shift-close backup hook', () => {
  it('a 6-digit code pairs one device once and sets a device cookie', async () => {
    const owner = await login(env.app, 'charoen');
    const code = await owner.post('/api/devices/pairing-code');
    expect(code.status).toBe(201);
    expect(code.body.code).toMatch(/^\d{6}$/);
    const pair = await env.app.inject({ method: 'GET', url: `/pair?code=${code.body.code}&name=POS-2` });
    expect(pair.statusCode).toBe(302);
    expect(String(pair.headers['set-cookie'])).toMatch(/^erp_device=[\w-]+; Path=\/; HttpOnly/);
    const again = await env.app.inject({ method: 'GET', url: `/pair?code=${code.body.code}` });
    expect(again.statusCode).toBe(400);
    const cashier = await login(env.app, 'prae');
    expect((await cashier.post('/api/devices/pairing-code')).status).toBe(403);
  });

  it('runs BACKUP_SCRIPT -Reason shift-close after the close commits', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'erp-backup-'));
    const script = path.join(dir, 'backup.sh');
    const out = path.join(dir, 'ran.txt');
    writeFileSync(script, `#!/bin/sh\necho "$@" > "${out}"\n`);
    chmodSync(script, 0o755);
    const app = await buildApp({ pool: env.pool, edition: 'onprem', jwtSecret: 'x', today: () => TODAY, backupScript: script });
    const suda = await login(app, 'suda');
    const id = await openShift(suda, '100.00');
    const r = await suda.post(`/api/shifts/${id}/close`, { counted: '100.00' });
    expect(r.status).toBe(200);
    for (let i = 0; i < 50 && !existsSync(out); i++) await new Promise((res) => setTimeout(res, 50));
    expect(readFileSync(out, 'utf8').trim()).toBe('-Reason shift-close');
    await app.close();
  });

  it('a failing backup script never fails the close', async () => {
    const app = await buildApp({ pool: env.pool, edition: 'onprem', jwtSecret: 'x', today: () => TODAY, backupScript: '/nonexistent/backup.ps1' });
    const boy = await login(app, 'boy');
    const id = await openShift(boy, '0.00');
    expect((await boy.post(`/api/shifts/${id}/close`, { counted: '0.00' })).status).toBe(200);
    await app.close();
  });
});

describe('health and SPA', () => {
  it('GET /healthz', async () => {
    const r = await client(env.app).get('/healthz');
    expect(r).toMatchObject({ status: 200, body: { ok: true, edition: 'onprem' } });
  });

  it('serves WEB_DIST_DIR with SPA fallback; unknown API routes stay JSON 404', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'erp-web-'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>ERP</title>');
    const app = await buildApp({ pool: env.pool, edition: 'onprem', jwtSecret: 'x', webDistDir: dir });
    const deep = await app.inject({ method: 'GET', url: '/pos/checkout', headers: { accept: 'text/html' } });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('<title>ERP</title>');
    const api = await app.inject({ method: 'GET', url: '/api/nope', headers: { accept: 'text/html' } });
    expect(api.statusCode).toBe(404);
    expect(api.json().code).toBe('NOT_FOUND');
    await app.close();
  });
});
