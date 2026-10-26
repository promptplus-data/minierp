/** Regression tests for the independent review findings (F1..F15; R-numbers refer to the reviewer's proofs). */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { FailureLimiter } from '../src/lib/limiter';
import { client, login, openShift, saleBody, setupEnv, TODAY, type Client, type Env } from './helpers';

let env: Env;
let prae: Client;
let suda: Client;
let chai: Client;
let owner: Client;
let praeShift: string;
let sudaShift: string;

beforeAll(async () => {
  env = await setupEnv();
  prae = await login(env.app, 'prae');
  suda = await login(env.app, 'suda');
  chai = await login(env.app, 'chai');
  owner = await login(env.app, 'charoen');
  praeShift = await openShift(prae);
  sudaShift = await openShift(suda, '500.00', 'POS-2');
});
afterAll(async () => { await env.close(); });

describe('F1 negative prices / discounts (R3)', () => {
  it('rejects a negative unit price that would bypass the cap and below-cost check', async () => {
    const r = await suda.post('/api/sales/pos', saleBody(env.seed, sudaShift, [{ p: 'p1', qty: '1', price: '145.00' }, { p: 'p9', qty: '1', price: '-100.00' }], '45.00'));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION');
  });
  it('rejects negative line discounts, negative bill discount and pct over 100', async () => {
    const neg = await suda.post('/api/sales/pos', saleBody(env.seed, sudaShift, [{ p: 'p6', qty: '1', price: '89.00', discount: { kind: 'amt', value: '-10' } }], '99.00'));
    expect(neg.status).toBe(400);
    const bill = await suda.post('/api/sales/pos', saleBody(env.seed, sudaShift, [{ p: 'p6', qty: '1', price: '89.00' }], '99.00', { billDiscount: '-10' }));
    expect(bill.status).toBe(400);
    const pct = await owner.post('/api/sales/pos', saleBody(env.seed, sudaShift, [{ p: 'p6', qty: '1', price: '89.00', discount: { kind: 'pct', value: '150' } }], '0.00'));
    expect(pct.status).toBe(400);
  });
});

describe('F2 approver PIN brute force (R2)', () => {
  it('locks approvals after 5 wrong PINs for 15 minutes, audits each failure even though the sale rolls back, and unlock resets', async () => {
    const body = () => ({ ...saleBody(env.seed, praeShift, [{ p: 'p6', qty: '1', price: '89.00', discount: { kind: 'amt', value: '10' } }], '79.00') });
    const auditBefore = (await env.pool.query(`select count(*)::int n from audit_log where action = 'approval-failed'`)).rows[0].n;
    const reasons: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await prae.post('/api/sales/pos', { ...body(), discountApproval: { approverUserId: env.seed.users.suda, pin: String(9000 + i) } });
      reasons.push(r.body.details?.approvalError);
    }
    expect(reasons).toEqual(['BAD_PIN', 'BAD_PIN', 'BAD_PIN', 'BAD_PIN', 'LOCKED', 'LOCKED']);
    const right = await prae.post('/api/sales/pos', { ...body(), discountApproval: { approverUserId: env.seed.users.suda, pin: '1234' } });
    expect(right.status).toBe(403);
    expect(right.body.details.approvalError).toBe('LOCKED');
    const auditAfter = (await env.pool.query(`select count(*)::int n from audit_log where action = 'approval-failed'`)).rows[0].n;
    expect(auditAfter - auditBefore).toBe(7); // 5 wrong PINs + 2 attempts while locked
    const lock = await env.pool.query(`select pin_failed, pin_locked_until > now() + interval '14 minutes' locked from users where id = $1`, [env.seed.users.suda]);
    expect(lock.rows[0]).toMatchObject({ pin_failed: 5, locked: true });

    expect((await owner.post(`/api/users/${env.seed.users.suda}/unlock`)).status).toBe(200);
    const ok = await prae.post('/api/sales/pos', { ...body(), discountApproval: { approverUserId: env.seed.users.suda, pin: '1234' } });
    expect(ok.status).toBe(201);
  });
});

