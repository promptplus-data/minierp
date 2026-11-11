/** Warehouse create / edit (kind, POS, close), home low-stock ignoring damaged goods, project header edit. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, setupEnv, type Client, type Env } from './helpers';

let env: Env;
let owner: Client;
let suda: Client;
let chai: Client;
const P = (k: string) => env.seed.products[k]!;
const W = (k: string) => env.seed.warehouses[k]!;

beforeAll(async () => {
  env = await setupEnv();
  [owner, suda, chai] = await Promise.all([login(env.app, 'charoen'), login(env.app, 'suda'), login(env.app, 'chai')]);
});
afterAll(async () => { await env.close(); });

async function ok<T = any>(p: Promise<{ status: number; body: any }>, status = 200): Promise<T> {
  const r = await p;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

describe('warehouses', () => {
  let dmg: any;
  it('only sys.settings may create; a damaged warehouse cannot be POS; codes are unique', async () => {
    expect((await suda.post('/api/warehouses', { code: 'X1', name: 'x' })).status).toBe(403);
    const bad = await owner.post('/api/warehouses', { code: 'DM1', name: 'ของเสีย', kind: 'damaged', isPos: true });
    expect(bad.status).toBe(400);
    expect(bad.body.details.field).toBe('isPos');
    dmg = await ok(owner.post('/api/warehouses', { code: 'DM1', name: 'ของเสียหลังร้าน', kind: 'damaged' }), 201);
    expect(dmg).toMatchObject({ code: 'DM1', kind: 'damaged', isPos: false, active: true, system: false });
    const dup = await owner.post('/api/warehouses', { code: 'DM1', name: 'ซ้ำ' });
    expect(dup.status).toBe(409);
    expect(dup.body.details.field).toBe('code');
  });

  it('home low-stock counts sellable stock only: goods moved into the damaged warehouse make the product low', async () => {
    const names = async () => ((await ok(owner.get('/api/reports/dashboard'))).lowStock.items as { name: string }[]).map((x) => x.name);
    expect(await names()).not.toContain('กาวซีเมนต์ปูกระเบื้อง 20 กก.');
    await ok(chai.post('/api/stock/transfers', { fromWarehouseId: W('WH2'), toWarehouseId: dmg.id, lines: [{ productId: P('p4'), qty: '60', unitIdx: 0 }] }), 201);
    expect(await names()).toContain('กาวซีเมนต์ปูกระเบื้อง 20 กก.');
  });

  it('kind change and closing are refused while stock remains; rename is fine and audited', async () => {
    const k = await owner.patch(`/api/warehouses/${dmg.id}`, { kind: 'normal' });
    expect(k.status).toBe(409);
    expect(k.body.details.field).toBe('kind');
    expect((await owner.patch(`/api/warehouses/${dmg.id}`, { active: false })).status).toBe(409);
    expect(await ok(owner.patch(`/api/warehouses/${dmg.id}`, { name: 'คลังของเสีย A' }))).toMatchObject({ name: 'คลังของเสีย A', kind: 'damaged' });
    const log = await ok(owner.get('/api/audit-log?q=DM1&limit=50'));
    expect(JSON.stringify(log)).toContain('คลังของเสีย A');
  });

  it('the shop keeps an active POS warehouse', async () => {
    const r = await owner.patch(`/api/warehouses/${W('WH1')}`, { isPos: false });
    expect(r.status).toBe(409);
    expect(r.body.details.field).toBe('isPos');
    const empty = await ok(owner.post('/api/warehouses', { code: 'WH9', name: 'โกดังใหม่' }), 201);
    expect(await ok(owner.patch(`/api/warehouses/${empty.id}`, { active: false }))).toMatchObject({ active: false });
  });
});

describe('customer search by phone', () => {
  it('finds a customer by phone typed without dashes, with dashes, with spaces or with +66', async () => {
    for (const q of ['0897771100', '089-777-1100', '089 777 1100', '+66897771100', '7771100']) {
      const r = await ok(owner.get(`/api/customers?q=${encodeURIComponent(q)}`));
      expect(r.items.map((x: { name: string }) => x.name), q).toContain('ร้านวัสดุบ้านนา');
    }
    // a customer saved without dashes is found by a query with dashes
    await ok(owner.post('/api/customers', { name: 'ร้านเบอร์ติดกัน', phone: '0812223333' }), 201);
    expect((await ok(owner.get(`/api/customers?q=${encodeURIComponent('081-222-3333')}`))).items.map((x: { name: string }) => x.name)).toContain('ร้านเบอร์ติดกัน');
  });
});
