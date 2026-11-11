/** Free goods costing on a goods receipt: 'zero' (cost 0) or 'allocate' (paid money spread by relative market value). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, type Client, type Env, setupEnv } from '../helpers';

let env: Env;
let chai: Client; // wh: inv.receive
let charoen: Client; // owner
let suda: Client; // manager
const P = (k: string) => env.seed.products[k]!;
const W = (k: string) => env.seed.warehouses[k]!;
const V = (k: string) => env.seed.vendors[k]!;

beforeAll(async () => {
  env = await setupEnv();
  [chai, charoen, suda] = await Promise.all([login(env.app, 'chai'), login(env.app, 'charoen'), login(env.app, 'suda')]);
});
afterAll(async () => { await env.close(); });

type RLine = { p: string; qty: string; cost?: string; free?: boolean; market?: string };
const receive = (inv: string, lines: RLine[], extra: Record<string, unknown> = {}) =>
  chai.post('/api/stock/receipts', {
    vendorId: V('v1'), vendorInvoiceNo: inv, deliveryNo: `DN-${inv}`, warehouseId: W('WH2'), ...extra,
    lines: lines.map((l) => ({ productId: P(l.p), qty: l.qty, unitCost: l.cost ?? '0', free: l.free, marketUnitPrice: l.market })),
  });
const lots = async (no: string) => (await env.pool.query(
  `select g.free, g.unit_price::text, g.amount::text, g.alloc_unit_cost::text alloc, g.market_unit_price::text market, l.unit_cost::text lot, l.qty_in::text q
     from gr_lines g join stock_lots l on l.id = g.lot_id where g.gr_no = $1 order by g.line_no`, [no])).rows;
const lotSum = (rows: { lot: string; q: string }[]) => rows.reduce((a, r) => a + Number(r.lot) * Number(r.q), 0);

describe('free goods costing setting (purchasing settings)', () => {
  it('defaults to zero; only the owner may change it', async () => {
    expect((await chai.get('/api/purchasing/settings')).body).toEqual({ billDiscountMode: 'sep', freeGoodsCosting: 'zero' });
    expect((await suda.patch('/api/purchasing/settings', { freeGoodsCosting: 'allocate' })).status).toBe(403);
    expect((await charoen.patch('/api/purchasing/settings', { freeGoodsCosting: 'allocate' })).body).toEqual({ billDiscountMode: 'sep', freeGoodsCosting: 'allocate' });
    const a = await env.pool.query(`select detail from audit_log where object = 'purchasing-settings' and ref = 'วิธีคิดต้นทุนของแถม'`);
    expect(a.rows.map((r) => r.detail)).toEqual(['ต้นทุน 0 → เฉลี่ยต้นทุนตามมูลค่าตลาด']);
  });
});

describe("'allocate' receipts", () => {
  let gr: string;
  it('20 cement × 150 + 10 free at market 100 → lots 112.5 and 75 summing to the 3,000 paid; AP bill still 3,000', async () => {
    const r = await receive('FC-1', [{ p: 'p1', qty: '20', cost: '150' }, { p: 'p4', qty: '10', cost: '99', free: true, market: '100' }]);
    expect(r.status).toBe(201);
    gr = r.body.no;
    const g = await lots(gr);
    expect(g).toEqual([
      { free: false, unit_price: '150.0000', amount: '3000.00', alloc: '112.5000', market: null, lot: '112.5000', q: '20.0000' },
      { free: true, unit_price: '0.0000', amount: '0.00', alloc: '75.0000', market: '100.0000', lot: '75.0000', q: '10.0000' },
    ]);
    expect(lotSum(g)).toBe(3000);
    expect((await env.pool.query(`select base::text, total::text from ap_bills where gr_no = $1`, [gr])).rows[0]).toEqual({ base: '3000.00', total: '3210.00' });
    const det = (await charoen.get(`/api/purchasing/receipts/${gr}`)).body;
    expect(det.freeGoodsCosting).toBe('allocate');
    expect(det.lines.map((l: any) => [l.unitPrice, l.allocUnitCost, l.marketUnitPrice])).toEqual([['150', '112.5', null], ['0', '75', '100']]);
  });

  it('cost fields stay hidden from a viewer without data.cost', async () => {
    const det = (await chai.get(`/api/purchasing/receipts/${gr}`)).body;
    expect(det.lines.map((l: any) => [l.unitPrice, l.allocUnitCost, l.marketUnitPrice])).toEqual([[null, null, null], [null, null, null]]);
  });

  it('the market price of a free line defaults to the retail price of its unit; the bill discount (BR-19 alloc) is taken off first', async () => {
    await charoen.patch('/api/purchasing/settings', { billDiscountMode: 'alloc' });
    // paid 10 × 210 = 2,100 − 100 discount = 2,000; free 200 ก้อน p3 at retail 24 = 4,800; market 2,100 : 4,800
    const r = await receive('FC-2', [{ p: 'p4', qty: '10', cost: '210' }, { p: 'p3', qty: '200', free: true }], { billDiscount: '100' });
    expect(r.status).toBe(201);
    await charoen.patch('/api/purchasing/settings', { billDiscountMode: 'sep' });
    const g = await lots(r.body.no);
    expect(g[1]).toMatchObject({ free: true, market: '24.0000' });
    expect(lotSum(g)).toBeCloseTo(2000, 2);
    expect(g[0]!.lot).toBe('60.8696'); // 2,000 × 2,100 / 6,900 / 10
    expect((await env.pool.query(`select base::text, discount::text from ap_bills where gr_no = $1`, [r.body.no])).rows[0]).toEqual({ base: '2100.00', discount: '100.00' });
  });

  it("a receipt can choose 'zero' against an 'allocate' shop default: free lot at 0, paid lot at invoice cost", async () => {
    const r = await receive('FC-3', [{ p: 'p1', qty: '20', cost: '150' }, { p: 'p4', qty: '10', free: true, market: '100' }], { freeGoodsCosting: 'zero' });
    expect(r.status).toBe(201);
    expect((await lots(r.body.no)).map((l) => [l.lot, l.alloc, l.market])).toEqual([['150.0000', null, null], ['0.0000', null, null]]);
    expect((await charoen.get(`/api/purchasing/receipts/${r.body.no}`)).body.freeGoodsCosting).toBe('zero');
  });

  it('a negative market price is refused', async () => {
    expect((await receive('FC-4', [{ p: 'p1', qty: '1', cost: '150' }, { p: 'p4', qty: '1', free: true, market: '-1' }])).status).toBe(400);
  });

  it('an allocated receipt can still be voided: lots go back to 0 and the AP bill is voided', async () => {
    const r = await receive('FC-5', [{ p: 'p1', qty: '4', cost: '150' }, { p: 'p4', qty: '2', free: true, market: '100' }]);
    expect(r.status).toBe(201);
    const v = await charoen.post(`/api/purchasing/receipts/${r.body.no}/void`, { reason: 'ทดสอบ' });
    expect(v.status).toBe(200);
    const left = await env.pool.query(`select l.remaining::text from gr_lines g join stock_lots l on l.id = g.lot_id where g.gr_no = $1`, [r.body.no]);
    expect(left.rows.map((x) => x.remaining)).toEqual(['0.0000', '0.0000']);
    expect((await env.pool.query(`select status from ap_bills where gr_no = $1`, [r.body.no])).rows[0].status).toBe('void');
  });

  it('vendor return of the free line: credit 0, stock leaves at its allocated lot cost; a paid line credits the invoice price', async () => {
    const det = (await charoen.get(`/api/purchasing/receipts/${gr}`)).body;
    const free = await charoen.post('/api/ap/vendor-returns', { grNo: gr, lines: [{ grLineId: det.lines[1].id, qty: '4' }], reason: 'ของแถมชำรุด' });
    expect(free.status).toBe(201);
    expect(free.body).toMatchObject({ base: '0.00', total: '0.00', apApplied: '0.00' });
    expect((await env.pool.query(`select cogs::text from vendor_returns where no = $1`, [free.body.no])).rows[0].cogs).toBe('300.00'); // 4 × 75
    const paid = await charoen.post('/api/ap/vendor-returns', { grNo: gr, lines: [{ grLineId: det.lines[0].id, qty: '2' }], reason: 'ถุงแตก' });
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({ base: '300.00' }); // 2 × 150 invoice price
    expect((await env.pool.query(`select cogs::text from vendor_returns where no = $1`, [paid.body.no])).rows[0].cogs).toBe('225.00'); // 2 × 112.5 lot cost
  });
});
