/**
 * REQ-M06-01 reserved / available, damaged-goods returns (คลังสินค้าชำรุด) and how reports net credit notes,
 * REQ-M06-06 partial approval and recount of a stock count, notes on adjust requests / credit notes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, openShift, saleBody, setupEnv, stockQty, type Client, type Env } from './helpers';

let env: Env;
let owner: Client;
let suda: Client;
let chai: Client;
let boy: Client;
let prae: Client;
let shift: string;

const P = (k: string) => env.seed.products[k]!;
const W = (k: string) => env.seed.warehouses[k]!;
const C = (k: string) => env.seed.customers[k]!;

beforeAll(async () => {
  env = await setupEnv();
  [owner, suda, chai, boy, prae] = await Promise.all(['charoen', 'suda', 'chai', 'boy', 'prae'].map((u) => login(env.app, u)));
  shift = await openShift(prae);
});
afterAll(async () => { await env.close(); });

async function ok<T = any>(p: Promise<{ status: number; body: any }>, status = 200): Promise<T> {
  const r = await p;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const row = async (c: Client, p: string, w: string) => (await ok(c.get(`/api/stock?productId=${p}&warehouseId=${w}`))).items[0];

describe('reserved and available (REQ-M06-01)', () => {
  let so: any;
  it('an open sales order reserves its undelivered quantity in its warehouse; on hand is unchanged', async () => {
    expect(await row(chai, P('p4'), W('WH2'))).toMatchObject({ qty: '60', reserved: '0', available: '60', damaged: false });
    so = await ok(boy.post('/api/sales/orders', { customerId: C('c1'), warehouseId: W('WH2'), lines: [{ productId: P('p4'), qty: '50', unitPrice: '196.26' }] }), 201);
    expect(await row(chai, P('p4'), W('WH2'))).toMatchObject({ qty: '60', reserved: '50', available: '10' });
    expect(await row(chai, P('p4'), W('WH1'))).toMatchObject({ reserved: '0' });
  });

  it('a delivery lowers on hand and reserved together', async () => {
    await ok(chai.post('/api/sales/deliveries', { soNo: so.no, lines: [{ srcLineId: so.lines[0].id, qty: '20' }] }), 201);
    expect(await row(chai, P('p4'), W('WH2'))).toMatchObject({ qty: '40', reserved: '30', available: '10' });
  });

  it('reserved does not block: available may go negative and another delivery still goes out from on hand (BR-07 only)', async () => {
    const so2 = await ok(boy.post('/api/sales/orders', { customerId: C('c2'), warehouseId: W('WH2'), lines: [{ productId: P('p4'), qty: '25', unitPrice: '196.26' }] }), 201);
    expect(await row(chai, P('p4'), W('WH2'))).toMatchObject({ qty: '40', reserved: '55', available: '-15' });
    await ok(chai.post('/api/sales/deliveries', { soNo: so2.no, lines: [{ srcLineId: so2.lines[0].id, qty: '25' }] }), 201);
    expect(await row(chai, P('p4'), W('WH2'))).toMatchObject({ qty: '15', reserved: '30', available: '-15' });
  });

  it('a sales order without a warehouse reserves in the default sellable warehouse; a void releases it', async () => {
    const so3 = await ok(boy.post('/api/sales/orders', { customerId: C('c1'), lines: [{ productId: P('p6'), qty: '7', unitPrice: '83.18' }] }), 201);
    await env.pool.query(`update sales_orders set warehouse_id = null where no = $1`, [so3.no]);
    expect(await row(chai, P('p6'), W('WH2'))).toMatchObject({ reserved: '7' });
    await ok(owner.post(`/api/sales/orders/${so3.no}/void`, { reason: 'ลูกค้ายกเลิก' }));
    expect(await row(chai, P('p6'), W('WH2'))).toMatchObject({ reserved: '0' });
  });
});

describe('returns: damaged goods go to the damaged-goods warehouse', () => {
  let inv: any;
  it('mixed credit note: good line back to the bill warehouse, damaged line into an auto-created คลังสินค้าชำรุด (audited)', async () => {
    inv = await ok(boy.post('/api/sales/invoices', {
      source: 'direct', customerId: C('c2'), warehouseId: W('WH2'), lines: [{ productId: P('p6'), qty: '6', unitPrice: '83.18' }, { productId: P('p2'), qty: '10', unitPrice: '48.60' }],
    }), 201);
    expect((await ok(owner.get('/api/warehouses?kind=damaged'))).items).toEqual([]);
    const [p6, p2] = [await stockQty(env.pool, P('p6'), W('WH2')), await stockQty(env.pool, P('p2'), W('WH2'))];
    const cn = await ok(suda.post('/api/returns', {
      sourceDocNo: inv.doc.no, refund: 'credit', reason: 'ส่งของคืน', note: 'ลูกค้าแจ้งทางโทรศัพท์',
      lines: [{ lineId: inv.doc.lines[0].id, qty: '2', condition: 'good' }, { lineId: inv.doc.lines[1].id, qty: '3', condition: 'damaged' }],
    }), 201);
    expect(cn.lines.map((l: any) => l.returnCondition)).toEqual(['good', 'damaged']);
    const dw = (await ok(owner.get('/api/warehouses?kind=damaged'))).items;
    expect(dw).toMatchObject([{ name: 'คลังสินค้าชำรุด', kind: 'damaged', system: true, isPos: false, active: true }]);
    expect(await stockQty(env.pool, P('p6'), W('WH2'))).toBe(p6 + 2);
    expect(await stockQty(env.pool, P('p2'), W('WH2'))).toBe(p2);
    expect(await stockQty(env.pool, P('p2'), dw[0].id)).toBe(3);
    const doc = await env.pool.query(`select condition, cn_note from docs where no = $1`, [cn.no]);
    expect(doc.rows[0]).toEqual({ condition: 'mixed', cn_note: 'ลูกค้าแจ้งทางโทรศัพท์' });
    const audit = await env.pool.query<{ object: string; detail: string }>(`select object, detail from audit_log where object in ('warehouse','CN') order by id`);
    expect(audit.rows[0]).toMatchObject({ object: 'warehouse', detail: expect.stringContaining(cn.no) });
    expect(audit.rows[1]!.detail).toContain('ชำรุด → คลังสินค้าชำรุด');
  });

  it('later damaged returns reuse the same warehouse; the old condition "bad" means damaged', async () => {
    const bill = await ok(prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p6', qty: '2', price: '89.00' }], '178.00', { docKind: 'full', customerId: C('c1') })), 201);
    await ok(suda.post('/api/returns', { sourceDocNo: bill.no, lines: [{ lineId: bill.lines[0].id, qty: '1' }], condition: 'bad', refund: 'transfer', reason: 'แตก' }), 201);
    const dw = (await ok(owner.get('/api/warehouses?kind=damaged'))).items;
    expect(dw).toHaveLength(1);
    expect(await stockQty(env.pool, P('p6'), dw[0].id)).toBe(1);
  });

  it('damaged stock is not available stock: left out of /api/stock unless asked, available 0, separate in the stock report', async () => {
    const dw = (await ok(owner.get('/api/warehouses?kind=damaged'))).items[0].id;
    const all = await ok(chai.get(`/api/stock?productId=${P('p2')}`));
    expect(all.items.map((x: any) => x.warehouseId)).not.toContain(dw);
    const inc = await ok(chai.get(`/api/stock?productId=${P('p2')}&damaged=include`));
    expect(inc.items.find((x: any) => x.warehouseId === dw)).toMatchObject({ qty: '3', available: '0', damaged: true });
    const rep = await ok(owner.get(`/api/reports/stock?q=SCG-ROOF-LK`));
    const r = rep.rows[0];
    expect(r.damagedQty).toBe('3');
    expect(Number(r.qty)).toBe((await stockQty(env.pool, P('p2'), W('WH1'))) + (await stockQty(env.pool, P('p2'), W('WH2'))));
    const only = await ok(owner.get(`/api/reports/stock?q=SCG-ROOF-LK&warehouseId=${dw}`));
    expect(only.rows[0].qty).toBe('3');
  });

  it('reports net the credit note: sales net / VAT / cost go down, the invoice balance (AR) drops by the refund', async () => {
    const before = await ok(owner.get('/api/reports/sales?from=2026-10-26&to=2026-10-26'));
    const vatBefore = await ok(owner.get('/api/reports/vat?month=2026-10'));
    const ar0 = Number((await env.pool.query(`select ar_balance::text b from docs where no = $1`, [inv.doc.no])).rows[0].b);
    const cn = await ok(suda.post('/api/returns', { sourceDocNo: inv.doc.no, lines: [{ lineId: inv.doc.lines[0].id, qty: '1', condition: 'damaged' }], refund: 'credit', reason: 'แตก' }), 201);
    const after = await ok(owner.get('/api/reports/sales?from=2026-10-26&to=2026-10-26'));
    const vatAfter = await ok(owner.get('/api/reports/vat?month=2026-10'));
    const cnDoc = await env.pool.query<{ base7: string; vat: string; total: string; cogs: string }>(
      `select d.base7::text, d.vat::text, d.total::text, l.cogs::text from docs d join doc_lines l on l.doc_id = d.id where d.no = $1`, [cn.no]);
    const x = cnDoc.rows[0]!;
    const diff = (a: string, b: string) => +(Number(a) - Number(b)).toFixed(2);
    expect(diff(after.totals.net, before.totals.net)).toBe(-Number(x.base7));
    expect(diff(after.totals.vat, before.totals.vat)).toBe(-Number(x.vat));
    expect(diff(after.totals.cogs, before.totals.cogs)).toBe(-Number(x.cogs)); // damaged goods are restocked (damaged warehouse) at cost
    expect(after.totals.returns).toBe(before.totals.returns + 1);
    expect(diff(vatAfter.totals.vat, vatBefore.totals.vat)).toBe(-Number(x.vat));
    const ar1 = Number((await env.pool.query(`select ar_balance::text b from docs where no = $1`, [inv.doc.no])).rows[0].b);
    expect(+(ar0 - ar1).toFixed(2)).toBe(Number(x.total));
    // internal-cost report: restocked damaged returns are not a cost until written off
    const costs = await ok(owner.get('/api/reports/costs?month=2026-10'));
    expect(costs.lines.find((l: any) => l.key === 'badReturn').amount).toBe('0.00');
  });
});

describe('stock count: partial approval and recount (REQ-M06-06)', () => {
  let id = '';
  let count: any;
  it('a count with two variances, one sale-like move during the count', async () => {
    count = await ok(chai.post('/api/stock-counts', { warehouseId: W('WH2'), category: 'วัสดุมวลรวม', note: 'นับประจำเดือน' }), 201);
    id = count.id;
    expect(count.note).toBe('นับประจำเดือน');
    await ok(chai.post(`/api/stock-counts/${id}/entries`, { productId: P('p8'), qty: '10' }));
    await ok(chai.post(`/api/stock-counts/${id}/entries`, { productId: P('p10'), qty: '9' }));
    await ok(chai.post('/api/stock/issues', { warehouseId: W('WH2'), lines: [{ productId: P('p8'), qty: '1' }], reason: 'ใช้ในร้าน' }), 201); // 12 → 11 while counting
    count = await ok(chai.post(`/api/stock-counts/${id}/submit`));
    expect(count).toMatchObject({ status: 'submitted', review: 2 });
    const v = Object.fromEntries(count.items.map((l: any) => [l.productId, [l.variance, l.state]]));
    expect(v[P('p8')]).toEqual(['-1', 'review']);
    expect(v[P('p10')]).toEqual(['1', 'review']);
  });

  it('the approver approves one line and sends the other back to recount; the round stays open', async () => {
    expect((await chai.post(`/api/stock/adjust-requests/${count.adjustRequestId}/decide`, { approve: [P('p10')], recount: [P('p8')] })).status).toBe(403);
    const r = await ok(suda.post(`/api/stock/adjust-requests/${count.adjustRequestId}/decide`, { approve: [P('p10')], recount: [P('p8')], note: 'ทรายนับใหม่' }));
    expect(r.request).toMatchObject({ status: 'approved', note: 'ทรายนับใหม่', countNo: count.no });
    expect(r.request.lines.map((l: any) => l.state).sort()).toEqual(['approved', 'recount']);
    expect(r.doc.lines).toEqual([{ productId: P('p10'), qty: '1', unitCost: expect.any(String) }]);
    expect(await stockQty(env.pool, P('p10'), W('WH2'))).toBe(9);
    expect(await stockQty(env.pool, P('p8'), W('WH2'))).toBe(11);
    const c = await ok(chai.get(`/api/stock-counts/${id}`));
    expect(c).toMatchObject({ status: 'counting', round: 2 });
    const st = Object.fromEntries(c.items.map((l: any) => [l.productId, l]));
    expect(st[P('p10')]).toMatchObject({ state: 'approved' });
    expect(st[P('p8')]).toMatchObject({ state: 'counting', countedQty: null, prevCountedQty: '10', round: 2 });
  });

  it('only recount lines are editable; the recount is compared with snapshot + every move since the round opened', async () => {
    expect((await chai.post(`/api/stock-counts/${id}/entries`, { productId: P('p10'), qty: '1' })).status).toBe(409);
    await ok(chai.post(`/api/stock-counts/${id}/entries`, { productId: P('p8'), qty: '11' }));
    const c = await ok(chai.post(`/api/stock-counts/${id}/submit`));
    expect(c).toMatchObject({ status: 'submitted', review: 0 });
    expect(c.items.find((l: any) => l.productId === P('p8'))).toMatchObject({ systemQty: '12', movedQty: '-1', countedQty: '11', variance: '0', state: 'done' });
    expect((await chai.post(`/api/stock-counts/${id}/cancel`)).status).toBe(409);
  });

  it('สั่งนับใหม่ from the count page while under review takes the line out of the pending request', async () => {
    const c0 = await ok(chai.post('/api/stock-counts', { warehouseId: W('WH1'), category: 'เหล็ก' }), 201);
    await ok(chai.post(`/api/stock-counts/${c0.id}/entries`, { productId: P('p5'), qty: '80' }));
    const s = await ok(chai.post(`/api/stock-counts/${c0.id}/submit`));
    expect((await chai.post(`/api/stock-counts/${c0.id}/recount`, { productIds: [P('p5')] })).status).toBe(403); // under review: approver only
    const r = await ok(suda.post(`/api/stock-counts/${c0.id}/recount`, { productIds: [P('p5')], note: 'ตัวเลขแปลก' }));
    expect(r).toMatchObject({ status: 'counting', round: 2 });
    const rq = (await env.pool.query(`select status, lines from adjust_requests where id = $1`, [s.adjustRequestId])).rows[0];
    expect(rq.status).toBe('rejected');
    expect(rq.lines[0].state).toBe('recount');
    await ok(chai.post(`/api/stock-counts/${c0.id}/entries`, { productId: P('p5'), qty: '85' }));
    // while counting the counter may clear a counted line to count it again
    const again = await ok(chai.post(`/api/stock-counts/${c0.id}/recount`, { productIds: [P('p5')] }));
    expect(again.items[0]).toMatchObject({ countedQty: null, prevCountedQty: '85' });
    await ok(chai.post(`/api/stock-counts/${c0.id}/entries`, { productId: P('p5'), qty: '85' }));
    expect((await ok(chai.post(`/api/stock-counts/${c0.id}/submit`))).items[0]).toMatchObject({ variance: '0', state: 'done' });
    const audit = await env.pool.query(`select detail from audit_log where object = 'stock-count' and action = 'recount' order by id`);
    expect(audit.rows[0].detail).toContain('ตัวเลขแปลก');
  });

  it('self-approval is forbidden; every open line needs one decision', async () => {
    const rq = await ok(suda.post('/api/stock/adjust-requests', { warehouseId: W('WH1'), lines: [{ productId: P('p3'), qtyDelta: '-1' }, { productId: P('p2'), qtyDelta: '2' }], reason: 'x' }), 201);
    expect((await suda.post(`/api/stock/adjust-requests/${rq.id}/decide`, { approve: [P('p3')] })).body.details.reason).toBe('SELF_APPROVAL');
    expect((await owner.post(`/api/stock/adjust-requests/${rq.id}/decide`, { approve: [P('p3')], reject: [P('p3')] })).status).toBe(400);
    expect((await owner.post(`/api/stock/adjust-requests/${rq.id}/decide`, { recount: [P('p3')] })).status).toBe(400); // not from a count
    const before = await stockQty(env.pool, P('p2'), W('WH1'));
    const r = await ok(owner.post(`/api/stock/adjust-requests/${rq.id}/decide`, { approve: [P('p3')] })); // p2 left out → rejected
    expect(r.request.lines.map((l: any) => [l.productId, l.state])).toEqual([[P('p3'), 'approved'], [P('p2'), 'rejected']]);
    expect(await stockQty(env.pool, P('p2'), W('WH1'))).toBe(before);
  });
});
