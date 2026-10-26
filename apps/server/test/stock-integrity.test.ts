/** BR-07 (never negative, concurrent), BR-04 (gap-free numbers), BR-03/BR-22 (void, no delete), BR-21 (original cost). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, lotsOf, openShift, saleBody, setupEnv, stockQty, type Client, type Env } from './helpers';

let env: Env;
let prae: Client;
let suda: Client;
let shift: string;
let failNext = false;

beforeAll(async () => {
  env = await setupEnv({
    hooks: { beforeCommit: (op) => { if (failNext && op === 'posSale') { failNext = false; throw new Error('simulated crash before commit'); } } },
  });
  prae = await login(env.app, 'prae');
  suda = await login(env.app, 'suda');
  shift = await openShift(prae);
});
afterAll(async () => { await env.close(); });

describe('BR-07 stock never negative', () => {
  it('two parallel sales of the last 8 units: exactly one succeeds, stock ends at 0', async () => {
    const p7 = env.seed.products.p7!;
    const wh = env.seed.warehouses.WH1!;
    expect(await stockQty(env.pool, p7, wh)).toBe(8);
    const mk = () => saleBody(env.seed, shift, [{ p: 'p7', qty: '8', price: '1290.00' }], '10320.00');
    const results = await Promise.all([prae.post('/api/sales/pos', mk()), prae.post('/api/sales/pos', mk())]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.code).toBe('INSUFFICIENT_STOCK');
    expect(loser.body.details).toEqual([{ productId: p7, warehouseId: wh, need: '8', have: '0' }]);
    expect(await stockQty(env.pool, p7, wh)).toBe(0);
    const neg = await env.pool.query(`select count(*)::int n from stock_lots where remaining < 0`);
    expect(neg.rows[0].n).toBe(0);
  });

  it('a sale and a stock issue racing for the same last units (different counters): one wins, lots locked', async () => {
    const chai = await login(env.app, 'chai');
    const p4 = env.seed.products.p4!;
    const wh = env.seed.warehouses.WH1!;
    expect(await stockQty(env.pool, p4, wh)).toBe(24);
    const [sale, iss] = await Promise.all([
      prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p4', qty: '24', price: '210.00' }], '5040.00')),
      chai.post('/api/stock/issues', { warehouseId: wh, lines: [{ productId: p4, qty: '24' }], reason: 'ใช้ในร้าน' }),
    ]);
    expect([sale.status, iss.status].sort()).toEqual([201, 409]);
    const loser = sale.status === 409 ? sale : iss;
    // planned shortage from the locked lots, not the database CHECK firing on a lost update
    expect(loser.body.details).toEqual([{ productId: p4, warehouseId: wh, need: '24', have: '0' }]);
    expect(await stockQty(env.pool, p4, wh)).toBe(0);
  });

  it('a shortage on one line writes nothing for the other lines', async () => {
    const p6 = env.seed.products.p6!;
    const before = await stockQty(env.pool, p6, env.seed.warehouses.WH1!);
    const r = await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p6', qty: '1', price: '89.00' }, { p: 'p7', qty: '1', price: '1290.00' }], '1379.00'));
    expect(r.status).toBe(409);
    expect(r.body.details).toHaveLength(1);
    expect(await stockQty(env.pool, p6, env.seed.warehouses.WH1!)).toBe(before);
  });

  it('the database CHECK rejects a negative lot even if the code had a bug', async () => {
    await expect(env.pool.query(`update stock_lots set remaining = -1 where id = (select min(id) from stock_lots)`)).rejects.toThrow(/stock_lots_remaining_nonneg/);
  });
});

describe('BR-04 gap-free document numbers', () => {
  it('a sale that fails mid-transaction (after numbering) does not burn a number', async () => {
    const first = await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00'));
    const n1 = Number(first.body.no.slice(-4));
    const p6Before = await stockQty(env.pool, env.seed.products.p6!, env.seed.warehouses.WH1!);

    failNext = true; // crash after doc + lines + stock moves are written, right before COMMIT
    const crashed = await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00'));
    expect(crashed.status).toBe(500);
    expect(await stockQty(env.pool, env.seed.products.p6!, env.seed.warehouses.WH1!)).toBe(p6Before);

    const short = await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p6', qty: '100000', price: '89.00' }], '8900000.00'));
    expect(short.body.code).toBe('INSUFFICIENT_STOCK');

    const next = await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00'));
    expect(Number(next.body.no.slice(-4))).toBe(n1 + 1);
    const nos = await env.pool.query<{ no: string }>(`select no from docs where type = 'ABB' order by no`);
    const seqs = nos.rows.map((r) => Number(r.no.slice(-4)));
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // 1..n, no holes
  });
});

describe('BR-03 / BR-22 void', () => {
  it('void keeps the number, flags the doc and restores stock into the original lots at original cost', async () => {
    const p1 = env.seed.products.p1!;
    const wh = env.seed.warehouses.WH1!;
    const before = await lotsOf(env.pool, p1, wh);
    const sale = await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p1', qty: '30', price: '145.00' }], '4350.00'));
    expect(sale.status).toBe(201);

    const cashierVoid = await prae.post(`/api/sales/docs/${sale.body.no}/void`, { reason: 'ลูกค้าเปลี่ยนใจ' });
    expect(cashierVoid.status).toBe(403); // cashier: 'apv' needs a PIN

    const v = await prae.post(`/api/sales/docs/${sale.body.no}/void`, { reason: 'ลูกค้าเปลี่ยนใจ', approverUserId: env.seed.users.suda, pin: '1234' });
    expect(v.status).toBe(200);
    expect(v.body.no).toBe(sale.body.no);
    expect(v.body.status).toBe('void');
    expect(v.body.voided).toMatchObject({ by: 'น้องแพร', reason: 'ลูกค้าเปลี่ยนใจ' });
    expect(await lotsOf(env.pool, p1, wh)).toEqual(before);

    const again = await suda.post(`/api/sales/docs/${sale.body.no}/void`, { reason: 'x' });
    expect(again.status).toBe(409);
    const moves = await env.pool.query(`select qty::text, cost::text from stock_moves where doc_no = $1 order by qty`, [sale.body.no]);
    expect(moves.rows).toEqual([{ qty: '-30.0000', cost: '3580.70' }, { qty: '30.0000', cost: '3580.70' }]);
  });

  it('a void sale is excluded from the shift cash', async () => {
    const s = await prae.get('/api/shifts/current');
    const live = await env.pool.query(`select coalesce(sum(total),0)::text t from docs where shift_id = $1 and status = 'active' and type <> 'CN'`, [shift]);
    expect(s.body.cashSales).toBe(Number(live.rows[0].t).toFixed(2));
  });

  it('documents cannot be deleted, not even by a superuser', async () => {
    await expect(env.pool.query(`delete from docs`)).rejects.toThrow(/never deleted/);
    await expect(env.pool.query(`delete from users where username = 'ton'`)).rejects.toThrow(/never deleted/);
  });
});
