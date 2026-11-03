/** POS extras: POS machines / POS ID (REQ-M01-07), held bills (REQ-M07-08), price lists at the POS (BR-05, REQ-M03-07), product images (REQ-M07-11). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, openShift, saleBody, setupEnv, stockQty, type Client, type Env } from '../helpers';
import { seedRetail } from '../../../../packages/db/src/seedRetail';

let env: Env;
let owner: Client;
let suda: Client;
let prae: Client;
let praeShift: string;
let praeShift9: string;

beforeAll(async () => {
  env = await setupEnv();
  owner = await login(env.app, 'charoen');
  suda = await login(env.app, 'suda');
  prae = await login(env.app, 'prae');
  praeShift = await openShift(prae, '1000.00', 'POS-01');
});
afterAll(async () => { await env.close(); });

const P = (k: string) => env.seed.products[k]!;
const C = (k: string) => env.seed.customers[k]!;
const sell = (shift: string, lines: Parameters<typeof saleBody>[2], total: string, extra: Record<string, unknown> = {}) =>
  prae.post('/api/sales/pos', saleBody(env.seed, shift, lines, total, extra));

describe('POS machines and POS ID (REQ-M01-07)', () => {
  it('without a registry the shop keeps issuing ABB on any machine', async () => {
    expect((await sell(praeShift, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00')).status).toBe(201);
  });

  it('only sys.settings registers machines; an approved machine needs its POS ID and approval date', async () => {
    const body = { code: 'POS-01', name: 'แท็บเล็ตแคชเชียร์ 1', rdPosId: 'E061234567890123', approvedOn: '2026-01-15', status: 'approved' };
    expect((await suda.post('/api/pos-devices', body)).status).toBe(403);
    expect((await owner.post('/api/pos-devices', { ...body, rdPosId: null })).status).toBe(400);
    expect((await owner.post('/api/pos-devices', { ...body, rdPosId: 'ab' })).status).toBe(400);
    const r = await owner.post('/api/pos-devices', body);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ code: 'POS-01', status: 'approved', canIssueAbb: true });
    expect((await owner.post('/api/pos-devices', body)).status).toBe(409);
    const p2 = await owner.post('/api/pos-devices', { code: 'POS-02', name: 'แท็บเล็ตหน้าโกดัง' });
    expect(p2.body).toMatchObject({ status: 'pending', canIssueAbb: false, rdPosId: null });
    const list = await prae.get('/api/pos-devices');
    expect(list.status).toBe(200);
    expect(list.body.items.map((x: { code: string }) => x.code)).toEqual(['POS-01', 'POS-02']);
  });

  it('a machine without an approved POS ID issues full tax invoices only; ABB prints the POS ID', async () => {
    const prae9 = await login(env.app, 'boy');
    praeShift9 = await openShift(prae9, '0.00', 'POS-02');
    const abb = await prae9.post('/api/sales/pos', saleBody(env.seed, praeShift9, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00'));
    expect(abb.status).toBe(400);
    expect(abb.body.details).toMatchObject({ reason: 'POS_ID_REQUIRED', device: 'POS-02', status: 'pending' });
    const full = await prae9.post('/api/sales/pos', saleBody(env.seed, praeShift9, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00', { docKind: 'full', customerId: C('c1') }));
    expect(full.status).toBe(201);
    expect(full.body.type).toBe('INV');
    expect(full.body.posId).toBeUndefined();
    const ok = await sell(praeShift, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00');
    expect(ok.status).toBe(201);
    expect(ok.body.posId).toBe('E061234567890123');
  });

  it('approving / retiring a machine changes what it may issue, with an audited before → after', async () => {
    const list = await owner.get('/api/pos-devices?q=POS-02');
    const id = list.body.items[0].id;
    expect((await owner.patch(`/api/pos-devices/${id}`, { status: 'approved' })).status).toBe(400);
    const r = await owner.patch(`/api/pos-devices/${id}`, { status: 'approved', rdPosId: 'E061234567890999', approvedOn: '2026-10-25' });
    expect(r.body.canIssueAbb).toBe(true);
    const boy = await login(env.app, 'boy');
    expect((await boy.post('/api/sales/pos', saleBody(env.seed, praeShift9, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00'))).status).toBe(201);
    await owner.patch(`/api/pos-devices/${id}`, { status: 'retired' });
    expect((await boy.post('/api/sales/pos', saleBody(env.seed, praeShift9, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00'))).status).toBe(400);
    const log = await env.pool.query(`select detail from audit_log where tenant_id = $1 and object = 'pos-device' and action = 'update' order by chain_seq`, [env.seed.tenantId]);
    expect(log.rows[0].detail).toContain('สถานะ: รออนุมัติ → อนุมัติแล้ว');
  });
});

describe('held bills (REQ-M07-08)', () => {
  const cart = (n: string) => ({ lines: [{ productId: P('p1'), unitIdx: 0, qty: n, dval: '', dmode: 'amt' }], bundles: [], billDiscount: '', customerId: null });

  it('holds several bills per shift without touching stock, lists them, resumes and discards each once', async () => {
    const before = await stockQty(env.pool, P('p1'), env.seed.warehouses.WH1!);
    const a = await prae.post('/api/pos/held', { shiftId: praeShift, cart: cart('3'), total: '435.00' });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ label: 'บิลพัก 1', itemCount: 1, total: '435.00', status: 'held' });
    const b = await prae.post('/api/pos/held', { shiftId: praeShift, label: 'ลูกค้ารอรถ', cart: { ...cart('5'), customerId: C('c3') }, total: '725.00' });
    expect(b.body).toMatchObject({ label: 'ลูกค้ารอรถ', customer: 'คุณสมศรี ทองดี' });
    expect(await stockQty(env.pool, P('p1'), env.seed.warehouses.WH1!)).toBe(before);
    expect((await prae.post('/api/pos/held', { shiftId: praeShift, cart: { lines: [], bundles: [] }, total: '0' })).status).toBe(400);

    const list = await prae.get('/api/pos/held');
    expect(list.body.items.map((x: { label: string }) => x.label)).toEqual(['บิลพัก 1', 'ลูกค้ารอรถ']);
    const r = await prae.post(`/api/pos/held/${a.body.id}/resume`);
    expect(r.status).toBe(200);
    expect(r.body.cart.lines[0].qty).toBe('3');
    expect((await prae.post(`/api/pos/held/${a.body.id}/resume`)).status).toBe(409);
    // Another cashier's shift cannot take it.
    await openShift(suda, '0.00', 'POS-01');
    expect((await suda.post(`/api/pos/held/${b.body.id}/resume`)).status).toBe(403);
    expect((await prae.post(`/api/pos/held/${b.body.id}/discard`)).status).toBe(200);
    expect((await prae.get('/api/pos/held')).body.items).toEqual([]);
    const log = await env.pool.query<{ action: string }>(`select action from audit_log where tenant_id = $1 and object = 'pos-bill' order by chain_seq`, [env.seed.tenantId]);
    expect(log.rows.map((x) => x.action)).toEqual(['hold', 'hold', 'resume', 'discard']);
  });

  it(`caps held bills per shift`, async () => {
    for (let i = 0; i < 10; i++) expect((await prae.post('/api/pos/held', { shiftId: praeShift, cart: cart('1'), total: '145.00' })).status).toBe(201);
    const over = await prae.post('/api/pos/held', { shiftId: praeShift, cart: cart('1'), total: '145.00' });
    expect(over.status).toBe(409);
    const page1 = await prae.get('/api/pos/held?limit=4');
    expect(page1.body.items).toHaveLength(4);
    expect(page1.body.nextCursor).toBeTruthy();
    for (const h of (await prae.get('/api/pos/held?limit=20')).body.items) await prae.post(`/api/pos/held/${h.id}/discard`);
  });
});

describe('price lists at the POS (BR-05, REQ-M03-07)', () => {
  let contrId = '';

  it('creates group and customer lists; only data.master may edit', async () => {
    const body = {
      name: 'ราคาผู้รับเหมา', customerGroup: 'contr', vatIncluded: true, validFrom: '2026-10-01', validTo: '2026-12-31',
      items: [{ productId: P('p1'), minQty: '10', price: '140.00' }, { productId: P('p1'), minQty: '40', price: '138.00' }],
    };
    expect((await prae.post('/api/price-lists', body)).status).toBe(403);
    expect((await owner.post('/api/price-lists', { ...body, customerId: C('c1') })).status).toBe(400);
    expect((await owner.post('/api/price-lists', { ...body, customerGroup: null })).status).toBe(400);
    expect((await owner.post('/api/price-lists', { ...body, items: [{ productId: P('p4'), unitIdx: 3, price: '1' }] })).status).toBe(400);
    const r = await owner.post('/api/price-lists', body);
    expect(r.status).toBe(201);
    contrId = r.body.id;
    expect(r.body.items.map((i: { minQty: string; price: string; retailPrice: string }) => [i.minQty, i.price, i.retailPrice])).toEqual([['10', '140.00', '145.00'], ['40', '138.00', '145.00']]);
    const own = await owner.post('/api/price-lists', { name: 'ราคาพิเศษ คุณสมศรี', customerId: C('c3'), vatIncluded: false, items: [{ productId: P('p4'), price: '190.00' }] });
    expect(own.status).toBe(201);
    expect(own.body.customer.name).toBe('คุณสมศรี ทองดี');
    const list = await owner.get('/api/price-lists?q=สมศรี');
    expect(list.body.items).toHaveLength(1);
  });

  it('resolves the customer price: own list > group list by qty break > retail; ex-VAT lists convert', async () => {
    const res = (q: string) => owner.get(`/api/price-lists/resolve?${q}`).then((r) => r.body);
    expect(await res(`customerId=${C('c1')}&productId=${P('p1')}&qty=40`)).toMatchObject({ unitPrice: '138.00', source: 'group' });
    expect(await res(`customerId=${C('c1')}&productId=${P('p1')}&qty=12`)).toMatchObject({ unitPrice: '140.00', source: 'group' });
    expect(await res(`customerId=${C('c1')}&productId=${P('p1')}&qty=5`)).toMatchObject({ unitPrice: '145.00', source: 'retail' });
    expect(await res(`customerId=${C('c3')}&productId=${P('p4')}`)).toMatchObject({ unitPrice: '203.30', source: 'customer' }); // 190 × 1.07
    expect(await res(`productId=${P('p4')}`)).toMatchObject({ unitPrice: '210.00', source: 'retail' });
    const pricing = await prae.get(`/api/pos/pricing?customerId=${C('c1')}`);
    expect(pricing.body.customer).toMatchObject({ name: 'หจก. รุ่งเรืองก่อสร้าง', group: 'contr' });
    expect(pricing.body.prices.map((x: { minQty: string; price: string }) => [x.minQty, x.price])).toEqual([['10', '140.00'], ['40', '138.00']]);
  });

  it('a POS bill for the customer sells at the list price without a price approval; without the customer it needs one', async () => {
    const r = await sell(praeShift, [{ p: 'p1', qty: '40', price: '138.00' }], '5520.00', { customerId: C('c1') });
    expect(r.status).toBe(201);
    expect(r.body.lines[0]).toMatchObject({ priceSource: 'group', listPrice: '145' });
    const anon = await sell(praeShift, [{ p: 'p1', qty: '10', price: '140.00' }], '1400.00');
    expect(anon.status).toBe(403);
    expect(anon.body.details.need).toBe('discountApproval');
  });

  it('a deactivated or expired list stops applying', async () => {
    expect((await owner.patch(`/api/price-lists/${contrId}`, { active: false })).status).toBe(200);
    const res = await owner.get(`/api/price-lists/resolve?customerId=${C('c1')}&productId=${P('p1')}&qty=40`);
    expect(res.body.source).toBe('retail');
    await owner.patch(`/api/price-lists/${contrId}`, { active: true, validTo: '2026-10-25' });
    expect((await owner.get(`/api/price-lists/resolve?customerId=${C('c1')}&productId=${P('p1')}&qty=40`)).body.source).toBe('retail');
    const log = await env.pool.query(`select detail from audit_log where tenant_id = $1 and object = 'price-list' and action = 'update' order by chain_seq desc limit 1`, [env.seed.tenantId]);
    expect(log.rows[0].detail).toContain('ช่วง: 2026-10-01–2026-12-31 → 2026-10-01–2026-10-25');
  });
});

describe('product images (REQ-M07-11)', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64');
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString('base64');

  it('uploads an image for a shop product, bumps the version, serves it and lists it for the POS', async () => {
    expect((await prae.post(`/api/product-images/${P('p5')}`, { mime: 'image/png', data: PNG })).status).toBe(403);
    const r1 = await owner.post(`/api/product-images/${P('p5')}`, { mime: 'image/png', data: PNG });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ mime: 'image/png', version: 1 });
    const r2 = await owner.post(`/api/product-images/${P('p5')}`, { mime: 'image/jpeg', data: `data:image/jpeg;base64,${JPG}` });
    expect(r2.body.version).toBe(2);
    const img = await prae.get(`/api/product-images/${P('p5')}`);
    expect(img.body).toMatchObject({ mime: 'image/jpeg', data: JPG });
    expect((await prae.get('/api/pos/pricing')).body.images).toEqual({ [P('p5')]: 2 });
    expect((await prae.get('/api/product-images')).body.items).toHaveLength(1);
  });

  it('refuses SCG products, a type that does not match the bytes, and files over 256 KB', async () => {
    expect((await owner.post(`/api/product-images/${P('p1')}`, { mime: 'image/png', data: PNG })).status).toBe(400);
    expect((await owner.post(`/api/product-images/${P('p6')}`, { mime: 'image/jpeg', data: PNG })).status).toBe(400);
    expect((await owner.post(`/api/product-images/${P('p6')}`, { mime: 'image/png', data: Buffer.from('hello world').toString('base64') })).status).toBe(400);
    const big = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(262_200)]).toString('base64');
    expect((await owner.post(`/api/product-images/${P('p6')}`, { mime: 'image/png', data: big })).status).toBe(400);
  });

  it('removes an image (no delete: data cleared, version bumped)', async () => {
    expect((await owner.post(`/api/product-images/${P('p5')}/remove`)).status).toBe(200);
    expect((await prae.get(`/api/product-images/${P('p5')}`)).status).toBe(404);
    expect((await owner.post(`/api/product-images/${P('p5')}/remove`)).status).toBe(404);
  });
});

describe('seedRetail', () => {
  it('is idempotent', async () => {
    const count = async () => (await env.pool.query(
      `select (select count(*) from retail_promos) + (select count(*) from retail_boms) + (select count(*) from retail_price_lists)
            + (select count(*) from retail_price_list_items) + (select count(*) from retail_pos_devices) n`)).rows[0].n;
    const a = await seedRetail(env.pool, env.seed.tenantId);
    const n1 = await count();
    const b = await seedRetail(env.pool, env.seed.tenantId);
    expect(await count()).toBe(n1);
    expect(b).toEqual(a);
    // Numbering continues after the seeded promo codes (BR-04).
    const p = await owner.post('/api/promos', { name: 'ใหม่', kind: 'disc', mode: 'pct', value: '5', items: [{ productId: P('p2') }], start: '2026-10-26', end: '2026-10-31' });
    expect(p.body.code).toBe('PR2610-0003');
  });
});
