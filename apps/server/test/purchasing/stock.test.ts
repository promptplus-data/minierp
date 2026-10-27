/** M06 stock count (REQ-M06-05/06, BR-09), stock ledger (REQ-M06-01), reorder point list. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, openShift, saleBody, stockQty, type Client, type Env, setupEnv } from '../helpers';

let env: Env;
let chai: Client; // wh: inv.count, no inv.seeSys, no approval
let suda: Client; // manager: inv.seeSys, inv.adjApprove
let charoen: Client;
let prae: Client; // cashier
const P = (k: string) => env.seed.products[k]!;
const W = (k: string) => env.seed.warehouses[k]!;

beforeAll(async () => {
  env = await setupEnv();
  [chai, suda, charoen, prae] = await Promise.all([login(env.app, 'chai'), login(env.app, 'suda'), login(env.app, 'charoen'), login(env.app, 'prae')]);
});
afterAll(async () => { await env.close(); });

describe('stock count', () => {
  let id: string;

  it('opens a round for one warehouse and category; system qty is hidden while counting (BR-09)', async () => {
    const r = await chai.post('/api/stock-counts', { warehouseId: W('WH1'), category: 'ปูนซีเมนต์' });
    expect(r.status).toBe(201);
    id = r.body.id;
    expect(r.body).toMatchObject({ no: 'CNT2610-0001', status: 'counting', systemHidden: true, lines: 1, counted: 0 });
    expect(r.body.items).toEqual([expect.objectContaining({ productId: P('p1'), systemQty: null, movedQty: null, variance: null })]);
    const peek = await chai.get(`/api/stock-counts/${id}?showSystem=true`); // wh has no inv.seeSys
    expect(peek.body.systemHidden).toBe(true);
    expect((await suda.get(`/api/stock-counts/${id}?showSystem=true`)).body.items[0].systemQty).toBe('62');
    expect((await suda.get(`/api/stock-counts/${id}?showSystem=false`)).body.systemHidden).toBe(true);
    const dup = await chai.post('/api/stock-counts', { warehouseId: W('WH1') });
    expect(dup.status).toBe(409);
    expect((await prae.post('/api/stock-counts', { warehouseId: W('WH2') })).status).toBe(403);
  });

  it('several counters add scans; a sale during the count is netted out of the variance (REQ-M06-06)', async () => {
    expect((await chai.post(`/api/stock-counts/${id}/entries`, { productId: P('p1'), qty: '30', mode: 'add' })).body.countedQty).toBe('30');
    expect((await suda.post(`/api/stock-counts/${id}/entries`, { productId: P('p1'), qty: '27', mode: 'add' })).body.countedQty).toBe('57');
    expect((await chai.post(`/api/stock-counts/${id}/entries`, { productId: P('p2'), qty: '1' })).status).toBe(400); // not in this round
    // the cashier sells 2 bags while counting: system 62 → expected 60
    const shift = await openShift(prae);
    const sale = await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p1', qty: '2', price: '145.00' }], '290.00'));
    expect(sale.status).toBe(201);
    const r = await chai.post(`/api/stock-counts/${id}/submit`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'submitted', systemHidden: false, adjustRequestNo: 'RQ2610-0001' });
    expect(r.body.items[0]).toMatchObject({ systemQty: '62', movedQty: '-2', countedQty: '57', variance: '-3' });
    expect(await stockQty(env.pool, P('p1'), W('WH1'))).toBe(60); // nothing changes before approval
  });

  it('the variance is an adjustment request: wh cannot approve, the manager can, then stock matches the count', async () => {
    const adj = (await suda.get('/api/stock/adjust-requests?status=pending')).body.items[0];
    expect(adj).toMatchObject({ no: 'RQ2610-0001', lines: [{ productId: P('p1'), qtyDelta: '-3' }], reason: 'ผลนับสต็อก CNT2610-0001' });
    expect((await chai.post(`/api/stock/adjust-requests/${adj.id}/approve`)).status).toBe(403);
    expect((await suda.post(`/api/stock/adjust-requests/${adj.id}/approve`)).status).toBe(200);
    expect(await stockQty(env.pool, P('p1'), W('WH1'))).toBe(57);
    expect((await chai.post(`/api/stock-counts/${id}/entries`, { productId: P('p1'), qty: '1' })).status).toBe(409); // closed
  });

  it('a round that matches creates no request; rounds can be cancelled; list is paged', async () => {
    const r = await chai.post('/api/stock-counts', { warehouseId: W('WH2'), category: 'สี' });
    await chai.post(`/api/stock-counts/${r.body.id}/entries`, { productId: P('p7'), qty: '4' });
    const s = await chai.post(`/api/stock-counts/${r.body.id}/submit`);
    expect(s.body.adjustRequestNo).toBeNull();
    const c = await chai.post('/api/stock-counts', { warehouseId: W('WH2') });
    expect(c.body.lines).toBe(11); // every active stock product (services excluded)
    expect((await chai.post(`/api/stock-counts/${c.body.id}/submit`)).status).toBe(400); // nothing counted
    expect((await chai.post(`/api/stock-counts/${c.body.id}/cancel`)).body.status).toBe('cancelled');
    const list = await suda.get('/api/stock-counts?limit=2');
    expect(list.body.items.map((x: { no: string }) => x.no)).toEqual(['CNT2610-0003', 'CNT2610-0002']);
    const p2 = await suda.get(`/api/stock-counts?limit=2&cursor=${list.body.nextCursor}`);
    expect(p2.body.items.map((x: { no: string }) => x.no)).toEqual(['CNT2610-0001']);
    const audit = await env.pool.query(`select action from audit_log where object = 'stock-count' order by id`);
    expect(audit.rows.map((x) => x.action)).toEqual(['open', 'submit', 'open', 'submit', 'open', 'cancel']);
  });
});

describe('stock ledger', () => {
  it('newest first with running balance, document refs, search, paging; cost only with data.cost', async () => {
    const all = await suda.get(`/api/stock/ledger?productId=${P('p1')}&warehouseId=${W('WH1')}`);
    expect(all.status).toBe(200);
    const rows = all.body.items.map((x: { docType: string; qty: string; balance: string }) => [x.docType, x.qty, x.balance]);
    expect(rows[0]).toEqual(['ADJ', '-3', '57']);
    expect(rows[1]).toEqual(['ABB', '-2', '60']);
    expect(all.body.items[0].unitCost).not.toBeNull();
    const w = await chai.get(`/api/stock/ledger?productId=${P('p1')}&warehouseId=${W('WH1')}&limit=1`);
    expect(w.body.items[0].unitCost).toBeNull();
    const next = await chai.get(`/api/stock/ledger?productId=${P('p1')}&warehouseId=${W('WH1')}&limit=1&cursor=${w.body.nextCursor}`);
    expect(next.body.items[0]).toMatchObject({ docType: 'ABB', balance: '60' });
    const q = await suda.get('/api/stock/ledger?q=ผลนับ');
    expect(q.body.items.length).toBeGreaterThan(0);
    expect((await env.app.inject({ method: 'GET', url: '/api/stock/ledger' })).statusCode).toBe(401);
  });

  it('reorder list: products under their reorder point (all warehouses), paged', async () => {
    const r = await chai.get('/api/stock/reorder');
    expect(r.status).toBe(200);
    // seed: p8 sand 12 < ... ; p1 total 57+340 = 397 > 80 → not listed
    const skus = r.body.items.map((x: { sku: string }) => x.sku);
    expect(skus).not.toContain('SCG-CEM-T50');
    for (const x of r.body.items) expect(Number(x.qty)).toBeLessThan(Number(x.reorderPoint));
    await env.pool.query(`update products set reorder_point = 1000 where id = $1`, [P('p1')]);
    const r2 = await chai.get('/api/stock/reorder?q=ตราเสือ');
    expect(r2.body.items).toEqual([expect.objectContaining({ sku: 'SCG-CEM-T50', qty: '397', reorderPoint: '1000', shortBy: '603' })]);
    const dash = await charoen.get('/api/purchasing/dashboard');
    expect(dash.body.belowReorder).toBe(r.body.items.length + 1);
  });
});
