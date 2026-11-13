/** Cloud license keys and per-shop menus (packages/contracts/src/features.ts) on both editions. */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FEATURE_KEYS, apiAllowed, enabledFeatures } from '@erp/contracts';
import { seedAdmin } from '@erp/db/src/seedAdmin';
import { buildApp } from '../../src/app';
import { login, openShift, setupEnv, type Client, type Env } from '../helpers';
import { DEV_PRIVATE_PEM, admLogin, buildCloud, makeKey } from './util';

let env: Env;
let cloud: FastifyInstance;
let scg: Client;
let SHOP: { shopName: string; taxId: string };

beforeAll(async () => {
  env = await setupEnv();
  await seedAdmin(env.pool, env.seed.tenantId);
  process.env.LICENSE_SIGNING_KEY = DEV_PRIVATE_PEM;
  delete process.env.LICENSE_REQUIRED;
  cloud = await buildCloud(env.pool);
  scg = await admLogin(cloud);
  const t = await env.pool.query(`select name, tax_id from tenants where id = $1`, [env.seed.tenantId]);
  SHOP = { shopName: t.rows[0].name, taxId: t.rows[0].tax_id };
});
afterAll(async () => {
  delete process.env.LICENSE_SIGNING_KEY;
  process.env.LICENSE_REQUIRED = '0';
  await cloud.close();
  await env.close();
});

describe('API ownership', () => {
  it('a path shared by two menus stays open while either is on; unowned paths are always open', () => {
    const noB2b = enabledFeatures(FEATURE_KEYS.filter((k) => k !== 'b2b'));
    expect(apiAllowed('/api/sales/orders/:id', noB2b)).toBe(true);
    expect(apiAllowed('/api/sales/quotations', noB2b)).toBe(false);
    const neither = enabledFeatures(FEATURE_KEYS.filter((k) => k !== 'b2b' && k !== 'projects'));
    expect(apiAllowed('/api/sales/orders', neither)).toBe(false);
    expect(apiAllowed('/api/products', enabledFeatures([]))).toBe(true);
    expect(apiAllowed('/api/stock', enabledFeatures([]))).toBe(true);
    expect(apiAllowed('/api/stock/ledger', enabledFeatures([]))).toBe(false);
  });
});

describe('cloud license keys', () => {
  it('with a signing key configured, a shop without a key is read-only but can still read and enter a key', async () => {
    const owner = await login(cloud, 'charoen');
    expect((await owner.get('/api/license')).body).toMatchObject({ state: 'none', readOnly: true, required: true });
    expect((await owner.get('/api/products')).status).toBe(200);
    const leave = await owner.post('/api/hr/leaves', { type: 'sick', fromDate: '2026-11-02', toDate: '2026-11-02' });
    expect(leave.body.details.reason).toBe('LICENSE_READ_ONLY');
  });

  it('an on-prem key is refused; a cloud key issued by SCG Admin lifts read-only; lifetime = no expiry', async () => {
    const owner = await login(cloud, 'charoen');
    expect((await owner.post('/api/license', { key: makeKey(SHOP) })).body.details.reason).toBe('LICENSE_EDITION');
    const issued = await scg.post('/api/adm/licenses', { ...SHOP, type: 'lifetime', edition: 'cloud' });
    expect(issued.status).toBe(201);
    expect(issued.body).toMatchObject({ edition: 'cloud', features: null });
    const st = await owner.post('/api/license', { key: issued.body.key });
    expect(st.body).toMatchObject({ state: 'valid', readOnly: false, daysLeft: null, license: { edition: 'cloud', type: 'lifetime' } });
    const shift = await openShift(await login(cloud, 'prae'));
    expect(shift).toBeTruthy();
  });

  it('revoking the key in SCG Admin makes the shop read-only again at once, and the key cannot be re-entered', async () => {
    const owner = await login(cloud, 'charoen');
    const lic = (await owner.get('/api/license')).body.license;
    expect((await scg.post(`/api/adm/licenses/${lic.licenseId}/revoke`, { reason: 'ยกเลิกสัญญา' })).status).toBe(200);
    expect((await owner.get('/api/license')).body).toMatchObject({ state: 'none', readOnly: true });
    const key = (await env.pool.query(`select license_key from licenses where tenant_id = $1 order by installed_at desc limit 1`, [env.seed.tenantId])).rows[0].license_key;
    expect((await owner.post('/api/license', { key })).body.details.reason).toBe('LICENSE_REVOKED');
  });
});

