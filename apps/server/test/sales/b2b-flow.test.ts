/**
 * Whole B2B chain with stock before / after: QT (BR-05 prices, source per line) → SO (quoted prices carried, links
 * both ways) → two partial DOs (FIFO cut from the SO warehouse) → INV from the DOs → billing note → receipt (AR 0).
 * Plus: price / discount approval with reason, QT below-cost approval carried into the SO, line check (cost only for
 * data.cost), customer address book, notes on every document.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lotsOf, stockQty } from '../helpers';
import { apv, arOf, ok, pin, setupSales, type SalesEnv } from './sales-helpers';

let env: SalesEnv;
let P: Record<string, string>;
let C: Record<string, string>;
let WH2: string;
beforeAll(async () => {
  env = await setupSales();
  P = env.seed.products;
  C = env.seed.customers;
  WH2 = env.seed.warehouses.WH2!;
});
afterAll(async () => { await env.close(); });

const priceOf = (customerId: string, productId: string, qty: string, doc: 'quote' | 'order' = 'quote') =>
  ok(env.boy.get(`/api/sales/price?customerId=${customerId}&productId=${productId}&qty=${qty}&vatMode=exc&doc=${doc}`));

describe('QT → SO → DO (partial, FIFO) → INV → billing note → receipt', () => {
  const s: Record<string, any> = {};

  it('quotation lines get the BR-05 price with its source; the note is stored', async () => {
    const p1 = await priceOf(C.c1!, P.p1!, '120');
    const p6 = await priceOf(C.c1!, P.p6!, '10');
    expect(p1).toMatchObject({ source: 'customerList', ref: 'PL-C00001' });
    const q = await ok(env.boy.post('/api/sales/quotations', {
      customerId: C.c1, vatMode: 'exc', note: 'ส่งฟรีในเขตอำเภอ', status: 'sent',
      lines: [{ productId: P.p1!, qty: '120', unitPrice: p1.unitPrice }, { productId: P.p6!, qty: '10', unitPrice: p6.unitPrice }],
    }), 201);
    expect(q.note).toBe('ส่งฟรีในเขตอำเภอ');
    expect(q.lines[0]).toMatchObject({ unitPrice: p1.unitPrice, listPrice: p1.unitPrice, priceSource: 'customerList', priceRef: 'PL-C00001' });
    expect(q.priceApproval).toBeNull();
    s.q = q;
  });

  it('converting carries the quoted prices; QT ↔ SO linked both ways', async () => {
    const q = s.q;
    const so = await ok(env.boy.post('/api/sales/orders', {
      customerId: C.c1, quoteNo: q.no, warehouseId: WH2, note: 'โทรก่อนส่ง', shipTo: 'หน้างานสันทราย',
      lines: q.lines.map((l: any) => ({ productId: l.productId, unitIdx: l.unitIdx, qty: l.qty, unitPrice: l.unitPrice, quoteLineId: l.id })),
    }), 201);
    expect(so.quoteNo).toBe(q.no);
    expect(so.note).toBe('โทรก่อนส่ง');
    expect(so.lines.map((l: any) => [l.unitPrice, l.priceSource, l.priceRef])).toEqual(q.lines.map((l: any) => [l.unitPrice, 'quote', q.no]));
    const qAfter = await ok(env.boy.get(`/api/sales/quotations/${q.no}`));
    expect(qAfter.orders.map((o: any) => o.no)).toEqual([so.no]);
    expect(qAfter.status).toBe('accepted');
    s.so = so;
  });

  it('two partial delivery orders cut stock FIFO from the order warehouse', async () => {
    const so = s.so;
    const before1 = await stockQty(env.pool, P.p1!, WH2);
    const before6 = await stockQty(env.pool, P.p6!, WH2);
    const lotsBefore = await lotsOf(env.pool, P.p1!, WH2);
    const d1 = await ok(env.chai.post('/api/sales/deliveries', { soNo: so.no, note: 'รอบแรก', lines: [{ srcLineId: so.lines[0].id, qty: '70' }] }), 201);
    expect(d1.note).toBe('รอบแรก');
    expect(d1.cutsStock).toBe(true);
    expect(d1.warehouse.id).toBe(WH2);
    expect(await stockQty(env.pool, P.p1!, WH2)).toBe(before1 - 70);
    expect(await stockQty(env.pool, P.p6!, WH2)).toBe(before6);
    // FIFO: the oldest lot with stock is taken first
    const lotsAfter = await lotsOf(env.pool, P.p1!, WH2);
    const firstWithStock = lotsBefore.findIndex((l) => Number(l.remaining) > 0);
    expect(Number(lotsAfter[firstWithStock]!.remaining)).toBe(Math.max(0, Number(lotsBefore[firstWithStock]!.remaining) - 70));
    expect((await ok(env.boy.get(`/api/sales/orders/${so.no}`))).dlvStatus).toBe('partial');

    const d2 = await ok(env.chai.post('/api/sales/deliveries', { soNo: so.no, lines: [{ srcLineId: so.lines[0].id, qty: '50' }, { srcLineId: so.lines[1].id, qty: '10' }] }), 201);
    expect(await stockQty(env.pool, P.p1!, WH2)).toBe(before1 - 120);
    expect(await stockQty(env.pool, P.p6!, WH2)).toBe(before6 - 10);
    const o = await ok(env.boy.get(`/api/sales/orders/${so.no}`));
    expect(o.dlvStatus).toBe('delivered');
    expect(o.deliveries.map((x: any) => x.no)).toEqual([d1.no, d2.no]);
    // the stock moves point at the delivery orders
    const mv = await env.pool.query(`select count(*)::int n from stock_moves where doc_no = any($1::text[])`, [[d1.no, d2.no]]);
    expect(mv.rows[0].n).toBeGreaterThanOrEqual(2);
    s.d1 = d1; s.d2 = d2;
  });

  it('one tax invoice from both deliveries (note on sales_invoices); AR = total; billing note; receipt clears it', async () => {
    const inv = await ok(env.boy.post('/api/sales/invoices', { source: 'delivery', deliveryNos: [s.d1.no, s.d2.no], note: 'อ้างอิง PO 778' }), 201);
    expect(inv.note).toBe('อ้างอิง PO 778');
    expect(inv.soNo).toBe(s.so.no);
    expect(inv.deliveries).toEqual([s.d1.no, s.d2.no]);
    expect(inv.doc.totals.total).toBe(s.so.totals.total);
    expect(await arOf(env, inv.doc.no)).toBe(inv.doc.totals.total);
    const o = await ok(env.boy.get(`/api/sales/orders/${s.so.no}`));
    expect(o.invoices.map((x: any) => x.no)).toEqual([inv.doc.no]);

    const bn = await ok(env.owner.post('/api/ar/billing-notes', { customerId: C.c1, invoiceNos: [inv.doc.no], note: 'วางบิลรอบสิ้นเดือน' }), 201);
    expect(bn.note).toBe('วางบิลรอบสิ้นเดือน');
    const rc = await ok(env.owner.post('/api/ar/receipts', { customerId: C.c1, method: 'transfer', note: 'โอนเข้า กสิกร', lines: [{ invoiceNo: inv.doc.no, amount: inv.doc.totals.total }] }), 201);
    expect(rc.note).toBe('โอนเข้า กสิกร');
    expect(await arOf(env, inv.doc.no)).toBe('0.00');
    const after = await ok(env.boy.get(`/api/sales/invoices/${inv.doc.no}`));
    expect(after.billingNotes.map((x: any) => x.no)).toEqual([bn.no]);
    expect(after.receipts.map((x: any) => x.no)).toEqual([rc.no]);
  });
});

describe('price / discount approval and below cost (server is the authority)', () => {
  it('a price below the BR-05 price needs a manager PIN with a reason (sales role); the manager herself is only logged', async () => {
    const body = { customerId: C.c3, warehouseId: WH2, term: { t: 'cash' }, lines: [{ productId: P.p6!, qty: '2', unitPrice: '70' }] };
    const r = await env.boy.post('/api/sales/orders', body);
    expect(r.status).toBe(403);
    expect(r.body.details).toMatchObject({ need: 'priceApproval', priceChanged: true });
    expect((await env.boy.post('/api/sales/orders', { ...body, priceApproval: { ...pin(env), reason: '' } })).status).toBe(400);
    expect((await env.boy.post('/api/sales/orders', { ...body, priceApproval: { ...pin(env, 'boy'), reason: 'x' } })).body.details.approvalError).toBe('SELF_APPROVAL');
    const so = await ok(env.boy.post('/api/sales/orders', { ...body, priceApproval: apv(env) }), 201);
    expect(so.priceApproval.detail).toContain('เหตุผล: ราคาพิเศษ');
    expect(so.priceApproval.by).toBe('คุณสุดา ศรีสุข');
    const audit = await env.pool.query(`select detail from audit_log where ref = $1 and object = 'discount'`, [so.no]);
    expect(audit.rows[0]?.detail ?? '').toContain('อนุมัติโดย คุณสุดา');
    const own = await ok(env.suda.post('/api/sales/orders', body), 201); // pos.price = 1
    expect(own.priceApproval).toBeNull();
    // raising the price is free
    await ok(env.boy.post('/api/sales/orders', { ...body, lines: [{ productId: P.p6!, qty: '2', unitPrice: '200' }] }), 201);
  });

  it('a discount over the role cap (sales 10 %) needs the PIN', async () => {
    const p = await priceOf(C.c3!, P.p6!, '10', 'order');
    const body = { customerId: C.c3, warehouseId: WH2, term: { t: 'cash' }, lines: [{ productId: P.p6!, qty: '10', unitPrice: p.unitPrice, discount: { kind: 'pct', value: '15' } }] };
    const r = await env.boy.post('/api/sales/orders', body);
    expect(r.status).toBe(403);
    expect(r.body.details).toMatchObject({ need: 'priceApproval', overCap: true, cap: 10, pct: '15' });
    await ok(env.boy.post('/api/sales/orders', { ...body, priceApproval: apv(env) }), 201);
  });

  it('a quotation approved below cost converts without a second approval; a changed price is checked again', async () => {
    const lines = [{ productId: P.p1!, qty: '5', unitPrice: '50' }];
    const q = await ok(env.boy.post('/api/sales/quotations', { customerId: C.c3, vatMode: 'exc', lines, priceApproval: apv(env), belowCostApproval: pin(env, 'charoen') }), 201);
    expect(q.belowCostApproval.detail).toContain('คุณเจริญ');
    const base = { customerId: C.c3, quoteNo: q.no, warehouseId: WH2, term: { t: 'cash' } };
    const so = await ok(env.boy.post('/api/sales/orders', { ...base, lines: [{ productId: P.p1!, qty: '5', unitPrice: '50', quoteLineId: q.lines[0].id }] }), 201);
    expect(so.belowCostApproval.detail).toContain('อนุมัติแล้วในใบเสนอราคา');
    expect(so.priceApproval).toBeNull(); // the quoted price is the expected price
    await ok(env.owner.post(`/api/sales/orders/${so.no}/void`, { reason: 'ทดสอบ' }));
    const r = await env.boy.post('/api/sales/orders', { ...base, lines: [{ productId: P.p1!, qty: '5', unitPrice: '40', quoteLineId: q.lines[0].id }], priceApproval: apv(env) });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('BELOW_COST');
  });

  it('line check: below cost for everyone, cost and profit only for data.cost users', async () => {
    const body = { vatMode: 'exc', warehouseId: WH2, lines: [{ productId: P.p1!, qty: '2', unitPrice: '10' }, { qty: '1', unitPrice: '5' }, { productId: P.p6!, qty: '1', unitPrice: '500' }] };
    const boy = await ok(env.boy.post('/api/sales/line-check', body));
    expect(boy.lines.map((l: any) => l.belowCost)).toEqual([true, false, false]);
    expect(boy.lines[0].unitCost).toBeNull();
    expect(boy.profit).toBeNull();
    const own = await ok(env.owner.post('/api/sales/line-check', body));
    expect(Number(own.lines[0].unitCost)).toBeGreaterThan(10);
    expect(Number(own.lines[0].profit)).toBeLessThan(0);
    expect(Number(own.lines[2].profit)).toBeGreaterThan(0);
    expect(own.profit).toMatchObject({ revenue: '520.00' });
    expect((await env.prae.post('/api/sales/line-check', body)).status).toBe(403);
  });
});

describe('customer address book and notes', () => {
  it('lists the customer address and saved ones; saving twice keeps one row', async () => {
    await env.pool.query(`update customers set address = '99 ถ.เชียงใหม่-ลำปาง' where id = $1`, [C.c2]);
    const a = await ok(env.boy.post(`/api/sales/customers/${C.c2}/addresses`, { address: 'โกดัง 2 ซ.วัดเกต' }), 201);
    const b = await ok(env.boy.post(`/api/sales/customers/${C.c2}/addresses`, { address: ' โกดัง 2   ซ.วัดเกต ' }), 201);
    expect(b.id).toBe(a.id);
    const list = await ok(env.boy.get(`/api/sales/customers/${C.c2}/addresses`));
    expect(list.items.map((x: any) => [x.kind, x.address])).toEqual(expect.arrayContaining([['customer', '99 ถ.เชียงใหม่-ลำปาง'], ['saved', 'โกดัง 2 ซ.วัดเกต']]));
    expect((await env.prae.post(`/api/sales/customers/${C.c2}/addresses`, { address: 'x' })).status).toBe(403);
    // tenant isolation (RLS): the table is forced
    const rls = await env.pool.query(`select relforcerowsecurity f from pg_class where relname = 'customer_addresses'`);
    expect(rls.rows[0].f).toBe(true);
  });

  it('project and deposit notes are stored and returned', async () => {
    const so = await ok(env.boy.post('/api/sales/orders', {
      customerId: C.c3, warehouseId: WH2, term: { t: 'cash' }, lines: [{ productId: P.p6!, qty: '1', unitPrice: '200' }],
      project: { mode: 'new', name: 'บ้านคุณเอ', template: '100%', note: 'เข้าหน้างานหลัง 8 โมง' },
    }), 201);
    const pj = await ok(env.boy.get(`/api/sales/projects/${so.project.id}`));
    expect(pj.note).toBe('เข้าหน้างานหลัง 8 โมง');
    const after = await ok(env.boy.post(`/api/sales/projects/${so.project.id}/deposits`, { type: 'guarantee', amount: '50', method: 'cash', note: 'มัดจำงานรั้ว' }), 201);
    expect(after.deposits[0].note).toBe('มัดจำงานรั้ว');
  });

  it('salespeople picker lists active sales staff', async () => {
    const r = await ok(env.boy.get('/api/sales/salespeople'));
    expect(r.items.map((x: any) => x.name)).toEqual(expect.arrayContaining(['คุณสุดา ศรีสุข']));
    expect(r.items[0].role).toBe('sales');
  });
});
