/** ของแถม on a POS bill: price 0, cuts stock FIFO, COGS, audit; not a discount nor a below-cost sale; returns refund 0. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, openShift, saleBody, setupEnv, type Client, type Env } from './helpers';

let env: Env;
let prae: Client; // cashier: discount cap 0, no pos.price
let suda: Client;
let shift: string;

beforeAll(async () => {
  env = await setupEnv();
  prae = await login(env.app, 'prae');
  suda = await login(env.app, 'suda');
  shift = await openShift(prae);
});
afterAll(async () => { await env.close(); });

const wh1 = (p: string) => env.pool.query(`select coalesce(sum(remaining),0)::text s from stock_lots where product_id = $1 and warehouse_id = $2`, [env.seed.products[p], env.seed.warehouses.WH1]).then((r) => r.rows[0].s);
const withFree = (body: any, free: { p: string; qty: string; price?: string }[]) => ({
  ...body, lines: [...body.lines, ...free.map((f) => ({ productId: env.seed.products[f.p], unitIdx: 0, qty: f.qty, unitPrice: f.price ?? '0', free: true }))],
});

let billNo = '';
describe('POS bill with a free line', () => {
  it('a cashier gives 2 free p6 with 1 p1: no approval, total unchanged, stock cut, COGS includes the free line, audited', async () => {
    const before = await wh1('p6');
    // the client sends 89 for the free line: the server forces 0
    const r = await prae.post('/api/sales/pos', withFree(saleBody(env.seed, shift, [{ p: 'p1', qty: '1', price: '145.00' }], '145.00'), [{ p: 'p6', qty: '2', price: '89' }]));
    expect(r.status).toBe(201);
    billNo = r.body.no;
    expect(r.body.totals.total).toBe('145.00');
    expect(r.body.totals.vat).toBe('9.49'); // 145 × 7/107: the free line adds nothing to the VAT base
    expect(r.body.lines[1]).toMatchObject({ unitPrice: '0', net: '0.00', discount: '0.00', free: true });
    expect(r.body.discReason ?? null).toBeNull();
    expect(Number(before) - Number(await wh1('p6'))).toBe(2);
    const cogs = (await env.pool.query(`select free, cogs::text from doc_lines l join docs d on d.id = l.doc_id where d.no = $1 order by line_no`, [billNo])).rows;
    expect(cogs[1]).toEqual({ free: true, cogs: '137.74' }); // 2 × 68.87, the oldest WH1 lot
    const a = await env.pool.query(`select detail from audit_log where action = 'free_goods' and ref = $1`, [billNo]);
    expect(a.rows.map((x) => x.detail)).toEqual(['ของแถม ท่อ PVC 4 หุน ชั้น 8.5 ยาว 4 ม. × 2 เส้น · ต้นทุน ฿137.74']);
  });

  it('a free line is never a below-cost line in the live preview', async () => {
    const r = await prae.post('/api/sales/pos/preview', {
      warehouseId: env.seed.warehouses.WH1, billDiscount: '0',
      lines: [{ productId: env.seed.products.p1, unitIdx: 0, qty: '1', unitPrice: '145' }, { productId: env.seed.products.p6, unitIdx: 0, qty: '1', unitPrice: '0', free: true }],
    });
    expect(r.body).toMatchObject({ belowCost: false, lines: [{ belowCost: false }, { belowCost: false }] });
  });

  it('a price-0 line NOT flagged free still needs the manager override (old rules intact)', async () => {
    const r = await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p1', qty: '1', price: '145.00' }, { p: 'p6', qty: '1', price: '0' }], '145.00'));
    expect(r.status).toBe(403);
    expect(r.body.details).toMatchObject({ need: 'discountApproval', priceChanged: true });
  });

  it('free goods cannot overdraw stock (BR-07)', async () => {
    const r = await prae.post('/api/sales/pos', withFree(saleBody(env.seed, shift, [{ p: 'p1', qty: '1', price: '145.00' }], '145.00'), [{ p: 'p4', qty: '999' }]));
    expect(r.status).toBe(409);
  });

  it('the sales report shows ของแถม (ต้นทุน) to cost viewers, inside COGS', async () => {
    const date = (await prae.get(`/api/sales/docs/${billNo}`)).body.date;
    const r = await suda.get(`/api/reports/sales?from=${date}&to=${date}&by=day`);
    expect(r.status).toBe(200);
    expect(r.body.freeGoodsCost).toBe('137.74');
    expect(Number(r.body.totals.cogs)).toBeGreaterThan(137.74);
  });

  it('returning the free line refunds 0 and restocks at its original lot cost', async () => {
    const doc = (await prae.get(`/api/sales/docs/${billNo}`)).body;
    const before = await wh1('p6');
    const r = await suda.post('/api/returns', { sourceDocNo: billNo, lines: [{ lineId: doc.lines[1].id, qty: '2' }], condition: 'good', refund: 'cash', reason: 'ลูกค้าไม่เอา' });
    expect(r.status).toBe(201);
    expect(r.body.totals.total).toBe('0.00');
    expect(r.body.lines[0]).toMatchObject({ free: true, net: '0.00' });
    expect(Number(await wh1('p6')) - Number(before)).toBe(2);
    const lot = await env.pool.query(`select unit_cost::text from stock_lots where ref = $1`, [r.body.no]);
    expect(lot.rows[0].unit_cost).toBe('68.8700');
  });
});