describe('F3 no self-approval (R1)', () => {
  it('manager cannot approve her own over-cap discount', async () => {
    const body = saleBody(env.seed, sudaShift, [{ p: 'p9', qty: '1', price: '300.00', discount: { kind: 'pct', value: '30' } }], '210.00');
    const r = await suda.post('/api/sales/pos', { ...body, discountApproval: { approverUserId: env.seed.users.suda, pin: '1234' } });
    expect(r.status).toBe(403);
    expect(r.body.details.approvalError).toBe('SELF_APPROVAL');
    const ok = await suda.post('/api/sales/pos', { ...body, idempotencyKey: randomUUID(), discountApproval: { approverUserId: env.seed.users.charoen, pin: '1234' } });
    expect(ok.status).toBe(201);
  });
  it('manager cannot approve her own return or void with her own PIN fields', async () => {
    const sale = await suda.post('/api/sales/pos', saleBody(env.seed, sudaShift, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00'));
    // a manager has sales.voidDoc = 1, so an approval is not needed; a cashier asking the manager is fine:
    const v = await prae.post(`/api/sales/docs/${sale.body.no}/void`, { reason: 'x', approverUserId: env.seed.users.prae, pin: '1234' });
    expect(v.status).toBe(403);
    expect(v.body.details.approvalError).toBe('SELF_APPROVAL');
  });
});

describe('F4 sale vs shift close race (R10)', () => {
  it('a close that starts while a sale is in flight waits for it and counts it', async () => {
    let closing: Promise<{ statusCode: number; json: () => any }> | null = null;
    let settledEarly = false;
    let armed = true;
    const app2 = await buildApp({
      pool: env.pool, edition: 'onprem', jwtSecret: 'test-secret', today: () => TODAY,
      hooks: {
        beforeCommit: async (op) => {
          if (op !== 'posSale' || !armed) return;
          armed = false;
          closing = app2.inject({ method: 'POST', url: `/api/shifts/${shiftId}/close`, headers: { authorization: `Bearer ${token}` }, payload: { counted: '0.00', note: 'race' } });
          closing.then(() => { settledEarly = true; });
          await new Promise((res) => setTimeout(res, 400));
        },
      },
    });
    const token: string = (await client(app2).post('/api/auth/login', { username: 'boy', password: '1234' })).body.token;
    const c = client(app2, token);
    const shiftId = (await c.post('/api/shifts/open', { float: '0.00', deviceId: 'POS-R' })).body.id;
    const sale = await c.post('/api/sales/pos', saleBody(env.seed, shiftId, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00'));
    expect(sale.status).toBe(201);
    expect(settledEarly).toBe(false); // close was blocked by the sale's FOR SHARE lock
    const closed = await closing!;
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ cashSales: '89.00', expected: '89.00' });
    // and after the close nothing more can be sold into it
    const late = await c.post('/api/sales/pos', saleBody(env.seed, shiftId, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00'));
    expect(late.body.code).toBe('SHIFT_REQUIRED');
    await app2.close();
  });
});

describe('F5 product kind flip (R12)', () => {
  it('cannot switch stock -> service while lots remain', async () => {
    const r = await owner.patch(`/api/products/${env.seed.products.p7}`, { kind: 'service' });
    expect(r.status).toBe(409);
    const fresh = await owner.post('/api/products', { sku: 'K-1', name: 'x', category: 'x', isScg: false, kind: 'stock', vat: 'v7', price: '1.00', units: [{ name: 'ชิ้น', factor: '1' }], reorderPoint: '0' });
    expect((await owner.patch(`/api/products/${fresh.body.id}`, { kind: 'service' })).status).toBe(200);
  });
});

describe('F6/F7 receipts (R5, R4)', () => {
  it('rejects a negative unit cost', async () => {
    const r = await chai.post('/api/stock/receipts', {
      vendorId: env.seed.vendors.v1, vendorInvoiceNo: 'INV-R5', deliveryNo: 'D-R5', warehouseId: env.seed.warehouses.WH1,
      lines: [{ productId: env.seed.products.p6, qty: '10', unitCost: '100' }, { productId: env.seed.products.p7, qty: '10', unitCost: '-50' }],
    });
    expect(r.status).toBe(400);
  });
  it('moving average with duplicate product lines is computed sequentially', async () => {
    const p4 = env.seed.products.p4!;
    const r = await suda.post('/api/stock/receipts', {
      vendorId: env.seed.vendors.v1, vendorInvoiceNo: 'INV-R4', deliveryNo: 'D-R4', warehouseId: env.seed.warehouses.WH1,
      lines: [{ productId: p4, qty: '10', unitCost: '100' }, { productId: p4, qty: '10', unitCost: '300' }],
    });
    expect(r.status).toBe(201);
    const after = await env.pool.query(`select cost::text c from products where id = $1`, [p4]);
    expect(after.rows[0].c).toBe('180.6154'); // (84 × 176 + 1000 + 3000) / 104
  });
});

describe('F8 proxy headers, pair limiter, device pairing', () => {
  it('X-Forwarded-For does not reset the /pair brake (trustProxy off)', async () => {
    let spoof429 = 0;
    for (let i = 0; i < 12; i++) {
      const r = await env.app.inject({ method: 'GET', url: '/pair?code=000001', headers: { accept: 'application/json', 'x-forwarded-for': `10.9.${i}.1` } });
      if (r.statusCode === 429) spoof429++;
    }
    expect(spoof429).toBeGreaterThan(0);
  });
  it('the failure map stays bounded', () => {
    const l = new FailureLimiter({ max: 3, windowMs: 60_000, maxEntries: 100 });
    for (let i = 0; i < 1000; i++) l.fail(`10.0.${i >> 8}.${i & 255}`);
    expect(l.size).toBeLessThanOrEqual(100);
    expect(l.blocked('10.0.3.231')).toBe(false);
  });
  it('on-prem: API calls from another LAN machine need a paired device cookie; localhost is exempt', async () => {
    const token = (await client(env.app).post('/api/auth/login', { username: 'prae', password: '1234' })).body.token;
    const remote = (cookie?: string) => env.app.inject({ method: 'GET', url: '/api/products', remoteAddress: '192.168.1.50', headers: { authorization: `Bearer ${token}`, ...(cookie ? { cookie } : {}) } });
    const unpaired = await remote();
    expect(unpaired.statusCode).toBe(403);
    expect(unpaired.json().details.reason).toBe('DEVICE_NOT_PAIRED');
    expect((await remote('erp_device=forged')).statusCode).toBe(403);
    const code = (await owner.post('/api/devices/pairing-code')).body.code;
    const pair = await env.app.inject({ method: 'GET', url: `/pair?code=${code}`, remoteAddress: '192.168.1.50', headers: { accept: 'application/json' } });
    const cookie = String(pair.headers['set-cookie']).split(';')[0]!;
    expect((await remote(cookie)).statusCode).toBe(200);
    // login, meta and healthz stay reachable without pairing
    const lg = await env.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '192.168.1.50', payload: { username: 'prae', password: '1234' } });
    expect(lg.statusCode).toBe(200);
    expect((await env.app.inject({ method: 'GET', url: '/api/meta', remoteAddress: '192.168.1.50' })).statusCode).toBe(200);
  });
});

describe('F9 stock document costs are hidden without data.cost (R6)', () => {
  it('issue response nulls unitCost for wh, shows it to a manager', async () => {
    const a = await chai.post('/api/stock/issues', { warehouseId: env.seed.warehouses.WH2, lines: [{ productId: env.seed.products.p2, qty: '1' }], reason: 'test' });
    expect(a.body.lines[0].unitCost).toBeNull();
    const b = await suda.post('/api/stock/issues', { warehouseId: env.seed.warehouses.WH2, lines: [{ productId: env.seed.products.p2, qty: '1' }], reason: 'test' });
    expect(b.body.lines[0].unitCost).not.toBeNull();
  });
});

describe('F10 locked account tokens (R9)', () => {
  it('an existing JWT stops working once the account is locked', async () => {
    const boy = await login(env.app, 'boy');
    for (let i = 0; i < 5; i++) await client(env.app).post('/api/auth/login', { username: 'boy', password: 'wrong' });
    expect((await boy.get('/api/auth/me')).status).toBe(401);
    await owner.post(`/api/users/${env.seed.users.boy}/unlock`);
  });
});

describe('F11 adjust self-approval (R7)', () => {
  it('a manager cannot approve her own request; the owner can approve his own', async () => {
    const req = await suda.post('/api/stock/adjust-requests', { warehouseId: env.seed.warehouses.WH1, lines: [{ productId: env.seed.products.p6, qtyDelta: '1' }], reason: 'found' });
    const a = await suda.post(`/api/stock/adjust-requests/${req.body.id}/approve`, {});
    expect(a.status).toBe(403);
    const own = await owner.post('/api/stock/adjust-requests', { warehouseId: env.seed.warehouses.WH1, lines: [{ productId: env.seed.products.p6, qtyDelta: '1' }], reason: 'found' });
    expect((await owner.post(`/api/stock/adjust-requests/${own.body.id}/approve`, {})).status).toBe(200);
  });
});
