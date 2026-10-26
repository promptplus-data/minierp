/** M05/M06: transfer, issue (BR-07 rollback), receipt, adjustment request + approval, shift X/Z. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, lotsOf, openShift, saleBody, setupEnv, stockQty, type Client, type Env } from './helpers';

let env: Env;
let chai: Client;
let suda: Client;
let prae: Client;
const P = (k: string) => env.seed.products[k]!;
const W = (k: string) => env.seed.warehouses[k]!;

beforeAll(async () => {
  env = await setupEnv();
  chai = await login(env.app, 'chai');
  suda = await login(env.app, 'suda');
  prae = await login(env.app, 'prae');
});
afterAll(async () => { await env.close(); });

describe('transfer', () => {
  it('moves several lines WH2 → WH1 keeping lot dates and costs', async () => {
    const srcLots = await lotsOf(env.pool, P('p8'), W('WH2')); // 5 @ 504.40, 7 @ 530.40
    const r = await chai.post('/api/stock/transfers', {
      fromWarehouseId: W('WH2'), toWarehouseId: W('WH1'),
      lines: [{ productId: P('p8'), qty: '6' }, { productId: P('p10'), qty: '3' }], note: 'เติมหน้าร้าน',
    });
    expect(r.status).toBe(201);
    expect(r.body.no).toBe('TR2610-0001');
    expect(await stockQty(env.pool, P('p8'), W('WH1'))).toBe(6);
    expect(await stockQty(env.pool, P('p8'), W('WH2'))).toBe(6);
    expect(await stockQty(env.pool, P('p10'), W('WH1'))).toBe(3);
    const dest = await lotsOf(env.pool, P('p8'), W('WH1'));
    expect(dest.map((l) => [l.remaining, l.unit_cost])).toEqual([['5.0000', srcLots[0]!.unit_cost], ['1.0000', srcLots[1]!.unit_cost]]);
  });

  it('rolls back every line when one line is short', async () => {
    const before = await stockQty(env.pool, P('p8'), W('WH2'));
    const r = await chai.post('/api/stock/transfers', {
      fromWarehouseId: W('WH2'), toWarehouseId: W('WH1'),
      lines: [{ productId: P('p8'), qty: '2' }, { productId: P('p10'), qty: '100' }],
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('INSUFFICIENT_STOCK');
    expect(r.body.details).toEqual([{ productId: P('p10'), warehouseId: W('WH2'), need: '100', have: '5' }]);
    expect(await stockQty(env.pool, P('p8'), W('WH2'))).toBe(before);
  });

  it('rejects same source and destination', async () => {
    const r = await chai.post('/api/stock/transfers', { fromWarehouseId: W('WH1'), toWarehouseId: W('WH1'), lines: [{ productId: P('p1'), qty: '1' }] });
    expect(r.status).toBe(400);
  });
});

describe('issue', () => {
  it('issues several lines (pack unit converts to base) and rolls back on shortage', async () => {
    const ok = await chai.post('/api/stock/issues', { warehouseId: W('WH2'), lines: [{ productId: P('p6'), unitIdx: 1, qty: '1' }, { productId: P('p5'), qty: '10' }], reason: 'ใช้ซ่อมโกดัง' });
    expect(ok.status).toBe(201);
    expect(ok.body.type).toBe('ADJ');
    expect(await stockQty(env.pool, P('p6'), W('WH2'))).toBe(100); // 120 − 1 มัด (20)
    expect(await stockQty(env.pool, P('p5'), W('WH2'))).toBe(290);

    const short = await chai.post('/api/stock/issues', { warehouseId: W('WH2'), lines: [{ productId: P('p5'), qty: '10' }, { productId: P('p7'), qty: '5' }], reason: 'x' });
    expect(short.status).toBe(409);
    expect(await stockQty(env.pool, P('p5'), W('WH2'))).toBe(290);
  });

  it('cashier cannot issue stock', async () => {
    const r = await prae.post('/api/stock/issues', { warehouseId: W('WH2'), lines: [{ productId: P('p5'), qty: '1' }], reason: 'x' });
    expect(r.status).toBe(403);
  });

  it('services have no stock', async () => {
    const r = await chai.post('/api/stock/issues', { warehouseId: W('WH2'), lines: [{ productId: P('p9'), qty: '1' }], reason: 'x' });
    expect(r.status).toBe(400);
  });
});

describe('manual receipt (REQ-M05-06)', () => {
  it('creates a lot at net cost after bill discount and rejects a duplicate vendor invoice', async () => {
    const body = {
      vendorId: env.seed.vendors.v1, vendorInvoiceNo: 'IV-001', deliveryNo: 'DN-001', warehouseId: W('WH2'),
      lines: [{ productId: P('p1'), qty: '100', unitCost: '120.00' }, { productId: P('p6'), unitIdx: 1, qty: '1', unitCost: '1400.00' }], billDiscount: '134.00',
    };
    const r = await chai.post('/api/stock/receipts', body);
    expect(r.status).toBe(201);
    expect(r.body.no).toBe('GR2610-0001');
    // 12000 + 1400 = 13400; discount 1% each → p1 118.80 / bag, p6 1386 / 20 = 69.30 per เส้น
    expect(r.body.lines).toEqual([{ productId: P('p1'), qty: '100', unitCost: '118.8' }, { productId: P('p6'), qty: '20', unitCost: '69.3' }]);
    const dup = await chai.post('/api/stock/receipts', body);
    expect(dup.status).toBe(409);
  });
});

describe('adjustment request + approval', () => {
  it('request changes nothing; warehouse staff cannot approve; manager approval applies the deltas', async () => {
    const req = await chai.post('/api/stock/adjust-requests', {
      warehouseId: W('WH1'), lines: [{ productId: P('p4'), qtyDelta: '-4' }, { productId: P('p2'), qtyDelta: '10' }], reason: 'นับสต็อกประจำเดือน',
    });
    expect(req.status).toBe(201);
    expect(req.body.status).toBe('pending');
    expect(await stockQty(env.pool, P('p4'), W('WH1'))).toBe(24);

    const list = await suda.get('/api/stock/adjust-requests?status=pending');
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(req.body.id);

    expect((await chai.post(`/api/stock/adjust-requests/${req.body.id}/approve`)).status).toBe(403);
    const ok = await suda.post(`/api/stock/adjust-requests/${req.body.id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.request).toMatchObject({ status: 'approved', decidedBy: 'คุณสุดา ศรีสุข' });
    expect(await stockQty(env.pool, P('p4'), W('WH1'))).toBe(20);
    expect(await stockQty(env.pool, P('p2'), W('WH1'))).toBe(190);
    expect((await suda.post(`/api/stock/adjust-requests/${req.body.id}/approve`)).status).toBe(409);
  });

  it('an approval that would go negative is refused and the request stays pending', async () => {
    const req = await chai.post('/api/stock/adjust-requests', { warehouseId: W('WH1'), lines: [{ productId: P('p4'), qtyDelta: '-1000' }], reason: 'x' });
    const r = await suda.post(`/api/stock/adjust-requests/${req.body.id}/approve`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('INSUFFICIENT_STOCK');
    const rej = await suda.post(`/api/stock/adjust-requests/${req.body.id}/reject`, { note: 'นับใหม่' });
    expect(rej.body.status).toBe('rejected');
  });
});

describe('stock reads', () => {
  it('balances are cursor paged and lots need data.cost', async () => {
    const p = await chai.get('/api/stock?limit=3');
    expect(p.body.items).toHaveLength(3);
    const p2 = await chai.get(`/api/stock?limit=3&cursor=${p.body.nextCursor}`);
    expect(p2.body.items[0]).not.toEqual(p.body.items[0]);
    expect((await chai.get('/api/stock/lots')).status).toBe(403);
    expect((await suda.get(`/api/stock/lots?productId=${P('p1')}`)).body.items.length).toBeGreaterThan(0);
  });
});

describe('shift (M07-06)', () => {
  it('cash moves, X report, close with a note when cash differs', async () => {
    const id = await openShift(prae, '1000.00');
    expect((await prae.post('/api/shifts/open', { float: '1', deviceId: 'x' })).status).toBe(409);
    await prae.post('/api/sales/pos', saleBody(env.seed, id, [{ p: 'p1', qty: '2', price: '145.00' }], '290.00'));
    const split = saleBody(env.seed, id, [{ p: 'p1', qty: '1', price: '145.00' }], '145.00');
    split.payments = [{ method: 'cash', amount: '45.00' }, { method: 'promptpay', amount: '100.00' }];
    await prae.post('/api/sales/pos', split);
    expect((await prae.post(`/api/shifts/${id}/cash-moves`, { type: 'out', amount: '200.00', note: 'ค่าน้ำแข็ง' })).status).toBe(200);
    await prae.post(`/api/shifts/${id}/cash-moves`, { type: 'in', amount: '50.00', note: 'แลกเหรียญ' });

    const x = (await prae.get('/api/shifts/current')).body;
    expect(x).toMatchObject({ float: '1000.00', cashSales: '335.00', cashIn: '50.00', cashOut: '200.00', expected: '1185.00', counted: null });
    expect(x.byMethod).toEqual({ cash: '335.00', promptpay: '100.00' });

    const noNote = await prae.post(`/api/shifts/${id}/close`, { counted: '1180.00' });
    expect(noNote.status).toBe(400);
    const closed = await prae.post(`/api/shifts/${id}/close`, { counted: '1180.00', note: 'ทอนผิด' });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ expected: '1185.00', counted: '1180.00', diff: '-5.00' });
    expect(closed.body.closedAt).toBeTruthy();
    expect((await prae.get('/api/shifts/current')).body).toBeNull();
    // a closed shift cannot sell
    const r = await prae.post('/api/sales/pos', saleBody(env.seed, id, [{ p: 'p1', qty: '1', price: '145.00' }], '145.00'));
    expect(r.body.code).toBe('SHIFT_REQUIRED');
  });
});
