/** M14 SCG Admin (cloud): sign-in, shops, terms gate (M02/BR-15), suspension, KPI, central master push, support view, licenses. */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@erp/db';
import { seedAdmin } from '@erp/db/src/seedAdmin';
import { client, login, setupEnv, type Client, type Env } from '../helpers';
import { DEV_PRIVATE_PEM, admLogin, buildCloud } from './util';

let env: Env;
let cloud: FastifyInstance;
let scg: Client;
let shopId: string;

beforeAll(async () => {
  env = await setupEnv();
  await seedAdmin(env.pool, env.seed.tenantId);
  process.env.LICENSE_SIGNING_KEY = DEV_PRIVATE_PEM;
  cloud = await buildCloud(env.pool);
  scg = await admLogin(cloud);
});
afterAll(async () => {
  delete process.env.LICENSE_SIGNING_KEY;
  await cloud.close();
  await env.close();
});

const shopBody = {
  code: 'chaiyo', name: 'ร้านชัยโยวัสดุ', taxId: '0105566001122', vatRegistered: true, region: 'ภาคเหนือ', customerCode: 'C-778812',
  owner: { username: 'chaiyo.owner', name: 'คุณชัยโย มั่นคง', password: 'secret12', pin: '2468' },
};

describe('SCG Admin sign-in is separate from shop users', () => {
  it('wrong password is audited and locks after 5 tries; shop tokens cannot call SCG Admin routes and vice versa', async () => {
    for (let i = 0; i < 5; i++) expect((await client(cloud).post('/api/adm/auth/login', { username: 'nok.master', password: 'x' })).status).toBe(401);
    expect((await client(cloud).post('/api/adm/auth/login', { username: 'nok.master', password: '1234' })).body.details.reason).toBe('LOCKED');
    const shopOwner = await login(cloud, 'charoen');
    expect((await shopOwner.get('/api/adm/tenants')).status).toBe(401);
    expect((await scg.get('/api/products')).status).toBe(401);
    const a = await withTenant(env.pool, null, async (tx) => {
      await tx.query(`select set_config('app.platform','on',true)`);
      return tx.query(`select count(*)::int n from platform_audit where action = 'login-failed'`);
    });
    expect(a.rows[0].n).toBe(6);
  });

  it('platform context sees no shop rows (BR-14): only the definer functions cross shops', async () => {
    const r = await withTenant(env.pool, null, async (tx) => {
      await tx.query(`select set_config('app.platform','on',true)`);
      return { docs: (await tx.query(`select * from docs`)).rowCount, users: (await tx.query(`select * from users`)).rowCount };
    });
    expect(r).toEqual({ docs: 0, users: 0 });
    // the overview function refuses to run outside platform context
    await expect(withTenant(env.pool, env.seed.tenantId, (tx) => tx.query(`select * from adm_tenant_overview()`))).rejects.toThrow();
  });
});

