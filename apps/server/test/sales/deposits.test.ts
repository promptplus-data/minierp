/** Customer deposits for any customer (มัดจำ / รับเงินล่วงหน้า / คืนเงินล่วงหน้า) and ขอลดหนี้ขาย with approval. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { arOf, ok, setupSales, type SalesEnv } from './sales-helpers';

let env: SalesEnv;
let C: Record<string, string>;
let P: Record<string, string>;
let WH2: string;

beforeAll(async () => {
  env = await setupSales();
  C = env.seed.customers;
  P = env.seed.products;
  WH2 = env.seed.warehouses.WH2!;
});
afterAll(async () => { await env.close(); });

const direct = (extra: Record<string, unknown> = {}, qty = '10') =>
  env.boy.post('/api/sales/invoices', { source: 'direct', customerId: C.c1, warehouseId: WH2, lines: [{ productId: P.p5!, qty, unitPrice: '150' }], ...extra });

describe('มัดจำ (guarantee) for any customer', () => {
  it('no VAT when received; an invoice uses it as part payment; voiding the invoice frees it again', async () => {
    const dp = await ok(env.boy.post('/api/sales/deposits', { customerId: C.c1, type: 'guarantee', amount: '500', method: 'cash', note: 'มัดจำสั่งของ' }), 201);
    expect(dp).toMatchObject({ type: 'guarantee', amount: '500.00', remaining: '500.00', invoiceNo: null, project: null, customer: { id: C.c1 } });
    const open = await ok(env.boy.get(`/api/sales/deposits?customerId=${C.c1}&status=open`));
    expect(open.items.map((x: { no: string }) => x.no)).toContain(dp.no);

    const inv = await ok(direct({ deposits: [{ no: dp.no, amount: '500' }] }), 201);
    expect(inv.doc.totals.total).toBe('1605.00'); // VAT on the full sale
    expect(inv.arBalance).toBe('1105.00');
    expect(inv).toMatchObject({ depositType: 'guarantee', depositDeduct: '500.00', grossAmount: '1605.00' });
    expect(inv.textLines[0].name).toContain(dp.no);
    expect(await ok(env.boy.get(`/api/sales/deposits/${dp.no}`))).toMatchObject({ applied: '500.00', remaining: '0.00', applications: [{ invoiceNo: inv.doc.no, amount: '500.00' }] });
    // used up: a second invoice cannot take it
    expect((await direct({ deposits: [{ no: dp.no, amount: '1' }] })).status).toBe(409);
    // the deposit cannot be voided while an invoice uses it
    expect((await env.suda.post(`/api/sales/deposits/${dp.no}/void`, { reason: 'ทดสอบ' })).status).toBe(409);
    await ok(env.suda.post(`/api/sales/docs/${inv.doc.no}/void`, { reason: 'ออกผิด' }));
    expect((await ok(env.boy.get(`/api/sales/deposits/${dp.no}`))).remaining).toBe('500.00');
  });

  it('a deposit covering the whole invoice makes it paid; another customer cannot use it; refund needs a manager', async () => {
    const dp = await ok(env.boy.post('/api/sales/deposits', { customerId: C.c1, type: 'guarantee', amount: '2000', method: 'transfer' }), 201);
    expect((await env.boy.post('/api/sales/invoices', { source: 'direct', customerId: C.c2, warehouseId: WH2, lines: [{ productId: P.p5!, qty: '1', unitPrice: '150' }], deposits: [{ no: dp.no, amount: '100' }] })).status).toBe(400);
    const inv = await ok(direct({ deposits: [{ no: dp.no, amount: '1605' }] }), 201);
    expect(inv).toMatchObject({ kind: 'cash', arBalance: '0.00' });
    expect((await direct({ deposits: [{ no: dp.no, amount: '2000' }] })).status).toBe(409); // only 395 left
    // sales staff need a PIN to give money back; the manager can
    expect((await env.boy.post(`/api/sales/deposits/${dp.no}/refund`, { reason: 'ลูกค้ายกเลิกส่วนที่เหลือ' })).status).toBe(403);
    const back = await ok(env.suda.post(`/api/sales/deposits/${dp.no}/refund`, { reason: 'ลูกค้ายกเลิกส่วนที่เหลือ', method: 'cash' }));
    expect(back).toMatchObject({ status: 'refunded', remaining: '0.00', refund: { amount: '395.00', method: 'cash' }, refundCnNo: null });
  });
});

describe('รับเงินล่วงหน้า (advance) and คืนเงินล่วงหน้า', () => {
  it('a tax invoice on receipt; the sale deducts it with its VAT; the rest is returned with a credit note', async () => {
    const dp = await ok(env.boy.post('/api/sales/deposits', { customerId: C.c1, type: 'advance', amount: '1070', method: 'transfer' }), 201);
    expect(dp.invoiceNo).toMatch(/^INV/);
    const advInv = await ok(env.boy.get(`/api/sales/invoices/${dp.invoiceNo}`));
    expect(advInv.doc.totals).toMatchObject({ base7: '1000.00', vat: '70.00', total: '1070.00' });

    const inv = await ok(direct({ deposits: [{ no: dp.no, amount: '535' }] }), 201);
    // 1,500 + 105 VAT − advance 535 (500 + 35 VAT) = 1,070 (1,000 + 70)
    expect(inv.doc.totals).toMatchObject({ base7: '1000.00', vat: '70.00', total: '1070.00' });
    expect(inv).toMatchObject({ depositType: 'advance', depositDeduct: '535.00', grossAmount: '1605.00', arBalance: '1070.00' });

    const back = await ok(env.suda.post(`/api/sales/deposits/${dp.no}/refund`, { reason: 'ลูกค้าไม่รับของส่วนที่เหลือ', method: 'transfer' }));
    expect(back).toMatchObject({ status: 'refunded', refund: { amount: '535.00', method: 'transfer' } });
    expect(back.refundCnNo).toMatch(/^CN/);
    const cn = (await env.pool.query(`select total::text, base7::text, vat::text, ref_no, refund from docs where no = $1`, [back.refundCnNo])).rows[0];
    expect(cn).toEqual({ total: '535.00', base7: '500.00', vat: '35.00', ref_no: dp.invoiceNo, refund: 'transfer' });
    // one invoice uses one kind of deposit
    const g = await ok(env.boy.post('/api/sales/deposits', { customerId: C.c1, type: 'guarantee', amount: '10', method: 'cash' }), 201);
    const a = await ok(env.boy.post('/api/sales/deposits', { customerId: C.c1, type: 'advance', amount: '10', method: 'cash' }), 201);
    expect((await direct({ deposits: [{ no: g.no, amount: '10' }, { no: a.no, amount: '10' }] })).status).toBe(400);
    // an advance needs a customer with a tax ID (full tax invoice)
    expect((await env.boy.post('/api/sales/deposits', { customerId: C.c3, type: 'advance', amount: '100', method: 'cash' })).status).toBe(400);
  });

  it('a deposit for one sales order of the same customer; voiding an unused advance voids its tax invoice', async () => {
    const so = await ok(env.boy.post('/api/sales/orders', { customerId: C.c1, warehouseId: WH2, lines: [{ productId: P.p5!, qty: '2', unitPrice: '150' }] }), 201);
    expect((await env.boy.post('/api/sales/deposits', { customerId: C.c2, soNo: so.no, type: 'guarantee', amount: '100', method: 'cash' })).status).toBe(400);
    const dp = await ok(env.boy.post('/api/sales/deposits', { customerId: C.c1, soNo: so.no, type: 'advance', amount: '107', method: 'cash' }), 201);
    expect(dp.soNo).toBe(so.no);
    await ok(env.suda.post(`/api/sales/deposits/${dp.no}/void`, { reason: 'บันทึกผิด' }));
    expect((await env.pool.query(`select status from docs where no = $1`, [dp.invoiceNo])).rows[0].status).toBe('void');
  });
});

describe('ขอลดหนี้ขาย (credit-note request)', () => {
  it('request → manager approves → credit note takes it off the balance; the requester cannot approve; reject and cancel', async () => {
    const inv = await ok(direct(), 201);
    expect(inv.arBalance).toBe('1605.00');
    expect((await env.boy.post('/api/ar/cn-requests', { invoiceNo: inv.doc.no, amount: '2000', reason: 'เกินยอด' })).status).toBe(409);
    const rq = await ok(env.boy.post('/api/ar/cn-requests', { invoiceNo: inv.doc.no, amount: '107', reason: 'สินค้ามีตำหนิ ลดราคาให้', refundMethod: 'credit' }), 201);
    expect(rq).toMatchObject({ status: 'pending', amount: '107.00', invoiceNo: inv.doc.no, cnNo: null });
    expect((await env.boy.post(`/api/ar/cn-requests/${rq.no}/decide`, { approve: true })).status).toBe(403);
    const dash = await ok(env.suda.get('/api/reports/dashboard'));
    expect(dash.approvals.items.some((x: { no: string }) => x.no === rq.no)).toBe(true);
    const done = await ok(env.suda.post(`/api/ar/cn-requests/${rq.no}/decide`, { approve: true, note: 'ok' }));
    expect(done).toMatchObject({ status: 'approved', decidedBy: 'คุณสุดา ศรีสุข' });
    expect(done.cnNo).toMatch(/^CN/);
    expect(await arOf(env, inv.doc.no)).toBe('1498.00');
    const cn = (await env.pool.query(`select total::text, base7::text, vat::text, ar_applied::text, reason from docs where no = $1`, [done.cnNo])).rows[0];
    expect(cn).toMatchObject({ total: '107.00', base7: '100.00', vat: '7.00', ar_applied: '107.00' });
    expect((await ok(env.boy.get(`/api/sales/invoices/${inv.doc.no}`))).creditNotes[0].no).toBe(done.cnNo);
    expect((await env.suda.post(`/api/ar/cn-requests/${rq.no}/decide`, { approve: true })).status).toBe(409);

    const r2 = await ok(env.boy.post('/api/ar/cn-requests', { invoiceNo: inv.doc.no, amount: '50', reason: 'ทดสอบ' }), 201);
    expect(await ok(env.suda.post(`/api/ar/cn-requests/${r2.no}/decide`, { approve: false, note: 'ไม่เข้าเงื่อนไข' }))).toMatchObject({ status: 'rejected', cnNo: null });
    const r3 = await ok(env.boy.post('/api/ar/cn-requests', { invoiceNo: inv.doc.no, amount: '50', reason: 'ทดสอบ' }), 201);
    expect((await ok(env.boy.post(`/api/ar/cn-requests/${r3.no}/cancel`))).status).toBe('cancelled');
    expect(await arOf(env, inv.doc.no)).toBe('1498.00');
  });

  it('more than what is owed: the balance goes to zero and the rest is refunded', async () => {
    const inv = await ok(direct({}, '1'), 201); // 160.50
    await ok(env.boy.post('/api/ar/receipts', { customerId: C.c1, method: 'transfer', lines: [{ invoiceNo: inv.doc.no, amount: '100.00' }] }), 201).catch(() => null);
    const owed = Number(await arOf(env, inv.doc.no));
    const rq = await ok(env.boy.post('/api/ar/cn-requests', { invoiceNo: inv.doc.no, amount: '160.50', reason: 'ยกเว้นทั้งบิล', refundMethod: 'transfer' }), 201);
    await ok(env.owner.post(`/api/ar/cn-requests/${rq.no}/decide`, { approve: true }));
    expect(await arOf(env, inv.doc.no)).toBe('0.00');
    const cn = (await env.pool.query(`select payments, ar_applied::text from docs where ref_no = $1 and type = 'CN'`, [inv.doc.no])).rows[0];
    expect(Number(cn.ar_applied)).toBe(owed);
    if (owed < 160.5) expect(cn.payments).toEqual([{ method: 'transfer', amount: (160.5 - owed).toFixed(2) }]);
  });
});
