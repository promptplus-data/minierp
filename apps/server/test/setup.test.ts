/** F15 on-prem first run: GET /api/meta needsSetup + POST /api/setup. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetData } from '@erp/db';
import { buildApp } from '../src/app';
import { client, setupEnv, TODAY, type Env } from './helpers';

let env: Env;
const body = {
  shop: { name: 'ร้านทดสอบ', taxId: '0105500000099', vatRegistered: true },
  owner: { username: 'boss', name: 'เจ้าของใหม่', password: 'secret123', pin: '2468' },
};

beforeAll(async () => {
  env = await setupEnv();
  await resetData(env.pool); // empty database, like a fresh install
});
afterAll(async () => { await env.close(); });

describe('first-run setup', () => {
  it('meta reports needsSetup on an empty on-prem database; cloud never does', async () => {
    expect((await client(env.app).get('/api/meta')).body.needsSetup).toBe(true);
    process.env.EDITION = 'cloud';
    const cloud = await buildApp({ pool: env.pool, edition: 'cloud', jwtSecret: 'x', today: () => TODAY });
    expect((await client(cloud).get('/api/meta')).body.needsSetup).toBe(false);
    expect(cloud.hasRoute({ method: 'POST', url: '/api/setup' })).toBe(false);
    await cloud.close();
    delete process.env.EDITION;
  });

  it('refuses setup from another LAN machine', async () => {
    const r = await env.app.inject({ method: 'POST', url: '/api/setup', remoteAddress: '192.168.1.60', payload: body });
    expect(r.statusCode).toBe(403);
  });

  it('validates the body', async () => {
    const r = await client(env.app).post('/api/setup', { ...body, owner: { ...body.owner, pin: '12' } });
    expect(r.status).toBe(400);
  });

  it('creates shop, POS warehouse and owner, signs in, and runs only once', async () => {
    const r = await client(env.app).post('/api/setup', body);
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ name: 'เจ้าของใหม่', role: 'owner' });
    const me = client(env.app, r.body.token);
    expect((await me.get('/api/warehouses')).body.items).toMatchObject([{ name: 'หน้าร้าน', isPos: true }]);
    const meta = (await client(env.app).get('/api/meta')).body;
    expect(meta).toMatchObject({ needsSetup: false, shop: { name: 'ร้านทดสอบ', taxId: '0105500000099' } });
    const login = await client(env.app).post('/api/auth/login', { username: 'boss', password: 'secret123' });
    expect(login.status).toBe(200);
    const again = await client(env.app).post('/api/setup', body);
    expect(again.status).toBe(409);
  });
});