describe('shops (REQ-M14-01/04) and terms (M02, BR-15)', () => {
  it('creates shop + POS warehouse + owner user with employee record; code must be unique', async () => {
    const r = await scg.post('/api/adm/tenants', shopBody);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ code: 'chaiyo', status: 'active', users: 1, region: 'ภาคเหนือ', edition: 'cloud' });
    shopId = r.body.id;
    expect((await scg.post('/api/adm/tenants', shopBody)).body.details.reason).toBe('CODE_TAKEN');
    const emp = await env.pool.query(`select code, emp_type from employees where tenant_id = $1`, [shopId]);
    expect(emp.rows).toEqual([{ code: 'OWN001', emp_type: 'owner' }]);
    const list = await scg.get('/api/adm/tenants?q=ชัยโย');
    expect(list.body.items.map((t: { code: string }) => t.code)).toEqual(['chaiyo']);
  });

  it('the new shop cannot be used until its owner accepts the current terms with the required consent', async () => {
    const o = await login(cloud, 'chaiyo.owner', 'secret12');
    const blocked = await o.get('/api/products');
    expect(blocked.status).toBe(403);
    expect(blocked.body.details.reason).toBe('TERMS_REQUIRED');
    const st = await o.get('/api/terms');
    expect(st.body).toMatchObject({ required: true, accepted: false, canAccept: true, current: { placeholder: true } });
    const v = st.body.current.version;
    expect((await o.post('/api/terms/accept', { version: v, signerName: 'นายชัยโย มั่นคง', consents: { shareData: true } })).body.details.reason).toBe('CONSENT_REQUIRED');
    expect((await o.post('/api/terms/accept', { version: 'old', signerName: 'x', consents: { terms: true } })).status).toBe(409);
    const ok = await o.post('/api/terms/accept', { version: v, signerName: 'นายชัยโย มั่นคง', signerTitle: 'เจ้าของกิจการ', consents: { terms: true, shareData: true } });
    expect(ok.body.acceptance).toMatchObject({ signerName: 'นายชัยโย มั่นคง', consents: { terms: true, shareData: true, customerData: false } });
    expect((await o.get('/api/products')).status).toBe(200);
    await expect(env.pool.query(`update terms_acceptances set signer_name = 'x'`)).resolves.toBeTruthy(); // superuser only; erp_app has no UPDATE
    const appUpd = withTenant(env.pool, shopId, (tx) => tx.query(`update terms_acceptances set signer_name = 'y'`));
    await expect(appUpd).rejects.toThrow(/permission denied/);
  });

  it('existing seed shops are not flagged (on-prem / demo) and staff cannot sign', async () => {
    const suda = await login(cloud, 'suda');
    expect((await suda.get('/api/terms')).body).toMatchObject({ required: false, canAccept: false });
    expect((await suda.post('/api/terms/accept', { version: 'x', signerName: 'x', consents: {} })).body.details.reason).toBe('OWNER_ONLY');
  });

  it('suspend: no sign-in and existing sessions stop; data intact; reason and SCG user in the shop log; resume', async () => {
    const o = await login(cloud, 'chaiyo.owner', 'secret12');
    expect((await scg.post(`/api/adm/tenants/${shopId}/suspend`, {})).status).toBe(400); // reason required
    const s = await scg.post(`/api/adm/tenants/${shopId}/suspend`, { reason: 'ค้างส่งเอกสารสัญญา' });
    expect(s.body).toMatchObject({ status: 'suspended', statusReason: 'ค้างส่งเอกสารสัญญา' });
    const lg = await client(cloud).post('/api/auth/login', { username: 'chaiyo.owner', password: 'secret12' });
    expect(lg.status).toBe(403);
    expect(lg.body.details.reason).toBe('SHOP_SUSPENDED');
    expect((await o.get('/api/terms')).body.details.reason).toBe('SHOP_SUSPENDED');
    const log = await env.pool.query(`select user_name, action, detail from audit_log where tenant_id = $1 order by chain_seq desc limit 2`, [shopId]);
    expect(log.rows.map((x) => x.action)).toEqual(['login-failed', 'suspend']);
    expect(log.rows[1]).toMatchObject({ user_name: 'SCG Admin: คุณกานต์ (SCG Admin)', detail: 'ค้างส่งเอกสารสัญญา' });
    await scg.post(`/api/adm/tenants/${shopId}/resume`, { reason: 'ส่งเอกสารแล้ว' });
    expect((await client(cloud).post('/api/auth/login', { username: 'chaiyo.owner', password: 'secret12' })).status).toBe(200);
  });

  it('roles: a master-data admin cannot open shops', async () => {
    await env.pool.query(`update platform_admins set locked_at = null, failed_logins = 0 where username = 'nok.master'`);
    const nok = await admLogin(cloud, 'nok.master');
    expect((await nok.post('/api/adm/tenants', { ...shopBody, code: 'other-1' })).body.details.reason).toBe('ADM_ROLE');
    expect((await nok.get('/api/adm/audit')).status).toBe(403);
  });
});

describe('KPI (REQ-M14-03): registered shops, new per month, active 30 days by region', () => {
  it('counts cloud shops and licensed on-prem shops; active = a bill in 30 days', async () => {
    await env.pool.query(`update tenants set adm_region = 'ภาคกลาง', created_at = '2026-09-15' where id = $1`, [env.seed.tenantId]);
    const prae = await login(cloud, 'prae');
    const shift = (await prae.post('/api/shifts/open', { float: '0.00', deviceId: 'POS-1' })).body.id;
    const { saleBody } = await import('../helpers');
    await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00'));
    await scg.post('/api/adm/licenses', { shopName: 'ร้านบ้านนา', taxId: '0305560009999', type: 'lifetime', region: 'ภาคอีสาน' });
    const k = await scg.get('/api/adm/kpi');
    expect(k.body).toMatchObject({ total: 3, byEdition: { cloud: 2, onprem: 1 }, active30: 1, suspended: 0 });
    expect(k.body.newPerMonth).toHaveLength(12);
    expect(k.body.newPerMonth.at(-1).month).toBe('2026-10');
    expect(k.body.newPerMonth.find((m: { month: string }) => m.month === '2026-09').cloud).toBe(1);
    expect(k.body.byRegion.find((r: { region: string }) => r.region === 'ภาคกลาง')).toEqual({ region: 'ภาคกลาง', total: 1, active30: 1 });
  });
});