describe('per-shop menus', () => {
  beforeAll(async () => {
    process.env.LICENSE_REQUIRED = '0';
  });
  afterAll(() => {
    delete process.env.LICENSE_REQUIRED;
  });

  it('cloud: SCG switches menus live; a switched-off menu disappears from entitlements and its API refuses', async () => {
    const owner = await login(cloud, 'charoen');
    expect((await owner.get('/api/entitlements')).body.features).toHaveLength(FEATURE_KEYS.length);
    const on = FEATURE_KEYS.filter((k) => k !== 'pos' && k !== 'payroll');
    const t = await scg.post(`/api/adm/tenants/${env.seed.tenantId}/features`, { features: on });
    expect(t.status).toBe(200);
    expect(t.body.features).toEqual(on);
    expect((await owner.get('/api/entitlements')).body.features).toEqual(on);
    const prae = await login(cloud, 'prae');
    const open = await prae.post('/api/shifts/open', { float: '500.00', deviceId: 'POS-1' });
    expect(open.status).toBe(403);
    expect(open.body.details.reason).toBe('FEATURE_DISABLED');
    expect((await owner.get('/api/hr/payroll')).body.details.reason).toBe('FEATURE_DISABLED');
    expect((await owner.get('/api/hr/employees')).status).toBe(200);
    expect((await prae.get('/api/products')).status).toBe(200);
    const log = await env.pool.query(`select detail from audit_log where tenant_id = $1 and object = 'features'`, [env.seed.tenantId]);
    expect(log.rows).toHaveLength(1);
    // null = every menu again
    expect((await scg.post(`/api/adm/tenants/${env.seed.tenantId}/features`, { features: null })).body.features).toBeNull();
    expect((await owner.get('/api/entitlements')).body.features).toHaveLength(FEATURE_KEYS.length);
  });

  it('only shop-writing SCG roles may change menus', async () => {
    const nok = await admLogin(cloud, 'nok.master');
    expect((await nok.post(`/api/adm/tenants/${env.seed.tenantId}/features`, { features: [] })).status).toBe(403);
  });

  it('on-prem: the menus ride in the key; the server enforces the key, not the shop', async () => {
    const issued = await scg.post('/api/adm/licenses', { ...SHOP, type: 'lifetime', edition: 'onprem', features: FEATURE_KEYS.filter((k) => k !== 'ap') });
    expect(issued.body.features).toHaveLength(FEATURE_KEYS.length - 1);
    const app = await buildApp({ pool: env.pool, edition: 'onprem', jwtSecret: 'test-secret', today: () => '2026-10-26' });
    try {
      const lg = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'charoen', password: '1234' } });
      const h = { authorization: `Bearer ${JSON.parse(lg.body).token}` };
      expect(JSON.parse((await app.inject({ method: 'GET', url: '/api/entitlements', headers: h })).body).features).toHaveLength(FEATURE_KEYS.length);
      const inst = await app.inject({ method: 'POST', url: '/api/license', headers: h, payload: { key: issued.body.key } });
      expect(inst.statusCode).toBe(200);
      const ent = JSON.parse((await app.inject({ method: 'GET', url: '/api/entitlements', headers: h })).body).features;
      expect(ent).not.toContain('ap');
      const ap = await app.inject({ method: 'GET', url: '/api/ap/bills', headers: h });
      expect(JSON.parse(ap.body).details.reason).toBe('FEATURE_DISABLED');
    } finally {
      await app.close();
    }
  });
});
