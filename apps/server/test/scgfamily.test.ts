/** SCG Family member coupons (round 4 ข้อ 7, cloud only): provider stub / demo, evaluate, reserve, POS and SO save, void, on-prem. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { demoProvider, stubProvider, type ScgfProviderCart } from '../src/adapters/scgfamily';
import { client, login, openShift, saleBody, setupEnv, TODAY, type Client, type Env } from './helpers';

let env: Env;
let prae: Client;
let owner: Client;
let shift: string;
const prev = { edition: process.env.EDITION, demo: process.env.SCGF_DEMO };
const M = 'SF22018834';

const cart = (sub: string): ScgfProviderCart => ({ vatMode: 'inc', lines: [], totals: { gross: sub, lineDiscount: '0.00', sub, shopBillDiscount: '0.00' } });
/** p1 retail 145.00 inc VAT. */
const webCart = (qty: string, billDiscount = '0') => ({ vatMode: 'inc', billDiscount, lines: [{ productId: env.seed.products.p1!, qty, unitPrice: '145.00' }] });

beforeAll(async () => {
  process.env.EDITION = 'cloud'; // what the bundler bakes in: cloud-only routes register only then
  process.env.SCGF_DEMO = '1';
  env = await setupEnv({ edition: 'cloud' });
  prae = await login(env.app, 'prae');
  owner = await login(env.app, 'charoen');
  shift = await openShift(prae);
});
afterAll(async () => {
  await env.close();
  for (const [k, v] of [['EDITION', prev.edition], ['SCGF_DEMO', prev.demo]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('providers', () => {
  it('stub (default): no coupons, cannot reserve', async () => {
    expect((await stubProvider.evaluateCoupons('S', M, cart('20000.00'))).coupons).toEqual([]);
    await expect(stubProvider.reserve('S', M, 'SFC-100-1K', cart('20000.00'))).rejects.toMatchObject({ code: 'COUPON_NOT_ELIGIBLE' });
  });

  it('demo: eligible and under-minimum coupons, both kinds, limited and unlimited; other-shop coupons never offered', async () => {
    const { coupons } = await demoProvider.evaluateCoupons('S', M, cart('2900.00'));
    expect(coupons).toHaveLength(6);
    expect(coupons.map((c) => c.code)).not.toContain('SFC-OTHER');
    const by = Object.fromEntries(coupons.map((c) => [c.code, c]));
    expect(by['SFC-100-1K']).toMatchObject({ eligible: true, discountAmount: '100.00', kind: 'promotion', usage: { used: 8, limit: 100 } });
    expect(by['SFC-5PCT']).toMatchObject({ eligible: true, discountAmount: '145.00' });
    expect(by['SFC-300-15K']).toMatchObject({ eligible: false, discountAmount: '0.00', usage: null, ineligibleReason: 'ยอดสินค้า ฿2,900 ยังไม่ถึงขั้นต่ำ ฿15,000' });
    expect(by['SCC-50']).toMatchObject({ eligible: true, kind: 'cash_card' });
    expect(by['SCC-500']).toMatchObject({ eligible: false, kind: 'cash_card' });
    expect((await demoProvider.evaluateCoupons('S', 'SF10000001', cart('2900.00'))).coupons).toEqual([]);
  });
});

describe('routes', () => {
  it('stub when SCGF_DEMO is off: empty list', async () => {
    process.env.SCGF_DEMO = '0';
    try {
      const r = await prae.post('/api/scgf/coupons/evaluate', { memberId: M, cart: webCart('20') });
      expect(r.status).toBe(200);
      expect(r.body.coupons).toEqual([]);
    } finally {
      process.env.SCGF_DEMO = '1';
    }
  });

  it('member lookup by id / phone, unknown → 404; link to a customer', async () => {
    expect((await prae.post('/api/scgf/members/lookup', { by: 'sf_id', value: 'sf22018834' })).body).toMatchObject({ memberId: M, tier: 'Gold' });
    expect((await prae.post('/api/scgf/members/lookup', { by: 'phone', value: '081-234-5678' })).body.memberId).toBe(M);
    expect((await prae.post('/api/scgf/members/lookup', { by: 'sf_id', value: 'SF99999999' })).status).toBe(404);
    const c3 = env.seed.customers.c3!;
    expect((await prae.get(`/api/scgf/customers/${c3}/member`)).body.memberId).toBeNull();
    expect((await prae.patch(`/api/scgf/customers/${c3}/member`, { memberId: 'SF99999999' })).status).toBe(404);
    expect((await prae.patch(`/api/scgf/customers/${c3}/member`, { memberId: M })).body.memberId).toBe(M);
    expect((await prae.get(`/api/scgf/customers/${c3}/member`)).body.memberId).toBe(M);
  });

  it('evaluate prices the cart server-side; reserve refuses an ineligible coupon', async () => {
    const r = await prae.post('/api/scgf/coupons/evaluate', { memberId: M, cart: webCart('20') }); // 2,900
    expect(r.body.coupons.find((c: { code: string }) => c.code === 'SFC-300-15K')).toMatchObject({ eligible: false });
    const bad = await prae.post('/api/scgf/coupons/reserve', { memberId: M, code: 'SFC-300-15K', cart: webCart('20') });
    expect(bad.status).toBe(409);
    expect(bad.body.details.reason).toBe('COUPON_NOT_ELIGIBLE');
  });
});

describe('POS bill with a coupon', () => {
  const reserve = async (code: string, qty: string) => {
    const r = await prae.post('/api/scgf/coupons/reserve', { memberId: M, code, cart: webCart(qty) });
    expect(r.status).toBe(201);
    return r.body as { reservationId: string; discountAmount: string };
  };

  it('server applies the provider value: separate from shop discounts, no approval or reason, stored and redeemed', async () => {
    const rsv = await reserve('SFC-100-1K', '10'); // 1,450 → 100
    const coupon = { memberId: M, code: 'SFC-100-1K', reservationId: rsv.reservationId, amount: rsv.discountAmount };
    // cashier (discount cap 0): a coupon is not a manual discount
    const r = await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p1', qty: '10', price: '145.00' }], '1350.00', { coupon }));
    expect(r.status).toBe(201);
    expect(r.body.totals).toMatchObject({ gross: '1450.00', lineDisc: '0.00', billDisc: '0.00', total: '1350.00' });
    expect(r.body.coupon).toMatchObject({ code: 'SFC-100-1K', amount: '100.00', memberId: M, reservationId: rsv.reservationId, status: 'redeemed' });
    expect(r.body.coupon.redemptionId).toMatch(/^rdm_demo\./);
    const row = (await env.pool.query(`select coupon_amount::text, member_id, disc_reason from docs where no = $1`, [r.body.no])).rows[0];
    expect(row).toEqual({ coupon_amount: '100.00', member_id: M, disc_reason: null });
  });

  it('never trusts the client amount: a changed value is a 409 and nothing is written', async () => {
    const rsv = await reserve('SFC-5PCT', '20'); // 5% of 2,900 = 145
    const before = (await env.pool.query(`select count(*)::int n from docs`)).rows[0].n;
    const r = await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p1', qty: '20', price: '145.00' }], '2700.00',
      { coupon: { memberId: M, code: 'SFC-5PCT', reservationId: rsv.reservationId, amount: '200.00' } }));
    expect(r.status).toBe(409);
    expect(r.body.details).toMatchObject({ reason: 'COUPON_AMOUNT_CHANGED', newAmount: '145.00' });
    expect((await env.pool.query(`select count(*)::int n from docs`)).rows[0].n).toBe(before);
  });

  it('a cart under the coupon minimum is refused at save', async () => {
    const rsv = await reserve('SFC-100-1K', '10');
    const r = await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p1', qty: '2', price: '145.00' }], '190.00',
      { coupon: { memberId: M, code: 'SFC-100-1K', reservationId: rsv.reservationId, amount: '100.00' } }));
    expect(r.status).toBe(409);
    expect(r.body.details.reason).toBe('COUPON_NOT_ELIGIBLE');
  });

  it('void reverses the redemption', async () => {
    const rsv = await reserve('SCC-50', '1');
    const s = await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p1', qty: '1', price: '145.00' }], '95.00',
      { coupon: { memberId: M, code: 'SCC-50', reservationId: rsv.reservationId, amount: '50.00' } }));
    expect(s.status).toBe(201);
    const v = await owner.post(`/api/sales/docs/${s.body.no}/void`, { reason: 'ออกผิด' });
    expect(v.status).toBe(200);
    expect(v.body.coupon.status).toBe('reversed');
  });
});