describe('central SCG master and recommended prices (REQ-M14-02)', () => {
  let cid: string;
  it('creates a product with units and a scheduled price; shows the price in effect and the next one', async () => {
    const r = await scg.post('/api/adm/central-products', { sku: 'SCG-NEW-01', name: 'ปูนกาวสำเร็จรูป 25 กก.', category: 'กาว/ยาแนว', units: [{ name: 'ถุง', factor: '1' }, { name: 'พาเลท', factor: '60' }] });
    expect(r.status).toBe(201);
    cid = r.body.id;
    await scg.post(`/api/adm/central-products/${cid}/prices`, { retail: '180.00', wholesale: '170.00', effectiveFrom: '2026-10-01' });
    const p = await scg.post(`/api/adm/central-products/${cid}/prices`, { retail: '189.00', effectiveFrom: '2027-01-01' });
    expect(p.body).toMatchObject({ price: { retail: '180.00' }, nextPrice: { retail: '189.00', effectiveFrom: '2027-01-01' } });
    expect((await scg.post('/api/adm/central-products', { sku: 'BAD', name: 'x', units: [{ name: 'ชิ้น', factor: '2' }] })).status).toBe(400);
  });

  it('push: new products are created in shops at the recommended price; existing SKUs get linked; shop price edits are kept', async () => {
    const r = await scg.post('/api/adm/central-push', {});
    expect(r.body).toMatchObject({ shops: 2, products: 7 });
    const o = await login(cloud, 'charoen');
    const list = (await o.get('/api/products?q=SCG-NEW-01')).body.items;
    expect(list[0]).toMatchObject({ sku: 'SCG-NEW-01', price: '180.00', isScg: true });
    // the shop may change its selling price but not SCG's master fields
    const tiger = (await o.get('/api/products?q=SCG-CEM-T50')).body.items[0];
    expect((await o.patch(`/api/products/${tiger.id}`, { ...tiger, cost: undefined, name: 'ปูนเสือของร้าน' })).status).toBe(409);
    expect((await o.patch(`/api/products/${tiger.id}`, { ...tiger, cost: undefined, price: '150.00' })).status).toBe(200);
    await scg.post(`/api/adm/central-products/${cid}/prices`, { retail: '185.00', effectiveFrom: '2026-10-26' });
    await scg.post('/api/adm/central-push', { tenantIds: [env.seed.tenantId] });
    const after = await env.pool.query(`select sku, price::text, adm_srp::text, adm_price_custom from products where tenant_id = $1 and sku in ('SCG-CEM-T50','SCG-NEW-01') order by sku`, [env.seed.tenantId]);
    expect(after.rows).toEqual([
      { sku: 'SCG-CEM-T50', price: '150.00', adm_srp: '145.00', adm_price_custom: true },
      { sku: 'SCG-NEW-01', price: '185.00', adm_srp: '185.00', adm_price_custom: false },
    ]);
    const pushes = await scg.get('/api/adm/central-push');
    expect(pushes.body.items[0]).toMatchObject({ shops: 1, target: 'charoen' });
    const shopLog = await env.pool.query(`select action from audit_log where tenant_id = $1 and action = 'central-push'`, [env.seed.tenantId]);
    expect(shopLog.rowCount).toBe(2);
  });

  it('shops can read the central catalogue but never write it', async () => {
    const read = await withTenant(env.pool, env.seed.tenantId, (tx) => tx.query(`select sku from central_products`));
    expect(read.rowCount).toBeGreaterThan(0);
    await expect(withTenant(env.pool, env.seed.tenantId, (tx) => tx.query(`update central_products set name = 'x'`))).resolves.toMatchObject({ rowCount: 0 });
    await expect(withTenant(env.pool, env.seed.tenantId, (tx) => tx.query(`insert into central_products (sku, name, units, created_by) values ('H','h','[]','shop')`))).rejects.toThrow(/row-level security/);
  });
});

