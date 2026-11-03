/** M19-11 offline license keys on-prem (Ed25519): install, 30-day warning, read-only after expiry, renewal. */
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { licenseState, parseLicenseKey, signLicense } from '../../src/modules/admin/license';
import { login, openShift, saleBody, setupEnv, type Client, type Env } from '../helpers';
import { makeKey } from './util';

let env: Env;
let owner: Client;
const SHOP = { shopName: 'ร้านวัสดุเจริญชัย', taxId: '0505561004321' };

beforeAll(async () => {
  env = await setupEnv();
  owner = await login(env.app, 'charoen');
  const t = await env.pool.query(`select name, tax_id from tenants where id = $1`, [env.seed.tenantId]);
  SHOP.shopName = t.rows[0].name;
  SHOP.taxId = t.rows[0].tax_id;
});
afterAll(async () => { await env.close(); });

describe('key format and state (pure)', () => {
  it('verifies the signature offline and rejects any tampering or another signer', () => {
    const key = makeKey({ ...SHOP, type: 'expiring', expiresAt: '2027-12-31' });
    expect(parseLicenseKey(key)).toMatchObject({ ...SHOP, type: 'expiring', expiresAt: '2027-12-31', edition: 'onprem' });
    const [p, body, sig] = key.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), expiresAt: null, type: 'lifetime' })).toString('base64url');
    expect(() => parseLicenseKey(`${p}.${forged}.${sig}`)).toThrow(/signature/);
    const other = generateKeyPairSync('ed25519').privateKey;
    const foreign = signLicense({ v: 1, licenseId: 'X', ...SHOP, edition: 'onprem', type: 'lifetime', expiresAt: null, issuedAt: new Date().toISOString() }, other);
    expect(() => parseLicenseKey(foreign)).toThrow(/signature/);
    expect(() => parseLicenseKey('hello')).toThrow(/format/);
  });

  it('warns 30 days before expiry, read-only after the last day, lifetime never expires', () => {
    const lic = parseLicenseKey(makeKey({ ...SHOP, type: 'expiring', expiresAt: '2026-11-25' }));
    expect(licenseState(lic, '2026-10-25', false)).toMatchObject({ state: 'valid', daysLeft: 31, readOnly: false });
    expect(licenseState(lic, '2026-10-26', false)).toMatchObject({ state: 'expiring', daysLeft: 30 });
    expect(licenseState(lic, '2026-11-25', false)).toMatchObject({ state: 'expiring', daysLeft: 0, readOnly: false });
    expect(licenseState(lic, '2026-11-26', false)).toMatchObject({ state: 'expired', readOnly: true });
    expect(licenseState(parseLicenseKey(makeKey(SHOP)), '2099-01-01', false)).toMatchObject({ state: 'valid', daysLeft: null });
    expect(licenseState(null, '2026-10-26', true)).toMatchObject({ state: 'none', readOnly: true });
    expect(licenseState(null, '2026-10-26', false)).toMatchObject({ state: 'none', readOnly: false });
  });
});

describe('on-prem license screen and read-only mode', () => {
  it('without a key (LICENSE_REQUIRED unset) the shop works; status says none', async () => {
    expect((await owner.get('/api/license')).body).toMatchObject({ state: 'none', readOnly: false, required: false });
  });

  it('only the owner installs; a key for another shop or the cloud edition is refused', async () => {
    const suda = await login(env.app, 'suda');
    expect((await suda.post('/api/license', { key: makeKey(SHOP) })).status).toBe(403);
    const wrong = await owner.post('/api/license', { key: makeKey({ shopName: 'ร้านอื่น', taxId: SHOP.taxId }) });
    expect(wrong.body.details.reason).toBe('LICENSE_SHOP_MISMATCH');
    expect((await owner.post('/api/license', { key: makeKey({ ...SHOP, edition: 'cloud' }) })).body.details.reason).toBe('LICENSE_EDITION');
    expect((await owner.post('/api/license', { key: 'SCG1.abcdefghijklmnop.qrstuvwxyz' })).body.details.reason).toBe('LICENSE_INVALID');
  });

  it('expired key: reading, printing and export keep working, new documents are refused; a new key renews', async () => {
    const r = await owner.post('/api/license', { key: makeKey({ ...SHOP, type: 'expiring', expiresAt: '2026-10-20' }) });
    expect(r.body).toMatchObject({ state: 'expired', readOnly: true, daysLeft: -6 });
    const prae = await login(env.app, 'prae');
    const shiftTry = await prae.post('/api/shifts/open', { float: '500.00', deviceId: 'POS-1' });
    expect(shiftTry.status).toBe(403);
    expect(shiftTry.body.details.reason).toBe('LICENSE_READ_ONLY');
    expect((await owner.post('/api/hr/employees', { name: 'x', startDate: '2026-10-01' })).body.details.reason).toBe('LICENSE_READ_ONLY');
    expect((await prae.get('/api/products')).status).toBe(200);
    expect((await owner.get('/api/sales/docs')).status).toBe(200);
    expect((await owner.post('/api/system/export', { passphrase: 'pass-phrase-1' })).status).toBe(200);
    // a still-valid key for the same shop lifts read-only mode
    const renew = await owner.post('/api/license', { key: makeKey({ ...SHOP, type: 'expiring', expiresAt: '2027-10-31' }) });
    expect(renew.body).toMatchObject({ state: 'valid', readOnly: false, daysLeft: 370 });
    const shift = await openShift(prae);
    expect((await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00'))).status).toBe(201);
    const a = await env.pool.query(`select count(*)::int n from audit_log where tenant_id = $1 and object = 'license'`, [env.seed.tenantId]);
    expect(a.rows[0].n).toBe(2);
  });

  it('a key edited in the database stops counting (re-verified on every read)', async () => {
    await env.pool.query(`update licenses set license_key = license_key || 'x' where tenant_id = $1`, [env.seed.tenantId]);
    expect((await owner.get('/api/license')).body.state).toBe('none');
  });

  it('LICENSE_REQUIRED=1: no valid key means read-only from the start', async () => {
    process.env.LICENSE_REQUIRED = '1';
    try {
      const app = await buildApp({ pool: env.pool, edition: 'onprem', jwtSecret: 'test-secret', today: () => '2026-10-26' });
      const lg = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'charoen', password: '1234' } });
      const tok = JSON.parse(lg.body).token;
      const st = await app.inject({ method: 'GET', url: '/api/license', headers: { authorization: `Bearer ${tok}` } });
      expect(JSON.parse(st.body)).toMatchObject({ state: 'none', readOnly: true, required: true });
      const c = await app.inject({ method: 'POST', url: '/api/hr/leaves', headers: { authorization: `Bearer ${tok}` }, payload: { type: 'sick', fromDate: '2026-11-02', toDate: '2026-11-02' } });
      expect(JSON.parse(c.body).details.reason).toBe('LICENSE_READ_ONLY');
      await app.close();
    } finally {
      delete process.env.LICENSE_REQUIRED;
    }
  });
});
