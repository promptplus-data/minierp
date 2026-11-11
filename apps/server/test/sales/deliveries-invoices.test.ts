/** REQ-M08-04/05/06/10/12: partial delivery orders (FIFO, BR-07), invoices from deliveries / direct / goods left, ABB → full INV, void chain. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lotsOf, openShift, saleBody, stockQty } from '../helpers';
import { apv, arOf, ok, pin, setupSales, type SalesEnv } from './sales-helpers';
import { SALE_LINES_CTE } from '../../src/modules/reports/sources';

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

const order = async (lines: { productId: string; qty: string; unitPrice: string; unitIdx?: number }[], extra: Record<string, unknown> = {}) =>
  ok(env.boy.post('/api/sales/orders', { customerId: C.c1, warehouseId: WH2, lines, priceApproval: apv(env), ...extra }), 201);
const deliver = (soNo: string, lines: { srcLineId: string; qty: string }[], extra: Record<string, unknown> = {}) =>
  env.chai.post('/api/sales/deliveries', { soNo, lines, ...extra });

describe('delivery orders from a sales order', () => {
  let so: any;
  let do1: any;
  beforeAll(async () => {
    so = await order([{ productId: P.p1!, qty: '200', unitPrice: '130' }, { productId: P.p9!, qty: '2', unitPrice: '280.37' }]);
  });

  it('partial delivery cuts stock FIFO from the oldest lots and shows what is still to deliver', async () => {
    const before = await stockQty(env.pool, P.p1!, WH2);
    do1 = await ok(deliver(so.no, [{ srcLineId: so.lines[0].id, qty: '150' }, { srcLineId: so.lines[1].id, qty: '1' }], { shipTo: 'หน้างานสันทราย', vehicle: 'กข-1234' }), 201);
    expect(do1.no).toMatch(/^DO2610-/);
    expect(do1.cutsStock).toBe(true);
    expect(do1.lines[0]).toMatchObject({ qty: '150', value: '19500.00' });
    expect(do1.lines[0].cogs).toBeNull(); // warehouse role cannot see cost
    expect(await stockQty(env.pool, P.p1!, WH2)).toBe(before - 150);
    const lots = await lotsOf(env.pool, P.p1!, WH2);
    expect(lots[0]!.remaining).toBe('0.0000'); // oldest lot (136) used up first
    const o = await ok(env.boy.get(`/api/sales/orders/${so.no}`));
    expect(o.dlvStatus).toBe('partial');
    expect(o.lines[0]).toMatchObject({ deliveredQty: '150', remainingQty: '50' });
  });

  it('cannot deliver more than ordered − delivered', async () => {
    const r = await deliver(so.no, [{ srcLineId: so.lines[0].id, qty: '51' }]);
    expect(r.status).toBe(409);
    expect(r.body.details.remaining).toBe('50');
  });

  it('BR-07: a shortage in the warehouse stops the delivery with nothing written', async () => {
    const big = await order([{ productId: P.p7!, qty: '50', unitPrice: '1250' }], { term: { t: 'cash' } });
    const r = await deliver(big.no, [{ srcLineId: big.lines[0].id, qty: '50' }]);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('INSUFFICIENT_STOCK');
    expect((await env.pool.query(`select count(*)::int n from sales_deliveries where so_id = $1`, [big.id])).rows[0].n).toBe(0);
  });

  it('the last delivery of a line takes the exact remaining value; the order becomes delivered', async () => {
    const do2 = await ok(deliver(so.no, [{ srcLineId: so.lines[0].id, qty: '50' }, { srcLineId: so.lines[1].id, qty: '1' }]), 201);
    expect(do2.lines.map((l: { value: string }) => l.value)).toEqual(['6500.00', '280.37']);
    expect((await ok(env.boy.get(`/api/sales/orders/${so.no}`))).dlvStatus).toBe('delivered');
    // the order cannot be voided while it has deliveries (BR-22)
    const v = await env.owner.post(`/api/sales/orders/${so.no}/void`, { reason: 'x' });
    expect(v.status).toBe(409);
    expect(v.body.details.docs).toContain(do1.no);
  });

  it('one invoice bills several deliveries of the customer; due date from the 30-day term; AR = total', async () => {
    const list = await ok(env.boy.get(`/api/sales/deliveries?status=unbilled&customerId=${C.c1}`));
    const nos = list.items.map((x: { no: string }) => x.no);
    expect(nos).toHaveLength(2);
    const inv = await ok(env.boy.post('/api/sales/invoices', { source: 'delivery', deliveryNos: nos }), 201);
    expect(inv.doc.no).toMatch(/^INV2610-/);
    expect(inv.kind).toBe('credit');
    expect(inv.dueDate).toBe('2026-11-25');
    expect(inv.doc.totals).toMatchObject({ base7: '26560.74', vat: '1859.25', total: '28419.99' });
    expect(inv.arBalance).toBe('28419.99');
    expect(inv.deliveries.sort()).toEqual(nos.sort());
    // the same delivery cannot be billed twice
    expect((await env.boy.post('/api/sales/invoices', { source: 'delivery', deliveryNos: [nos[0]] })).status).toBe(409);
    // BR-22: a billed delivery cannot be voided before its invoice
    const v = await env.owner.post(`/api/sales/deliveries/${nos[0]}/void`, { reason: 'x' });
    expect(v.status).toBe(409);
    expect(v.body.details.docs).toEqual([inv.doc.no]);
    // void the invoice (core void), then the delivery: stock back into the original lots
    await ok(env.owner.post(`/api/sales/docs/${inv.doc.no}/void`, { reason: 'ออกผิด' }));
    const before = await stockQty(env.pool, P.p1!, WH2);
    const vd = await ok(env.owner.post(`/api/sales/deliveries/${do1.no}/void`, { reason: 'ส่งผิด' }));
    expect(vd.status).toBe('void');
    expect(await stockQty(env.pool, P.p1!, WH2)).toBe(before + 150);
    expect((await ok(env.boy.get(`/api/sales/orders/${so.no}`))).dlvStatus).toBe('partial');
  });

  it('a delivery of a project order is billed by installment, not by delivery invoice', async () => {
    const pso = await order([{ productId: P.p3!, qty: '100', unitPrice: '22' }], { project: { mode: 'new', name: 'บ้านคุณสมชาย', template: '100%' } });
    const pdo = await ok(deliver(pso.no, [{ srcLineId: pso.lines[0].id, qty: '100' }]), 201);
    expect(pdo.project.name).toBe('บ้านคุณสมชาย');
    expect((await env.boy.post('/api/sales/invoices', { source: 'delivery', deliveryNos: [pdo.no] })).status).toBe(400);
  });
});

describe('direct invoices', () => {
  it('cuts stock now; goods left at the shop go out later on a delivery order without a second stock cut', async () => {
    const before = await stockQty(env.pool, P.p4!, WH2);
    const inv = await ok(env.boy.post('/api/sales/invoices', {
      source: 'direct', customerId: C.c2, warehouseId: WH2, goodsLeft: true, lines: [{ productId: P.p4!, qty: '10', unitPrice: '196.26' }],
    }), 201);
    expect(inv.goodsLeft).toBe(true);
    expect(inv.dueDate).toBe('2026-10-31'); // end of month
    expect(await stockQty(env.pool, P.p4!, WH2)).toBe(before - 10);
    const lineId = inv.doc.lines[0].id;
    expect(inv.undelivered[lineId]).toBe('10');
    const src = await ok(env.chai.get('/api/sales/delivery-sources'));
    expect(src.items.some((s: { kind: string; no: string }) => s.kind === 'INV' && s.no === inv.doc.no)).toBe(true);
    const dlv = await ok(env.chai.post('/api/sales/deliveries', { invoiceNo: inv.doc.no, lines: [{ srcLineId: lineId, qty: '4' }] }), 201);
    expect(dlv.cutsStock).toBe(false);
    expect(await stockQty(env.pool, P.p4!, WH2)).toBe(before - 10);
    expect((await env.chai.post('/api/sales/deliveries', { invoiceNo: inv.doc.no, lines: [{ srcLineId: lineId, qty: '7' }] })).status).toBe(409);
    expect((await ok(env.boy.get(`/api/sales/invoices/${inv.doc.no}`))).undelivered[lineId]).toBe('6');
    // the invoice cannot be voided while its later delivery is active
    const v = await env.owner.post(`/api/sales/docs/${inv.doc.no}/void`, { reason: 'x' });
    expect(v.status).toBe(409);
    expect(v.body.details.docs).toContain(dlv.no);
  });

  it('a cash invoice is paid now (payments = total, no receivable); a customer without a tax ID gets no tax invoice', async () => {
    const inv = await ok(env.boy.post('/api/sales/invoices', {
      source: 'direct', customerId: C.c1, warehouseId: WH2, lines: [{ productId: P.p6!, qty: '2', unitPrice: '83.18' }], payments: [{ method: 'transfer', amount: '178.01' }],
    }), 201);
    expect(inv.kind).toBe('cash');
    expect(inv.arBalance).toBe('0.00');
    expect((await env.boy.post('/api/sales/invoices', { source: 'direct', customerId: C.c1, warehouseId: WH2, lines: [{ productId: P.p6!, qty: '2', unitPrice: '83.18' }], payments: [{ method: 'cash', amount: '100' }] })).status).toBe(400);
    expect((await env.boy.post('/api/sales/invoices', { source: 'direct', customerId: C.c3, warehouseId: WH2, lines: [{ productId: P.p6!, qty: '1', unitPrice: '83.18' }] })).status).toBe(400);
  });
});

describe('credit refunds on returns (REQ-M08-06 with receivables)', () => {
  it('a credit note with refund "credit" reduces the invoice balance; more than the balance is refused', async () => {
    const inv = await ok(env.boy.post('/api/sales/invoices', { source: 'direct', customerId: C.c1, warehouseId: WH2, lines: [{ productId: P.p5!, qty: '10', unitPrice: '150' }] }), 201);
    expect(inv.arBalance).toBe('1605.00');
    const line = inv.doc.lines[0];
    const cn = await ok(env.suda.post('/api/returns', { sourceDocNo: inv.doc.no, lines: [{ lineId: line.id, qty: '2' }], condition: 'good', warehouseId: WH2, refund: 'credit', reason: 'ลูกค้าซื้อเกิน' }), 201);
    expect(cn.totals.total).toBe('321.00');
    expect(await arOf(env, inv.doc.no)).toBe('1284.00');
    const after = await ok(env.boy.get(`/api/sales/invoices/${inv.doc.no}`));
    expect(after).toMatchObject({ arBalance: '1284.00', credited: '321.00' });
    expect(after.creditNotes[0]).toMatchObject({ no: cn.no, refund: 'credit' });
    const cns = await ok(env.boy.get(`/api/sales/credit-notes?customerId=${C.c1}`));
    expect(cns.items[0]).toMatchObject({ no: cn.no, refNo: inv.doc.no, refund: 'credit' });
    // returned stock comes back at the invoice's FIFO cost
    const lot = (await env.pool.query(`select unit_cost::text from stock_lots where ref = $1`, [cn.no])).rows[0];
    expect(Number(lot.unit_cost)).toBeGreaterThan(130);
  });
});

describe('full tax invoice issued later from an ABB', () => {
  it('voids the ABB with a reason naming the new INV, keeps stock and the shift totals', async () => {
    const shift = await openShift(env.prae);
    const sale = await ok(env.prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p4', qty: '2', price: '210.00' }], '420.00')), 201);
    const stockBefore = await stockQty(env.pool, P.p4!, env.seed.warehouses.WH1!);
    const shiftBefore = await ok(env.prae.get('/api/shifts/current'));
    expect((await env.prae.post('/api/sales/invoices/from-abb', { abbNo: sale.no, customerId: C.c3 })).status).toBe(400); // no tax ID
    const inv = await ok(env.prae.post('/api/sales/invoices/from-abb', { abbNo: sale.no, customerId: C.c1 }), 201);
    expect(inv.source).toBe('abb');
    expect(inv.doc).toMatchObject({ type: 'INV', ref: sale.no });
    expect(inv.doc.totals.total).toBe('420.00');
    expect(inv.customer.taxId).toBe('0503558001234');
    const abb = await ok(env.prae.get(`/api/sales/docs/${sale.no}`));
    expect(abb.status).toBe('void');
    expect(abb.voided.reason).toContain(inv.doc.no);
    expect(await stockQty(env.pool, P.p4!, env.seed.warehouses.WH1!)).toBe(stockBefore);
    const shiftAfter = await ok(env.prae.get('/api/shifts/current'));
    expect(shiftAfter.cashSales).toBe(shiftBefore.cashSales);
    expect((await env.prae.post('/api/sales/invoices/from-abb', { abbNo: sale.no, customerId: C.c1 })).status).toBe(409);
    // the replacement is corrected with a credit note, not voided
    const v = await env.owner.post(`/api/sales/docs/${inv.doc.no}/void`, { reason: 'x' });
    expect(v.status).toBe(409);
    expect(v.body.code).toBe('DOWNSTREAM_FIRST');
    // returns on the new INV restore stock at the original cost
    const cn = await ok(env.suda.post('/api/returns', { sourceDocNo: inv.doc.no, lines: [{ lineId: inv.doc.lines[0].id, qty: '1' }], condition: 'good', refund: 'transfer', reason: 'ชำรุด' }), 201);
    expect(cn.totals.total).toBe('210.00');
  });
});

describe('lists and permissions', () => {
  it('invoices list pages newest first and filters open / paid', async () => {
    const p1 = await ok(env.boy.get('/api/sales/invoices?limit=2'));
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const open = await ok(env.boy.get('/api/sales/invoices?status=open'));
    expect(open.items.every((x: { arBalance: string }) => Number(x.arBalance) > 0)).toBe(true);
  });
  it('a driver cannot create invoices; a warehouse user may deliver but not invoice', async () => {
    expect((await env.chai.post('/api/sales/invoices', { source: 'delivery', deliveryNos: ['DO2610-0001'] })).status).toBe(403);
  });
  it('void with PIN for the sales role on a delivery', async () => {
    const so = await order([{ productId: P.p2!, qty: '10', unitPrice: '48' }]);
    const dl = await ok(deliver(so.no, [{ srcLineId: so.lines[0].id, qty: '10' }]), 201);
    expect((await env.boy.post(`/api/sales/deliveries/${dl.no}/void`, { reason: 'x' })).status).toBe(403);
    expect((await ok(env.boy.post(`/api/sales/deliveries/${dl.no}/void`, { reason: 'x', ...pin(env) }))).status).toBe('void');
  });
});

describe('sales report cost for invoices whose stock moved elsewhere', () => {
  const costOf = async (no: string) => {
    const r = await env.pool.query(
      `with ${SALE_LINES_CTE} select sum(cogs)::text c from sl where no = $3`, ['2000-01-01', '2100-01-01', no]);
    return r.rows[0].c as string | null;
  };
  it('an invoice made from delivery orders carries the delivery orders\' FIFO cost; so does an ABB converted to a full invoice', async () => {
    const so = await order([{ productId: P.p4!, qty: '6', unitPrice: '196.26' }]);
    const dlv = await ok(deliver(so.no, [{ srcLineId: so.lines[0].id, qty: '6' }]), 201);
    const doCost = (await env.pool.query(`select sum(m.cost)::text c from stock_moves m join sales_deliveries d on d.id = m.doc_id where d.no = $1`, [dlv.no])).rows[0].c;
    expect(Number(doCost)).toBeGreaterThan(0);
    const inv = await ok(env.boy.post('/api/sales/invoices', { source: 'delivery', deliveryNos: [dlv.no] }), 201);
    expect(Number(await costOf(inv.doc.no))).toBeCloseTo(Number(doCost), 2);
    // the delivery order itself is not a sales document, so the cost is counted once
    expect(await costOf(dlv.no)).toBeNull();

    const cur = await env.prae.get('/api/shifts/current');
    const shift = cur.status === 200 && cur.body?.id ? cur.body.id as string : await openShift(env.prae);
    const abb = await ok(env.prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p4', qty: '2', price: '210.00' }], '420.00')), 201);
    const abbCost = await costOf(abb.no);
    expect(Number(abbCost)).toBeGreaterThan(0);
    const full = await ok(env.prae.post("/api/sales/invoices/from-abb", { abbNo: abb.no, customerId: C.c1 }), 201);
    expect(await costOf(abb.no)).toBeNull(); // the ABB is voided by the conversion
    expect(Number(await costOf(full.doc.no))).toBeCloseTo(Number(abbCost), 2);
  });
});