describe('support access with the shop consent (REQ-M14-05)', () => {
  it('needs an active grant from the owner, is read-only, and appears in the shop log', async () => {
    expect((await scg.post(`/api/adm/tenants/${env.seed.tenantId}/support`, {})).body.details.reason).toBe('NO_SUPPORT_GRANT');
    const o = await login(cloud, 'charoen');
    expect((await (await login(cloud, 'suda')).post('/api/support-grants', { days: 3 })).status).toBe(403);
    const g = await o.post('/api/support-grants', { days: 3, note: 'ช่วยดูสต็อกติดลบ' });
    expect(g.body.active).toBe(true);
    const v = await scg.post(`/api/adm/tenants/${env.seed.tenantId}/support`, {});
    expect(v.status).toBe(200);
    expect(v.body.users.map((u: { username: string }) => u.username)).toContain('charoen');
    expect(v.body.users[0]).not.toHaveProperty('password_hash');
    const log = await o.get('/api/audit-log');
    expect(log.body.items[0]).toMatchObject({ action: 'support-view', user: expect.stringContaining('SCG Support') });
    await o.post(`/api/support-grants/${g.body.id}/revoke`, {});
    expect((await scg.post(`/api/adm/tenants/${env.seed.tenantId}/support`, {})).status).toBe(403);
  });
});

describe('license issuing (REQ-M19-11) and the sales summary receiver (REQ-M19-10)', () => {
  it('issues expiring and lifetime keys bound to shop name + tax id; validates dates', async () => {
    expect((await scg.post('/api/adm/licenses', { shopName: 'x', taxId: '0105566001122', type: 'expiring' })).status).toBe(400);
    expect((await scg.post('/api/adm/licenses', { shopName: 'x', taxId: '0105566001122', type: 'expiring', expiresAt: '2026-01-01' })).status).toBe(400);
    const r = await scg.post('/api/adm/licenses', { shopName: 'ร้านทุ่งทอง', taxId: '0405561001234', type: 'expiring', expiresAt: '2027-10-31', region: 'ภาคอีสาน' });
    expect(r.body).toMatchObject({ type: 'expiring', expiresAt: '2027-10-31', revokedAt: null, key: expect.stringMatching(/^SCG1\./) });
    const list = await scg.get('/api/adm/licenses?q=ทุ่งทอง');
    expect(list.body.items).toHaveLength(1);
  });

  it('receiver accepts a summary signed by a registered key, refuses unknown, revoked or mismatched ones', async () => {
    const lic = (await scg.post('/api/adm/licenses', { shopName: 'ร้านบ้านสวน', taxId: '0505561007777', type: 'lifetime' })).body;
    const payload = { v: 1, shop: { name: 'ร้านบ้านสวน', taxId: '0505561007777' }, from: '2026-10-01', to: '2026-10-01',
      days: [{ date: '2026-10-01', scg: [{ sku: 'SCG-CEM-T50', name: 'ปูน', unit: 'ถุง', qty: '10', amount: '1450.00' }], otherAmount: '200.00', total: '1650.00' }],
      totals: { scgQty: '10', scgAmount: '1450.00', otherAmount: '200.00', total: '1650.00' } };
    const ok = await client(cloud).post('/api/scg/sales-summary', { key: lic.key, payload });
    expect(ok.status).toBe(201);
    expect((await client(cloud).post('/api/scg/sales-summary', { key: lic.key, payload: { ...payload, shop: { name: 'x', taxId: '0105500000001' } } })).body.details.reason).toBe('SHOP_MISMATCH');
    const { makeKey } = await import('./util');
    expect((await client(cloud).post('/api/scg/sales-summary', { key: makeKey({ shopName: 'ร้านบ้านสวน', taxId: '0505561007777' }), payload })).body.details.reason).toBe('LICENSE_UNKNOWN');
    await scg.post(`/api/adm/licenses/${lic.licenseId}/revoke`, { reason: 'ร้านเลิกกิจการ' });
    expect((await client(cloud).post('/api/scg/sales-summary', { key: lic.key, payload })).body.details.reason).toBe('LICENSE_REVOKED');
    const inbox = await scg.get(`/api/adm/sales-shares?licenseId=${lic.licenseId}`);
    expect(inbox.body.items).toHaveLength(1);
    expect(inbox.body.items[0]).toMatchObject({ total: '1650.00', payload: { totals: { scgQty: '10' } } });
  });

  it('every SCG Admin action is in the platform audit (super only)', async () => {
    const a = await scg.get('/api/adm/audit?limit=100');
    const actions = new Set(a.body.items.map((x: { action: string }) => x.action));
    for (const x of ['create', 'suspend', 'resume', 'push', 'price', 'issue', 'revoke', 'support-view']) expect(actions.has(x)).toBe(true);
  });
});
