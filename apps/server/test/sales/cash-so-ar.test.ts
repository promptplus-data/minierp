/** Round 4: cash sales order through to a paid invoice (ข้อ 4); AR of POS credit bills moved to a full INV and reduced by returns (ข้อ 9). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openShift, saleBody } from '../helpers';
import { apv, arOf, ok, setupSales, type SalesEnv } from './sales-helpers';

let env: SalesEnv;
let P: Record<string, string>;
let C: Record<string, string>;
let WH2: string;
let shift: string;
beforeAll(async () => {
  env = await setupSales();
  P = env.seed.products;
  C = env.seed.customers;
  WH2 = env.seed.warehouses.WH2!;
  shift = await openShift(env.prae);
});
afterAll(async () => { await env.close(); });

const deliver = (soNo: string, lines: { srcLineId: string; qty: string }[]) => ok(env.chai.post('/api/sales/deliveries', { soNo, lines }), 201);
const balanceOf = async (customer: string) => (await ok(env.boy.get(`/api/sales/customers/${customer}/credit`))).balance as string;
const statementOf = (customer: string) => ok(env.owner.get(`/api/ar/statement?customerId=${customer}`));
const agingOf = async (customer: string) => (await ok(env.owner.get('/api/ar/aging'))).items.find((x: any) => x.customer.id === customer);

describe('cash sales order (ข้อ 4)', () => {
  it('defaults to cash for a no-terms customer, skips the credit gate, invoices each partial delivery paid on the spot', async () => {
    // c3 buys on cash terms and has no tax ID
    const so = await ok(env.boy.post('/api/sales/orders', { customerId: C.c3, warehouseId: WH2, lines: [{ productId: P.p9!, qty: '4', unitPrice: '300' }], priceApproval: apv(env) }), 201);
    expect(so.term).toEqual({ t: 'cash' });
    const do1 = await deliver(so.no, [{ srcLineId: so.lines[0].id, qty: '1' }]);
    const list = await ok(env.boy.get('/api/sales/deliveries?status=unbilled'));
    expect(list.items.find((x: any) => x.no === do1.no).cashSale).toBe(true);

    // not paid = refused, and the refused attempt uses no invoice number (BR-04)
    const unpaid = await env.boy.post('/api/sales/invoices', { source: 'delivery', deliveryNos: [do1.no] });
    expect(unpaid.status).toBe(400);
    expect(unpaid.body.details).toMatchObject({ need: 'payment', field: 'payMethod' });
    const inv1 = await ok(env.boy.post('/api/sales/invoices', { source: 'delivery', deliveryNos: [do1.no], payMethod: 'promptpay' }), 201);
    expect(inv1).toMatchObject({ kind: 'cash', arBalance: '0.00', soNo: so.no, term: { t: 'cash' } });
    expect(inv1.doc.payments).toEqual([{ method: 'promptpay', amount: inv1.doc.totals.total }]);

    const do2 = await deliver(so.no, [{ srcLineId: so.lines[0].id, qty: '3' }]);
    const inv2 = await ok(env.boy.post('/api/sales/invoices', { source: 'delivery', deliveryNos: [do2.no], payments: [{ method: 'cash', amount: '600' }, { method: 'transfer', amount: String(Number(inv1.doc.totals.total) * 3 - 600) }] }), 201);
    expect(inv2.kind).toBe('cash');
    const seq = (no: string) => Number(no.split('-')[1]);
    expect(seq(inv2.doc.no)).toBe(seq(inv1.doc.no) + 1);
    expect((await ok(env.boy.get(`/api/sales/orders/${so.no}`))).dlvStatus).toBe('delivered');
    expect(await balanceOf(C.c3!)).toBe('0.00');
    expect(await agingOf(C.c3!)).toBeUndefined();
  });

  it('a cash order over the credit limit needs no credit approval; cash and credit orders are invoiced separately', async () => {
    // c2: limit 80,000; 107,000 on credit needs approval, on cash it does not
    const body = { customerId: C.c2, warehouseId: WH2, lines: [{ productId: P.p7!, qty: '80', unitPrice: '1250' }] };
    expect((await env.boy.post('/api/sales/orders', body)).status).toBe(403);
    const cashSo = await ok(env.boy.post('/api/sales/orders', { ...body, term: { t: 'cash' } }), 201);
    expect(cashSo.creditApproval).toBeNull();
    const creditSo = await ok(env.boy.post('/api/sales/orders', { ...body, lines: [{ productId: P.p7!, qty: '1', unitPrice: '1250' }] }), 201);
    const a = await deliver(cashSo.no, [{ srcLineId: cashSo.lines[0].id, qty: '1' }]);
    const b = await deliver(creditSo.no, [{ srcLineId: creditSo.lines[0].id, qty: '1' }]);
    const mixed = await env.boy.post('/api/sales/invoices', { source: 'delivery', deliveryNos: [a.no, b.no], payMethod: 'cash' });
    expect(mixed.status).toBe(400);
  });
});

describe('POS credit bill → full tax invoice keeps the receivable (ข้อ 9a)', () => {
  it('moves what is still owed, the term and the due date onto the INV; AR, aging and statement show it once', async () => {
    const before = await balanceOf(C.c1!);
    const sale = await ok(env.prae.post('/api/sales/pos', { ...saleBody(env.seed, shift, [{ p: 'p6', qty: '10', price: '89.00' }], '890.00'), customerId: C.c1, payments: [{ method: 'credit', amount: '890.00' }] }), 201);
    expect(sale.arBalance).toBe('890.00');
    // part paid at the AR desk first
    await ok(env.owner.post('/api/ar/receipts', { customerId: C.c1, method: 'transfer', lines: [{ invoiceNo: sale.no, amount: '200.00' }], wht: { mode: 'none' } }), 201);
    const due = (await env.pool.query<{ d: string }>(`select si.due_date::text d from sales_invoices si join docs x on x.id = si.doc_id where x.no = $1`, [sale.no])).rows[0]!.d;
    expect(await balanceOf(C.c1!)).toBe((Number(before) + 690).toFixed(2));

    expect((await env.boy.post('/api/sales/invoices/from-abb', { abbNo: sale.no, customerId: C.c2 })).status).toBe(400); // another customer
    const inv = await ok(env.boy.post('/api/sales/invoices/from-abb', { abbNo: sale.no, customerId: C.c1 }), 201);
    expect(inv).toMatchObject({ kind: 'credit', source: 'abb', arBalance: '690.00', term: { t: 'days', x: 30 } });
    expect(inv.dueDate).toBe(due);
    expect(await arOf(env, sale.no)).toBe('690.00'); // the voided ABB is out of every AR query (status void)
    expect(await balanceOf(C.c1!)).toBe((Number(before) + 690).toFixed(2));

    const st = await statementOf(C.c1!);
    const mine = st.lines.filter((l: any) => [sale.no, inv.doc.no].includes(l.no));
    expect(mine).toEqual([expect.objectContaining({ no: inv.doc.no, kind: 'INV', debit: '890.00' })]);
    const open = st.open.filter((o: any) => [sale.no, inv.doc.no].includes(o.no));
    expect(open).toEqual([expect.objectContaining({ no: inv.doc.no, arBalance: '690.00' })]);
    // statement closing = aging balance for the customer
    expect(st.closing).toBe((await agingOf(C.c1!)).balance);

    // voiding the receipt taken on the ABB gives the balance back to the replacing invoice
    const rc = (await ok(env.owner.get(`/api/ar/receipts?customerId=${C.c1}`))).items[0];
    await ok(env.owner.post(`/api/ar/receipts/${rc.no}/void`, { reason: 'โอนผิดบัญชี' }));
    expect(await arOf(env, inv.doc.no)).toBe('890.00');
    expect(await balanceOf(C.c1!)).toBe((Number(before) + 890).toFixed(2));
  });
});

describe('returns against a POS credit bill (ข้อ 9b)', () => {
  const creditSale = async (qty: string, total: string) =>
    ok(env.prae.post('/api/sales/pos', { ...saleBody(env.seed, shift, [{ p: 'p6', qty, price: '89.00' }], total), customerId: C.c1, payments: [{ method: 'credit', amount: total }] }), 201);
  const ret = (no: string, lineId: string, qty: string, refund: string) =>
    env.suda.post('/api/returns', { sourceDocNo: no, lines: [{ lineId, qty }], condition: 'good', refund, reason: 'ลูกค้าคืนของ' });

  it('reduces the open balance first, even when the refund is chosen as cash; no cash leaves the drawer', async () => {
    const sale = await creditSale('5', '445.00');
    const before = await balanceOf(C.c1!);
    const cn = await ok(ret(sale.no, sale.lines[0].id, '2', 'cash'), 201);
    expect(cn.totals.total).toBe('178.00');
    expect(cn.payments).toEqual([]);
    expect(await arOf(env, sale.no)).toBe('267.00');
    expect(await balanceOf(C.c1!)).toBe((Number(before) - 178).toFixed(2));
    const st = await statementOf(C.c1!);
    expect(st.lines.find((l: any) => l.no === cn.no)).toMatchObject({ kind: 'CN', credit: '178.00' });
    expect(st.closing).toBe((await agingOf(C.c1!)).balance);
  });

  it('only up to what is still owed: the rest is refunded, or kept as a customer credit on the statement', async () => {
    const sale = await creditSale('4', '356.00');
    await ok(env.owner.post('/api/ar/receipts', { customerId: C.c1, method: 'cash', lines: [{ invoiceNo: sale.no, amount: '300.00' }], wht: { mode: 'none' } }), 201);
    // 56 still owed; returning 2 × 89 = 178 → 56 off the bill, 122 transferred back
    const cn = await ok(ret(sale.no, sale.lines[0].id, '2', 'transfer'), 201);
    expect(cn.payments).toEqual([{ method: 'transfer', amount: '122.00' }]);
    expect(await arOf(env, sale.no)).toBe('0.00');

    // nothing owed any more: the next return as "credit" becomes a customer credit (statement goes down by the full amount)
    const st0 = await statementOf(C.c1!);
    const cn2 = await ok(ret(sale.no, sale.lines[0].id, '1', 'credit'), 201);
    expect(cn2.payments).toEqual([]);
    expect(await arOf(env, sale.no)).toBe('0.00');
    const st1 = await statementOf(C.c1!);
    expect(st1.lines.find((l: any) => l.no === cn2.no)).toMatchObject({ credit: '89.00' });
    expect((Number(st0.closing) - Number(st1.closing)).toFixed(2)).toBe('89.00');
  });

  it('a cash bill (nothing owed) cannot be refunded as customer credit', async () => {
    const sale = await ok(env.prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00')), 201);
    const r = await ret(sale.no, sale.lines[0].id, '1', 'credit');
    expect(r.status).toBe(409);
  });
});