describe('sales order with a coupon', () => {
  it('the order total is after the provider value, coupon stored on the order', async () => {
    const price = (await owner.get(`/api/sales/price?customerId=${env.seed.customers.c3}&productId=${env.seed.products.p1}&qty=20&vatMode=inc`)).body.unitPrice as string;
    const cartIn = { vatMode: 'inc', billDiscount: '0', lines: [{ productId: env.seed.products.p1!, qty: '20', unitPrice: price }] };
    const rsv = (await owner.post('/api/scgf/coupons/reserve', { memberId: M, code: 'SFC-100-1K', cart: cartIn })).body;
    const r = await owner.post('/api/sales/orders', {
      customerId: env.seed.customers.c3, vatMode: 'inc', lines: [{ productId: env.seed.products.p1, qty: '20', unitPrice: price }],
      coupon: { memberId: M, code: 'SFC-100-1K', reservationId: rsv.reservationId, amount: '100.00' },
    });
    expect(r.status).toBe(201);
    expect(r.body.coupon).toMatchObject({ code: 'SFC-100-1K', amount: '100.00', status: 'redeemed' });
    expect(r.body.totals.billDisc).toBe('0.00');
    expect(r.body.totals.total).toBe((Number(price) * 20 - 100).toFixed(2));
  });
});

describe('on-prem', () => {
  it('routes are not registered and a coupon on a bill is ignored', async () => {
    process.env.EDITION = 'onprem';
    const app = await buildApp({ pool: env.pool, edition: 'onprem', jwtSecret: 'test-secret', today: () => TODAY });
    try {
      const login1 = await client(app).post('/api/auth/login', { username: 'prae', password: '1234' });
      const c = client(app, login1.body.token);
      expect((await c.post('/api/scgf/coupons/evaluate', { memberId: M, cart: webCart('20') })).status).toBe(404);
      expect((await c.get(`/api/scgf/customers/${env.seed.customers.c3}/member`)).status).toBe(404);
      expect((await c.get('/api/meta')).body.capabilities).toEqual({});
    } finally {
      await app.close();
      process.env.EDITION = 'cloud';
    }
  });
});
