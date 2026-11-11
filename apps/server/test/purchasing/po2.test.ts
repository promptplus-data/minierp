/** Purchase orders, round 2: partial PO from a sales order (on order subtracted), over-receipt with a note, free goods (ของแถม). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, type Client, type Env, setupEnv } from '../helpers';

let env: Env;
let chai: Client; // wh: inv.receive
let charoen: Client; // owner
const P = (k: string) => env.seed.products[k]!;
const W = (k: string) => env.seed.warehouses[k]!;
const V = (k: string) => env.seed.vendors[k]!;
const C = (k: string) => env.seed.customers[k]!;

beforeAll(async () => {
  env = await setupEnv();
  [chai, charoen] = await Promise.all([login(env.app, 'chai'), login(env.app, 'charoen')]);
});
afterAll(async () => { await env.close(); });

type RLine = { p: string; qty: string; cost?: string; poLineId?: string; free?: boolean };
const receive = (inv: string, po: { id: string }, lines: RLine[], overReceiveNote?: string) =>
  chai.post('/api/stock/receipts', {
    vendorId: V('v1'), vendorInvoiceNo: inv, deliveryNo: `DN-${inv}`, warehouseId: W('WH2'), poId: po.id, overReceiveNote,
    lines: lines.map((l) => ({ productId: P(l.p), qty: l.qty, unitCost: l.cost ?? '100', poLineId: l.poLineId, free: l.free })),
  });

describe('PO from a sales order: only some lines / some quantity', () => {
  let so: any;
  let po1: any;
  it('a second PO from the same order suggests only what is still missing', async () => {
    so = (await charoen.post('/api/sales/orders', {
      customerId: C('c1'), warehouseId: W('WH2'), vatMode: 'exc',
      lines: [{ productId: P('p7'), qty: '10', unitPrice: '1290' }, { productId: P('p8'), qty: '20', unitPrice: '650' }],
    })).body;
    const pf1 = (await chai.get(`/api/purchase-orders/prefill/${so.no}`)).body;
    expect(pf1.lines.map((l: any) => [l.availableQty, l.onOrderQty, l.qty])).toEqual([['4', '0', '6'], ['12', '0', '8']]);
    // PO #1: line A only, 4 of the 6 missing
    const r = await chai.post('/api/purchase-orders', {
      vendorId: V('v1'), warehouseId: W('WH2'), sourceNo: so.no,
      lines: [{ productId: P('p7'), qty: '4', unitCost: '1000', sourceLineId: pf1.lines[0].sourceLineId }],
    });
    expect(r.status).toBe(201);
    po1 = r.body;
    const pf2 = (await chai.get(`/api/purchase-orders/prefill/${so.no}`)).body;
    expect(pf2.lines.map((l: any) => [l.availableQty, l.onOrderQty, l.qty])).toEqual([['4', '4', '2'], ['12', '0', '8']]);
  });

  it('received goods move from "on order" into available without counting twice', async () => {
    expect((await receive('R6-A1', po1, [{ p: 'p7', qty: '2', cost: '1000', poLineId: po1.lines[0].id }])).status).toBe(201);
    const pf = (await chai.get(`/api/purchase-orders/prefill/${so.no}`)).body;
    expect(pf.lines[0]).toMatchObject({ availableQty: '6', onOrderQty: '2', qty: '2' });
  });

  it('over-receipt: 409 with the excess per line until a note is given; then received, audited, and the GR keeps the note', async () => {
    const no = await receive('R6-A2', po1, [{ p: 'p7', qty: '3', cost: '1000', poLineId: po1.lines[0].id }]);
    expect(no.status).toBe(409);
    expect(no.body.details).toMatchObject({
      reason: 'PO_OVER_RECEIVE', poNo: po1.no,
      lines: [{ poLineId: po1.lines[0].id, name: 'สีรองพื้นปูนใหม่ 9 ลิตร', unitName: 'ถัง', ordered: '4', received: '2', receiving: '3', excess: '1' }],
    });
    expect((await receive('R6-A2', po1, [{ p: 'p7', qty: '3', cost: '1000', poLineId: po1.lines[0].id }], '   ')).status).toBe(409);
    expect((await env.pool.query(`select count(*)::int n from stock_docs where vendor_invoice_no = 'R6-A2'`)).rows[0].n).toBe(0);
    const ok = await receive('R6-A2', po1, [{ p: 'p7', qty: '3', cost: '1000', poLineId: po1.lines[0].id }], 'ผู้ขายส่งมาเกิน รับไว้ขายต่อ');
    expect(ok.status).toBe(201);
    const po = (await chai.get(`/api/purchase-orders/${po1.no}`)).body;
    expect(po.status).toBe('received');
    expect(po.lines[0]).toMatchObject({ receivedQty: '5', remainingQty: '0', overQty: '1' });
    expect(po.receipts[1]).toMatchObject({ no: ok.body.no, overReceiveNote: 'ผู้ขายส่งมาเกิน รับไว้ขายต่อ' });
    expect((await chai.get(`/api/purchasing/receipts/${ok.body.no}`)).body.overReceiveNote).toBe('ผู้ขายส่งมาเกิน รับไว้ขายต่อ');
    const a = await env.pool.query(`select detail from audit_log where object = 'PO' and ref = $1 and action = 'over_receive'`, [po1.no]);
    expect(a.rows.map((x) => x.detail)).toEqual([`รับเกินใบสั่งซื้อ ${po1.no}: สีรองพื้นปูนใหม่ 9 ลิตร เกิน 1 ถัง · ${ok.body.no} · หมายเหตุ: ผู้ขายส่งมาเกิน รับไว้ขายต่อ`]);
    // voiding that GR rolls the PO back to partial
    expect((await chai.post(`/api/purchasing/receipts/${ok.body.no}/void`, { reason: 'ทดสอบ' })).status).toBe(200);
    const back = (await chai.get(`/api/purchase-orders/${po1.no}`)).body;
    expect(back.status).toBe('partial');
    expect(back.lines[0]).toMatchObject({ receivedQty: '2', remainingQty: '2', overQty: '0' });
  });
});

describe('free goods (ของแถม)', () => {
  let po: any;
  it('a free PO line costs 0 whatever is sent and stays out of the PO total', async () => {
    const r = await chai.post('/api/purchase-orders', {
      vendorId: V('v1'), warehouseId: W('WH2'),
      lines: [{ productId: P('p4'), qty: '10', unitCost: '100' }, { productId: P('p4'), qty: '1', unitCost: '100', free: true, discount: { kind: 'pct', value: '5' } }],
    });
    expect(r.status).toBe(201);
    po = r.body;
    expect(po.lines[1]).toMatchObject({ free: true, unitCost: '0', net: '0.00', discount: null });
    expect(po.totals.gross).toBe('1000.00');
  });

  it('a free receipt line is not an over-receipt, costs 0 even if 50 is sent, and stays out of the AP bill', async () => {
    const r = await receive('R6-F1', po, [{ p: 'p4', qty: '10', poLineId: po.lines[0].id }, { p: 'p4', qty: '2', cost: '50', free: true }]);
    expect(r.status).toBe(201);
    const g = (await env.pool.query(`select g.free, g.unit_price::text, g.amount::text, l.unit_cost::text lot from gr_lines g join stock_lots l on l.id = g.lot_id where g.gr_no = $1 order by g.line_no`, [r.body.no])).rows;
    expect(g).toEqual([
      { free: false, unit_price: '100.0000', amount: '1000.00', lot: '100.0000' },
      { free: true, unit_price: '0.0000', amount: '0.00', lot: '0.0000' },
    ]);
    expect((await env.pool.query(`select base::text from ap_bills where gr_no = $1`, [r.body.no])).rows[0].base).toBe('1000.00');
    const d = (await chai.get(`/api/purchasing/receipts/${r.body.no}`)).body;
    expect(d.lines.map((l: any) => l.free)).toEqual([false, true]);
    expect(d.itemsPreview).toContain('(ของแถม)');
    expect((await chai.get(`/api/purchase-orders/${po.no}`)).body.lines[0]).toMatchObject({ receivedQty: '10', overQty: '0' });
  });

  it('a free receipt line cannot fill a normal PO line', async () => {
    const r = await receive('R6-F2', po, [{ p: 'p4', qty: '1', free: true, poLineId: po.lines[0].id }]);
    expect(r.status).toBe(400);
    expect(r.body.details.reason).toBe('FREE_LINE_ON_PO_LINE');
  });

  it('a free PO line is received like a normal line (over-receipt asks too), at cost 0', async () => {
    const over = await receive('R6-F3', po, [{ p: 'p4', qty: '2', poLineId: po.lines[1].id }]);
    expect(over.status).toBe(409);
    expect(over.body.details.reason).toBe('PO_OVER_RECEIVE');
    const r = await receive('R6-F3', po, [{ p: 'p4', qty: '1', cost: '100', poLineId: po.lines[1].id }]);
    expect(r.status).toBe(201);
    const g = (await env.pool.query(`select free, unit_price::text, lot_unit_cost::text from gr_lines where gr_no = $1`, [r.body.no])).rows[0];
    expect(g).toEqual({ free: true, unit_price: '0.0000', lot_unit_cost: '0.0000' });
    expect((await chai.get(`/api/purchase-orders/${po.no}`)).body.status).toBe('received');
  });

  it('the last-cost prefill ignores free lines', async () => {
    const q = await charoen.post('/api/sales/quotations', { customerId: C('c1'), vatMode: 'exc', status: 'sent', lines: [{ productId: P('p4'), qty: '1000', unitPrice: '210' }] });
    expect(q.status).toBe(201);
    const pf = (await chai.get(`/api/purchase-orders/prefill/${q.body.no}`)).body;
    expect(pf.lines[0].unitCost).toBe('100'); // the last GR line of p4 is free (0); the one before cost 100
  });
});
