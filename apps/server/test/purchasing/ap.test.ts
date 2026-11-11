/** M18: AP bill from GR (REQ-M18-01, BR-19), payment vouchers (REQ-M18-02), vendor returns (REQ-M18-03, BR-07/21), aging (REQ-M18-04). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, lotsOf, stockQty, TODAY, type Client, type Env, setupEnv } from '../helpers';

let env: Env;
let chai: Client; // wh
let suda: Client; // manager
let charoen: Client; // owner
let acct: Client; // accountant (fin.ap)
const P = (k: string) => env.seed.products[k]!;
const W = (k: string) => env.seed.warehouses[k]!;
const V = (k: string) => env.seed.vendors[k]!;

beforeAll(async () => {
  env = await setupEnv();
  await env.pool.query(`insert into users (tenant_id, username, name, role, password_hash) select tenant_id, 'nok', 'คุณนก (บัญชี)', 'acct', password_hash from users where username = 'suda'`);
  [chai, suda, charoen, acct] = await Promise.all([login(env.app, 'chai'), login(env.app, 'suda'), login(env.app, 'charoen'), login(env.app, 'nok')]);
});
afterAll(async () => { await env.close(); });

const receive = (c: Client, inv: string, vendor: string, lines: { p: string; qty: string; cost: string; unitIdx?: number }[], billDiscount = '0', wh = 'WH2') =>
  c.post('/api/stock/receipts', {
    vendorId: V(vendor), vendorInvoiceNo: inv, deliveryNo: `DN-${inv}`, warehouseId: W(wh), billDiscount,
    lines: lines.map((l) => ({ productId: P(l.p), unitIdx: l.unitIdx ?? 0, qty: l.qty, unitCost: l.cost })),
  });

describe('AP bill from goods receipt (REQ-M18-01, REQ-M05-08, BR-19)', () => {
  it('10,000 goods − 300 bill discount, VAT shop → AP 10,379; lot cost stays 100 (separate purchase discount)', async () => {
    const r = await receive(chai, 'IV-1001', 'v1', [{ p: 'p4', qty: '100', cost: '100' }], '300');
    expect(r.status).toBe(201);
    expect((await lotsOf(env.pool, P('p4'), W('WH2'))).at(-1)).toMatchObject({ remaining: '100.0000', unit_cost: '100.0000' });
    const bills = await acct.get('/api/ap/bills');
    expect(bills.status).toBe(200);
    expect(bills.body.items[0]).toMatchObject({
      no: 'AP2610-0001', source: 'gr', vendorId: V('v1'), vendorInvoiceNo: 'IV-1001', grNo: r.body.no, date: TODAY,
      dueDate: '2026-11-25', termLabel: 'เครดิต 30 วัน', // v1: 30 days
      base: '10000.00', discount: '300.00', discountMode: 'sep', vat: '679.00', total: '10379.00', paid: '0.00', balance: '10379.00', overdueDays: 0,
    });
    const disc = await acct.get('/api/ap/purchase-discounts');
    expect(disc.body.items).toEqual([expect.objectContaining({ billNo: 'AP2610-0001', grNo: r.body.no, amount: '300.00' })]);
    const gr = await suda.get(`/api/purchasing/receipts/${r.body.no}`);
    expect(gr.body).toMatchObject({ apBillNo: 'AP2610-0001', billDiscount: '300.00', returnable: true });
    expect(gr.body.lines[0]).toMatchObject({ qty: '100', returnedQty: '0', unitPrice: '100', amount: '10000.00' });
    expect((await chai.get(`/api/purchasing/receipts/${r.body.no}`)).body.lines[0].unitPrice).toBeNull(); // no data.cost
  });

  it('due date follows each vendor term (next-month day 5, end of month)', async () => {
    await receive(chai, 'TT-1', 'v2', [{ p: 'p6', qty: '20', cost: '70' }]);
    await receive(chai, 'SM-1', 'v3', [{ p: 'p5', qty: '10', cost: '140' }]);
    const r = await acct.get('/api/ap/bills?q=TT-1');
    expect(r.body.items[0]).toMatchObject({ dueDate: '2026-11-05', termLabel: 'วันที่ 5 ของเดือนถัดไป', total: '1498.00' });
    expect((await acct.get('/api/ap/bills?q=SM-1')).body.items[0]).toMatchObject({ dueDate: '2026-10-31', total: '1498.00' });
  });

  it("BR-19 'alloc' setting (owner only) spreads the discount into lot cost; AP is the same", async () => {
    expect((await suda.patch('/api/purchasing/settings', { billDiscountMode: 'alloc' })).status).toBe(403);
    expect((await charoen.patch('/api/purchasing/settings', { billDiscountMode: 'alloc' })).body).toEqual({ billDiscountMode: 'alloc', freeGoodsCosting: 'zero' });
    const r = await receive(chai, 'IV-1002', 'v1', [{ p: 'p4', qty: '100', cost: '100' }], '300');
    expect(r.status).toBe(201);
    expect((await lotsOf(env.pool, P('p4'), W('WH2'))).at(-1)).toMatchObject({ unit_cost: '97.0000' });
    expect((await acct.get('/api/ap/bills?q=IV-1002')).body.items[0]).toMatchObject({ discountMode: 'alloc', total: '10379.00' });
    expect((await acct.get('/api/ap/purchase-discounts')).body.items).toHaveLength(1); // alloc discounts are in cost, not listed
    await charoen.patch('/api/purchasing/settings', { billDiscountMode: 'sep' });
  });

  it('a failing receipt leaves no AP bill and no number gap (one transaction)', async () => {
    const dup = await receive(chai, 'IV-1001', 'v1', [{ p: 'p4', qty: '1', cost: '100' }]);
    expect(dup.status).toBe(409);
    const n = await env.pool.query(`select count(*)::int n from ap_bills`);
    expect(n.rows[0].n).toBe(4);
  });
});

describe('payment vouchers (REQ-M18-02)', () => {
  let b1: { id: string; balance: string };
  let b2: { id: string; balance: string };

  it('pays several bills at once, partially, with WHT 3% on the pre-VAT amount', async () => {
    const open = (await acct.get(`/api/ap/bills?status=open&vendorId=${V('v1')}`)).body.items;
    expect(open.map((b: { vendorInvoiceNo: string }) => b.vendorInvoiceNo)).toEqual(expect.arrayContaining(['IV-1001', 'IV-1002']));
    [b1, b2] = open;
    const r = await acct.post('/api/ap/payments', {
      vendorId: V('v1'), method: 'transfer', ref: 'KBANK 2610-77', whtRate: 3,
      allocations: [{ billId: b1.id, amount: b1.balance }, { billId: b2.id, amount: '5000.00' }],
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ no: 'PV2610-0001', amount: '15379.00', whtRate: '3', wht: '431.19', net: '14947.81', method: 'transfer' });
    expect(r.body.bills).toHaveLength(2);
    const after = (await acct.get(`/api/ap/bills?status=open&vendorId=${V('v1')}`)).body.items;
    expect(after.map((b: { id: string; balance: string }) => [b.id, b.balance])).toEqual([[b2.id, '5379.00']]);
    const pv = await acct.get('/api/ap/payments/PV2610-0001');
    expect(pv.body.ref).toBe('KBANK 2610-77');
  });

  it('refuses overpaying, another vendor\'s bill, duplicates, a cheque without number, and roles without fin.ap', async () => {
    const over = await acct.post('/api/ap/payments', { vendorId: V('v1'), method: 'cash', allocations: [{ billId: b2.id, amount: '5379.01' }] });
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/exceeds the open balance/);
    const other = await acct.post('/api/ap/payments', { vendorId: V('v2'), method: 'cash', allocations: [{ billId: b2.id, amount: '1' }] });
    expect(other.status).toBe(400);
    const twice = await acct.post('/api/ap/payments', { vendorId: V('v1'), method: 'cash', allocations: [{ billId: b2.id, amount: '1' }, { billId: b2.id, amount: '1' }] });
    expect(twice.status).toBe(400);
    const chq = await acct.post('/api/ap/payments', { vendorId: V('v1'), method: 'cheque', allocations: [{ billId: b2.id, amount: '1' }] });
    expect(chq.status).toBe(400);
    expect((await chai.post('/api/ap/payments', { vendorId: V('v1'), method: 'cash', allocations: [{ billId: b2.id, amount: '1' }] })).status).toBe(403);
    expect((await chai.get('/api/ap/bills')).status).toBe(403);
  });

  it('two concurrent payments of the full balance: exactly one wins (bills locked FOR UPDATE)', async () => {
    const body = { vendorId: V('v1'), method: 'cash', allocations: [{ billId: b2.id, amount: '5379.00' }] };
    const [x, y] = await Promise.all([acct.post('/api/ap/payments', body), suda.post('/api/ap/payments', body)]);
    expect([x.status, y.status].sort()).toEqual([201, 400]);
    const b = await env.pool.query(`select paid::text from ap_bills where id = $1`, [b2.id]);
    expect(b.rows[0].paid).toBe('10379.00');
    const nos = (await acct.get('/api/ap/payments')).body.items.map((p: { no: string }) => p.no);
    expect(nos).toEqual(['PV2610-0002', 'PV2610-0001']); // BR-04: no gap from the losing request
  });
});

describe('vendor returns (REQ-M18-03)', () => {
  let grNo: string;
  let line: { id: string };

  it('returns against the GR at the GR lot cost, cuts stock, reduces AP, records the vendor CN', async () => {
    const r = await receive(chai, 'SM-2', 'v3', [{ p: 'p7', qty: '10', cost: '1000' }]);
    grNo = r.body.no;
    const before = await stockQty(env.pool, P('p7'), W('WH2'));
    const gr = await acct.get(`/api/purchasing/receipts/${grNo}`);
    line = gr.body.lines[0];
    const ret = await acct.post('/api/ap/vendor-returns', { grNo, lines: [{ grLineId: line.id, qty: '3' }], reason: 'สีผิดเฉด', vendorCnNo: 'CN-SM-55' });
    expect(ret.status).toBe(201);
    expect(ret.body).toMatchObject({
      no: 'PR2610-0001', grNo, vendorId: V('v3'), base: '3000.00', vat: '210.00', total: '3210.00', apApplied: '3210.00', unapplied: '0.00',
      cogs: '3000.00', vendorCnNo: 'CN-SM-55', reason: 'สีผิดเฉด',
    });
    expect(await stockQty(env.pool, P('p7'), W('WH2'))).toBe(before - 3);
    const lots = await lotsOf(env.pool, P('p7'), W('WH2'));
    expect(lots.find((l) => l.ref === grNo)!.remaining).toBe('7.0000'); // taken from this GR's own lot, not the older ones
    const bill = (await acct.get('/api/ap/bills?q=SM-2')).body.items[0];
    expect(bill).toMatchObject({ total: '10700.00', returned: '3210.00', balance: '7490.00' });
    const moves = await env.pool.query(`select doc_type, qty::text, cost::text from stock_moves where doc_no = 'PR2610-0001'`);
    expect(moves.rows).toEqual([{ doc_type: 'PR', qty: '-3.0000', cost: '3000.00' }]);
  });

  it('qty ≤ received − returned; the exact remainder is allowed', async () => {
    const over = await acct.post('/api/ap/vendor-returns', { grNo, lines: [{ grLineId: line.id, qty: '8' }], reason: 'x' });
    expect(over.status).toBe(400);
    expect(over.body.details).toEqual({ grLineId: line.id, max: '7' });
    const ok = await acct.post('/api/ap/vendor-returns', { grNo, lines: [{ grLineId: line.id, qty: '7' }], reason: 'คืนที่เหลือ' });
    expect(ok.status).toBe(201);
    expect((await acct.get(`/api/purchasing/receipts/${grNo}`)).body.returnable).toBe(false);
    expect((await acct.get('/api/purchasing/receipts?returnable=true')).body.items.map((g: { no: string }) => g.no)).not.toContain(grNo);
    expect((await acct.get('/api/purchasing/receipts?returnable=false')).body.items.map((g: { no: string }) => g.no)).toContain(grNo);
  });

  it('BR-07: cannot return goods that are no longer in the warehouse; a paid bill keeps the credit unapplied', async () => {
    const r = await receive(chai, 'TT-2', 'v2', [{ p: 'p8', qty: '2', cost: '500' }], '0', 'WH1');
    const gl = (await acct.get(`/api/purchasing/receipts/${r.body.no}`)).body.lines[0];
    const bill = (await acct.get('/api/ap/bills?q=TT-2')).body.items[0];
    await acct.post('/api/ap/payments', { vendorId: V('v2'), method: 'cash', allocations: [{ billId: bill.id, amount: bill.balance }] });
    await chai.post('/api/stock/issues', { warehouseId: W('WH1'), lines: [{ productId: P('p8'), qty: '2' }], reason: 'ใช้ในร้าน' });
    const short = await acct.post('/api/ap/vendor-returns', { grNo: r.body.no, lines: [{ grLineId: gl.id, qty: '1' }], reason: 'x' });
    expect(short.status).toBe(409);
    expect(short.body.code).toBe('INSUFFICIENT_STOCK');
    await chai.post('/api/stock/transfers', { fromWarehouseId: W('WH2'), toWarehouseId: W('WH1'), lines: [{ productId: P('p8'), qty: '1' }] });
    const ok = await acct.post('/api/ap/vendor-returns', { grNo: r.body.no, lines: [{ grLineId: gl.id, qty: '1' }], reason: 'แตก' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ total: '535.00', apApplied: '0.00', unapplied: '535.00' });
    expect(ok.body.cogs).toBe('504.40'); // the GR lot is gone: FIFO cost of the lot now in WH1 (moved from WH2 at its cost)
  });
});

describe('aging and due-in-7-days (REQ-M18-04)', () => {
  it('buckets by days overdue and counts bills due within 7 days', async () => {
    await env.pool.query(`update ap_bills set due_date = $1::date - 45 where vendor_invoice_no = 'SM-1'`, [TODAY]);
    await env.pool.query(`update ap_bills set due_date = $1::date + 3 where vendor_invoice_no = 'TT-1'`, [TODAY]);
    const a = await acct.get('/api/ap/aging');
    expect(a.status).toBe(200);
    expect(a.body.asOf).toBe(TODAY);
    expect(a.body.buckets).toEqual({ current: '1498.00', d1_30: '0.00', d31_60: '1498.00', over60: '0.00' });
    expect(a.body.total).toBe('2996.00');
    expect(a.body.dueSoon).toEqual({ days: 7, count: 1, amount: '1498.00' });
    expect(a.body.purchaseDiscountMonth).toBe('300.00');
    const dash = await suda.get('/api/purchasing/dashboard');
    expect(dash.body.apDue7).toEqual({ count: 1, amount: '1498.00' });
    expect(dash.body.apOverdue).toEqual({ count: 1, amount: '1498.00' });
    expect((await chai.get('/api/purchasing/dashboard')).body.apDue7).toEqual({ count: 0, amount: '0.00' }); // wh: no fin.ap
    const overdue = (await acct.get('/api/ap/bills?q=SM-1')).body.items[0];
    expect(overdue.overdueDays).toBe(45);
  });

  it('every AP mutation is audited', async () => {
    const r = await env.pool.query(`select action, object, ref from audit_log where object in ('payment-voucher','vendor-return','purchasing-settings') order by id`);
    expect(r.rows.map((x) => `${x.action}:${x.object}`)).toEqual(expect.arrayContaining(['pay:payment-voucher', 'create:vendor-return', 'update:purchasing-settings']));
  });
});
