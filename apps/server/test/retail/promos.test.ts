/** M15 promotions: create / clash / below-cost confirmation, POS auto price, close early, bundles (BR-17), P&L. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, lotsOf, openShift, saleBody, setupEnv, stockQty, type Client, type Env } from '../helpers';
import { seedRetail, type RetailSeed } from '../../../../packages/db/src/seedRetail';

let env: Env;
let rs: RetailSeed;
let owner: Client;
let suda: Client;
let prae: Client;
let praeShift: string;

beforeAll(async () => {
  env = await setupEnv();
  rs = await seedRetail(env.pool, env.seed.tenantId);
  owner = await login(env.app, 'charoen');
  suda = await login(env.app, 'suda');
  prae = await login(env.app, 'prae');
  praeShift = await openShift(prae, '1000.00', 'POS-01');
});
afterAll(async () => { await env.close(); });

const P = (k: string) => env.seed.products[k]!;
const WH1 = () => env.seed.warehouses.WH1!;
const sell = (c: Client, shift: string, lines: Parameters<typeof saleBody>[2], total: string, extra: Record<string, unknown> = {}) =>
  c.post('/api/sales/pos', saleBody(env.seed, shift, lines, total, extra));

describe('promo list and state (REQ-M15-01)', () => {
  it('lists seeded promos newest first with user-visible state; cashier reads, cannot create', async () => {
    const r = await prae.get('/api/promos?limit=20');
    expect(r.status).toBe(200);
    expect(r.body.items.map((p: { state: string; name: string }) => [p.state, p.name.split(' ')[0]])).toEqual([
      ['live', 'ชุดก่อผนัง:'], ['live', 'ปูนตราเสือ'], ['expired', 'สีรองพื้น'],
    ]);
    const bundle = r.body.items[0];
    expect(bundle).toMatchObject({ kind: 'bundle', setPrice: '2550.00', normalSetPrice: '2690.00', sku: 'BD-WALL100', setsAvailable: 3 });
    expect(bundle.lines.every((l: { unitCost: string | null }) => l.unitCost === null)).toBe(true); // no data.cost
    const live = await prae.get('/api/promos?state=live&q=ปูน');
    expect(live.body.items).toHaveLength(2);
    const denied = await prae.post('/api/promos', { name: 'x', kind: 'disc', mode: 'pct', value: '5', items: [{ productId: P('p2') }], start: '2026-10-26', end: '2026-10-31' });
    expect(denied.status).toBe(403);
  });

  it('pages with a cursor', async () => {
    const a = await owner.get('/api/promos?limit=2');
    expect(a.body.items).toHaveLength(2);
    const b = await owner.get(`/api/promos?limit=2&cursor=${a.body.nextCursor}`);
    expect(b.body.items).toHaveLength(1);
    expect(b.body.nextCursor).toBeNull();
  });
});

describe('create promo: validation, clash, below cost (REQ-M15-01/03)', () => {
  it('rejects a product already in an overlapping active discount promo', async () => {
    const r = await owner.post('/api/promos', { name: 'ปูนลด 3%', kind: 'disc', mode: 'pct', value: '3', items: [{ productId: P('p1') }], start: '2026-11-01', end: '2026-11-30' });
    expect(r.status).toBe(409);
    expect(r.body.details.clashes[0].name).toContain('ปูนตราเสือ');
    // A draft may overlap (it is not applied); it is checked again when activated.
    const draft = await owner.post('/api/promos', { name: 'ปูนลด 3%', kind: 'disc', mode: 'pct', value: '3', items: [{ productId: P('p1') }], start: '2026-11-01', end: '2026-11-30', draft: true });
    expect(draft.status).toBe(201);
    expect(draft.body.state).toBe('draft');
    const act = await owner.post(`/api/promos/${draft.body.id}/activate`, {});
    expect(act.status).toBe(409);
  });

  it('validates dates, percent and bundles', async () => {
    const bad = [
      { name: 'a', kind: 'disc', mode: 'pct', value: '120', items: [{ productId: P('p2') }], start: '2026-10-26', end: '2026-10-31' },
      { name: 'b', kind: 'disc', mode: 'pct', value: '5', items: [{ productId: P('p2') }], start: '2026-10-31', end: '2026-10-26' },
      { name: 'c', kind: 'bundle', setPrice: '100', items: [{ productId: P('p2'), qtyPerSet: '1' }], start: '2026-10-26', end: '2026-10-31' },
      { name: 'd', kind: 'disc', mode: 'pct', value: '5', items: [{ productId: P('p2') }, { productId: P('p2') }], start: '2026-10-26', end: '2026-10-31' },
    ];
    for (const b of bad) expect((await owner.post('/api/promos', b)).status).toBe(400);
  });

  it('a below-cost promo needs the owner: manager gets BELOW_COST, manager PIN is refused, owner PIN confirms', async () => {
    // PVC: oldest WH1 lot 68.87; promo price 70 incl. VAT = 65.42 before VAT.
    const body = { name: 'ท่อ PVC ล้างสต็อก', kind: 'disc', mode: 'fixed', value: '70', items: [{ productId: P('p6') }], start: '2026-10-26', end: '2026-11-30' };
    const check = await suda.post('/api/promos/check', body);
    expect(check.status).toBe(200);
    expect(check.body.lines[0]).toMatchObject({ promoPrice: '70.00', unitCost: '68.87', belowCost: true });

    const r1 = await suda.post('/api/promos', body);
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe('BELOW_COST');
    const r2 = await suda.post('/api/promos', { ...body, belowCostApproval: { approverUserId: env.seed.users.suda, pin: '1234' } });
    expect(r2.status).toBe(409); // not the owner (and no self-approval)
    const r3 = await suda.post('/api/promos', { ...body, belowCostApproval: { approverUserId: env.seed.users.charoen, pin: '1234' } });
    expect(r3.status).toBe(201);
    expect(r3.body).toMatchObject({ belowCost: true, belowCostBy: 'คุณเจริญ ศรีสุข', state: 'live', createdBy: 'คุณสุดา ศรีสุข' });
    const log = await env.pool.query(`select action, object, detail from audit_log where tenant_id = $1 and object in ('below-cost','promotion') order by chain_seq desc limit 2`, [env.seed.tenantId]);
    expect(log.rows.map((x) => x.object).sort()).toEqual(['below-cost', 'promotion']);
  });

  it('the POS sells the confirmed below-cost promo without asking again (REQ-M15-03)', async () => {
    const r = await sell(prae, praeShift, [{ p: 'p6', qty: '2', price: '70.00' }], '140.00');
    expect(r.status).toBe(201);
    expect(r.body.lines[0]).toMatchObject({ priceSource: 'promo', listPrice: '89', promo: { name: 'ท่อ PVC ล้างสต็อก' } });
  });
});

describe('POS applies live promos (REQ-M15-03)', () => {
  it('GET /api/pos/pricing lists live POS promos and bundles only', async () => {
    const r = await prae.get('/api/pos/pricing');
    expect(r.status).toBe(200);
    expect(r.body.promos.map((p: { name: string }) => p.name).sort()).toEqual(['ท่อ PVC ล้างสต็อก', 'ปูนตราเสือ ลด 5 บาท/ถุง ต้อนรับหน้าแล้ง']);
    expect(r.body.bundles).toHaveLength(1);
    expect(r.body.bundles[0]).toMatchObject({ setPrice: '2550.00', setsAvailable: 3 });
  });

  it('a promo-priced line needs no price approval and records the promo; a stale promo id is rejected', async () => {
    const r = await sell(prae, praeShift, [{ p: 'p1', qty: '2', price: '140.00' }], '280.00', {});
    expect(r.status).toBe(201);
    expect(r.body.lines[0]).toMatchObject({ unitPrice: '140', listPrice: '145', priceSource: 'promo', promo: { id: rs.promos.PR001 } });
    // Retail price is also accepted while the promo runs.
    expect((await sell(prae, praeShift, [{ p: 'p1', qty: '1', price: '145.00' }], '145.00')).status).toBe(201);
  });

  it('closing early stops the promo for new bills at once; issued bills keep their snapshot (REQ-M15-04)', async () => {
    const before = await sell(prae, praeShift, [{ p: 'p1', qty: '1', price: '140.00' }], '140.00');
    expect(before.status).toBe(201);
    const c = await owner.post(`/api/promos/${rs.promos.PR001}/close`, { reason: 'ของหมด' });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: 'closed', state: 'closed', closedBy: 'คุณเจริญ ศรีสุข' });
    expect((await owner.post(`/api/promos/${rs.promos.PR001}/close`, {})).status).toBe(409);

    const stale = await prae.post('/api/sales/pos', {
      ...saleBody(env.seed, praeShift, [{ p: 'p1', qty: '1', price: '140.00' }], '140.00'),
      lines: [{ productId: P('p1'), unitIdx: 0, qty: '1', unitPrice: '140.00', promoId: rs.promos.PR001 }],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.details.reason).toBe('PROMO_ENDED');
    const after = await sell(prae, praeShift, [{ p: 'p1', qty: '1', price: '140.00' }], '140.00');
    expect(after.status).toBe(403); // now a price change for a cashier
    expect(after.body.details.need).toBe('discountApproval');

    const old = await prae.get(`/api/sales/docs/${before.body.no}`);
    expect(old.body.lines[0]).toMatchObject({ unitPrice: '140', promo: { id: rs.promos.PR001 } });
  });

  it('a b2b-only promo is not applied at the POS', async () => {
    const r = await owner.post('/api/promos', { name: 'กาวซีเมนต์ ราคาโครงการ', kind: 'disc', mode: 'amt', value: '10', channels: ['b2b'], items: [{ productId: P('p4') }], start: '2026-10-26', end: '2026-11-30' });
    expect(r.status).toBe(201);
    const pr = await prae.get('/api/pos/pricing');
    expect(pr.body.promos.some((p: { id: string }) => p.id === r.body.id)).toBe(false);
    const res = await owner.get(`/api/price-lists/resolve?productId=${P('p4')}&channel=b2b`);
    expect(res.body).toMatchObject({ unitPrice: '200.00', source: 'promo' });
  });
});

describe('bundle sale (REQ-M15-02, BR-17)', () => {
  it('cuts every component FIFO and splits the set revenue pro-rata to normal price, remainder on the last line', async () => {
    const p3Before = await stockQty(env.pool, P('p3'), WH1());
    const p1Before = await stockQty(env.pool, P('p1'), WH1());
    const body = { ...saleBody(env.seed, praeShift, [], '5100.00'), lines: [], bundles: [{ promoId: rs.promos.PR002, sets: '2' }] };
    const r = await prae.post('/api/sales/pos', body);
    expect(r.status).toBe(201);
    expect(r.body.totals.total).toBe('5100.00');
    const [a, b] = r.body.lines;
    // normal 100 × 24 = 2400 and 2 × 145 = 290 → 2400 / 2690 × 5100 = 4550.19; remainder 549.81 on the last line.
    expect(a).toMatchObject({ productId: P('p3'), qty: '200', net: '4550.19', priceSource: 'bundle', bundle: { no: 1, sets: '2', qtyPerSet: '100', setPrice: '2550.00' } });
    expect(b).toMatchObject({ productId: P('p1'), qty: '4', net: '549.81', bundle: { no: 1, qtyPerSet: '2' } });
    expect(await stockQty(env.pool, P('p3'), WH1())).toBe(p3Before - 200);
    expect(await stockQty(env.pool, P('p1'), WH1())).toBe(p1Before - 4);
    const asOwner = await owner.get(`/api/sales/docs/${r.body.no}`);
    // 120 @ 18.915 → 18.92 per lot price (2 dp) then 80 @ 19.89
    const p3Lots = await lotsOf(env.pool, P('p3'), WH1());
    expect(p3Lots[0]!.remaining).toBe('0.0000');
    expect(Number(asOwner.body.lines[0].cogs)).toBeGreaterThan(0);
    expect(Number(asOwner.body.lines[1].cogs)).toBeGreaterThan(0);
  });

  it('a set that the stock cannot make is refused (BR-07) and nothing is written', async () => {
    const before = await stockQty(env.pool, P('p1'), WH1());
    const body = { ...saleBody(env.seed, praeShift, [], '2550.00'), lines: [], bundles: [{ promoId: rs.promos.PR002, sets: '1' }] };
    const r = await prae.post('/api/sales/pos', body); // only 100 อิฐ left? → 300 − 200 = 100 → 1 set possible
    expect(r.status).toBe(201);
    const r2 = await prae.post('/api/sales/pos', { ...body, idempotencyKey: crypto.randomUUID() });
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('INSUFFICIENT_STOCK');
    expect(await stockQty(env.pool, P('p1'), WH1())).toBe(before - 2);
  });

  it('rejects fractional sets and a bundle that is no longer live', async () => {
    const body = { ...saleBody(env.seed, praeShift, [], '1275.00'), lines: [], bundles: [{ promoId: rs.promos.PR002, sets: '0.5' }] };
    expect((await prae.post('/api/sales/pos', body)).status).toBe(400);
    const expired = { ...saleBody(env.seed, praeShift, [], '100.00'), lines: [], bundles: [{ promoId: rs.promos.PR000, sets: '1' }] };
    const r = await prae.post('/api/sales/pos', expired);
    expect(r.status).toBe(409);
    expect(r.body.details.reason).toBe('PROMO_ENDED');
  });

  it('bundle components are returned as whole sets only', async () => {
    // Restock bricks so a fresh bundle bill can be made, then return.
    await env.pool.query(`insert into stock_lots (tenant_id, product_id, warehouse_id, received_at, qty_in, remaining, unit_cost, ref) values ($1,$2,$3,now(),500,500,20,'TEST')`, [env.seed.tenantId, P('p3'), WH1()]);
    await env.pool.query(`insert into stock_lots (tenant_id, product_id, warehouse_id, received_at, qty_in, remaining, unit_cost, ref) values ($1,$2,$3,now(),50,50,120,'TEST')`, [env.seed.tenantId, P('p1'), WH1()]);
    const sale = await prae.post('/api/sales/pos', { ...saleBody(env.seed, praeShift, [], '5100.00'), lines: [], bundles: [{ promoId: rs.promos.PR002, sets: '2' }] });
    expect(sale.status).toBe(201);
    const [a, b] = sale.body.lines;
    const ret = (lines: { lineId: string; qty: string }[]) => suda.post('/api/returns', { sourceDocNo: sale.body.no, lines, condition: 'good', refund: 'cash', reason: 'ลูกค้าเปลี่ยนใจ' });
    const partial = await ret([{ lineId: a.id, qty: '100' }]);
    expect(partial.status).toBe(400);
    const uneven = await ret([{ lineId: a.id, qty: '100' }, { lineId: b.id, qty: '4' }]);
    expect(uneven.status).toBe(400);
    await openShift(suda, '500.00', 'POS-02');
    const one = await ret([{ lineId: a.id, qty: '100' }, { lineId: b.id, qty: '2' }]);
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    expect(one.body.totals.total).toBe('2550.00');
  });
});

describe('bundle and a normal line of the same product in one bill', () => {
  it('plans FIFO across both lines and audits the bill with the promo name', async () => {
    const before = await stockQty(env.pool, P('p1'), WH1());
    const r = await prae.post('/api/sales/pos', {
      ...saleBody(env.seed, praeShift, [{ p: 'p1', qty: '2', price: '145.00' }], '2840.00'), bundles: [{ promoId: rs.promos.PR002, sets: '1' }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.lines.map((l: { priceSource?: string }) => l.priceSource ?? null)).toEqual([null, 'bundle', 'bundle']);
    expect(await stockQty(env.pool, P('p1'), WH1())).toBe(before - 4);
    const log = await env.pool.query(`select detail from audit_log where tenant_id = $1 and ref = $2`, [env.seed.tenantId, r.body.no]);
    expect(log.rows[0].detail).toContain('โปร ชุดก่อผนัง');
  });
});

describe('promo P&L data (REQ-M15-05 / REQ-M11-07)', () => {
  it('sums sales, discount, COGS and gross profit per promo; cost hidden without data.cost', async () => {
    const r = await owner.get(`/api/promos/pnl?promoId=${rs.promos.PR002}`);
    expect(r.status).toBe(200);
    const row = r.body.items[0];
    expect(row).toMatchObject({ code: expect.stringMatching(/^PR/), kind: 'bundle' });
    // Bills: 2 + 1 + 2 + 1 sets, one set returned → 5 sets, ฿12,750 net.
    expect(row.sets).toBe('5');
    expect(row.sales).toBe('12750.00');
    expect(Number(row.cogs)).toBeGreaterThan(0);
    expect(row.grossProfit).toBe((Number(row.salesExVat) - Number(row.cogs)).toFixed(2));
    const asSales = await (await login(env.app, 'boy')).get(`/api/promos/pnl?promoId=${rs.promos.PR002}`);
    expect(asSales.status).toBe(200);
    expect(asSales.body.items[0].cogs).toBeNull();
    expect((await (await login(env.app, 'chai')).get('/api/promos/pnl')).status).toBe(403);
  });
});

describe('tenant isolation (BR-14)', () => {
  it("another shop sees none of this shop's promos", async () => {
    const { seedMinimalTenant } = await import('@erp/db');
    await seedMinimalTenant(env.pool, 'other', 'ร้านอื่น');
    const r = await env.pool.query(`select count(*)::int n from retail_promos where tenant_id = $1`, [env.seed.tenantId]);
    expect(r.rows[0].n).toBeGreaterThan(0);
    const other = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner', password: '1234', tenant: 'other' } });
    expect(other.statusCode).toBe(200);
    const token = JSON.parse(other.body).token as string;
    for (const url of ['/api/promos', '/api/price-lists', '/api/pos-devices', '/api/boms', '/api/mos']) {
      const list = await env.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
      expect(JSON.parse(list.body).items, url).toEqual([]);
    }
    const one = await env.app.inject({ method: 'GET', url: `/api/promos/${rs.promos.PR002}`, headers: { authorization: `Bearer ${token}` } });
    expect(one.statusCode).toBe(404);
  });
});
