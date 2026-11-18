/** มัดจำซื้อ, รับวางบิลซื้อ and ปรับปรุงต้นทุน (owner on/off switch, approval, lots and ledger). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, lotsOf, setupEnv, type Client, type Env } from '../helpers';

let env: Env;
let chai: Client;
let suda: Client;
let charoen: Client;
const P = (k: string) => env.seed.products[k]!;
const W = (k: string) => env.seed.warehouses[k]!;
const V = (k: string) => env.seed.vendors[k]!;

beforeAll(async () => {
  env = await setupEnv();
  [chai, suda, charoen] = await Promise.all([login(env.app, 'chai'), login(env.app, 'suda'), login(env.app, 'charoen')]);
});
afterAll(async () => { await env.close(); });

async function bill(inv: string, qty: string, cost: string) {
  const r = await chai.post('/api/stock/receipts', { vendorId: V('v1'), vendorInvoiceNo: inv, deliveryNo: `DN-${inv}`, warehouseId: W('WH2'), lines: [{ productId: P('p4'), unitIdx: 0, qty, unitCost: cost }] });
  expect(r.status).toBe(201);
  return (await suda.get(`/api/ap/bills?q=${inv}`)).body.items[0] as { id: string; no: string; total: string; balance: string };
}

describe('มัดจำซื้อ (purchase deposit)', () => {
  it('paid to a vendor, then used in a payment voucher: bills settled in full, only the rest is paid', async () => {
    expect((await chai.post('/api/ap/deposits', { vendorId: V('v1'), method: 'transfer', amount: '1000' })).status).toBe(403);
    const dp = await suda.post('/api/ap/deposits', { vendorId: V('v1'), method: 'transfer', ref: 'TR-1', amount: '1000', note: 'มัดจำค่าปูน' });
    expect(dp.status).toBe(201);
    expect(dp.body).toMatchObject({ no: expect.stringMatching(/^PD/), amount: '1000.00', used: '0.00', remaining: '1000.00', status: 'active', vendorId: V('v1') });
    const b = await bill('DEP-1', '10', '100'); // 1,000 + VAT 70
    expect(b.total).toBe('1070.00');
    const pv = await suda.post('/api/ap/payments', { vendorId: V('v1'), method: 'transfer', allocations: [{ billId: b.id, amount: '1070.00' }], deposits: [{ depositId: dp.body.id, amount: '1000' }] });
    expect(pv.status).toBe(201);
    expect(pv.body).toMatchObject({ amount: '1070.00', depositUsed: '1000.00', net: '70.00', deposits: [{ no: dp.body.no, amount: '1000.00' }] });
    expect((await suda.get(`/api/ap/bills/${b.no}`)).body.balance).toBe('0.00');
    expect((await suda.get(`/api/ap/deposits/${dp.body.no}`)).body).toMatchObject({ used: '1000.00', remaining: '0.00', payments: [{ no: pv.body.no, amount: '1000.00' }] });
  });

  it('cannot use more than is left or another vendor\'s deposit; refund closes the rest; void only while unused', async () => {
    const dp = (await suda.post('/api/ap/deposits', { vendorId: V('v1'), method: 'cash', amount: '300' })).body;
    const b = await bill('DEP-2', '5', '100');
    expect((await suda.post('/api/ap/payments', { vendorId: V('v1'), method: 'cash', allocations: [{ billId: b.id, amount: '535.00' }], deposits: [{ depositId: dp.id, amount: '301' }] })).status).toBe(409);
    expect((await suda.post('/api/ap/payments', { vendorId: V('v2'), method: 'cash', allocations: [{ billId: b.id, amount: '535.00' }], deposits: [{ depositId: dp.id, amount: '1' }] })).status).toBe(400);
    expect((await suda.post('/api/ap/payments', { vendorId: V('v1'), method: 'cash', allocations: [{ billId: b.id, amount: '200.00' }], deposits: [{ depositId: dp.id, amount: '100' }] })).status).toBe(201);
    expect((await suda.post(`/api/ap/deposits/${dp.no}/close`, { action: 'void', reason: 'ผิด' })).status).toBe(409);
    const closed = await suda.post(`/api/ap/deposits/${dp.no}/close`, { action: 'refund', reason: 'ผู้ขายโอนคืน' });
    expect(closed.body).toMatchObject({ status: 'refunded', closedAmount: '200.00', remaining: '0.00' });
    const dp2 = (await suda.post('/api/ap/deposits', { vendorId: V('v1'), method: 'cash', amount: '50' })).body;
    expect((await suda.post(`/api/ap/deposits/${dp2.no}/close`, { action: 'void', reason: 'บันทึกซ้ำ' })).body.status).toBe('void');
    expect((await suda.get(`/api/ap/deposits?status=open`)).body.items.map((x: { no: string }) => x.no)).not.toContain(dp2.no);
  });
});

describe('รับวางบิลซื้อ (vendor billing note)', () => {
  it('groups open bills with the payment date; a bill sits on one note; paying the note settles it', async () => {
    const b1 = await bill('VB-1', '2', '100');
    const b2 = await bill('VB-2', '3', '100');
    const r = await suda.post('/api/ap/billing-notes', { vendorId: V('v1'), billIds: [b1.id, b2.id], vendorDocNo: 'BL-889', dueDate: '2026-11-30' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ no: expect.stringMatching(/^VB/), total: '535.00', balance: '535.00', paid: false, vendorDocNo: 'BL-889', dueDate: '2026-11-30' });
    expect(r.body.bills).toHaveLength(2);
    expect((await suda.post('/api/ap/billing-notes', { vendorId: V('v1'), billIds: [b1.id], dueDate: '2026-11-30' })).status).toBe(409);
    const other = await bill('VB-3', '1', '100');
    expect((await suda.post('/api/ap/billing-notes', { vendorId: V('v1'), billIds: [other.id], dueDate: '2020-01-01' })).status).toBe(400);
    expect((await suda.post('/api/ap/payments', { vendorId: V('v1'), method: 'transfer', allocations: [{ billId: other.id, amount: '107.00' }], billingNoteNo: r.body.no })).status).toBe(400);
    const pv = await suda.post('/api/ap/payments', { vendorId: V('v1'), method: 'transfer', billingNoteNo: r.body.no, allocations: [{ billId: b1.id, amount: '214.00' }, { billId: b2.id, amount: '321.00' }] });
    expect(pv.status).toBe(201);
    expect(pv.body.billingNoteNo).toBe(r.body.no);
    const after = (await suda.get(`/api/ap/billing-notes/${r.body.no}`)).body;
    expect(after).toMatchObject({ balance: '0.00', paid: true, payments: [{ no: pv.body.no, amount: '535.00' }] });
    expect((await suda.get('/api/ap/billing-notes?status=open')).body.items.map((x: { no: string }) => x.no)).not.toContain(r.body.no);
    const n2 = (await suda.post('/api/ap/billing-notes', { vendorId: V('v1'), billIds: [other.id], dueDate: '2026-12-05' })).body;
    expect((await suda.post(`/api/ap/billing-notes/${n2.no}/void`, { reason: 'ผู้ขายส่งใบใหม่' })).body.status).toBe('void');
    expect((await suda.post('/api/ap/billing-notes', { vendorId: V('v1'), billIds: [other.id], dueDate: '2026-12-05' })).status).toBe(201);
  });
});

describe('ปรับปรุงต้นทุน (cost adjustment)', () => {
  it('locked until the owner switches it on; request → approval rewrites the remaining lots, product cost and ledger', async () => {
    expect((await suda.get('/api/stock/cost-adjustments/settings')).body.enabled).toBe(false);
    const line = { productId: P('p3'), warehouseId: W('WH2'), newCost: '20.5' };
    const locked = await suda.post('/api/stock/cost-adjustments', { lines: [line], reason: 'ราคาทุนจริงจากใบแจ้งหนี้' });
    expect(locked.status).toBe(409);
    expect(locked.body.details.reason).toBe('COST_LOCKED');
    expect((await suda.patch('/api/stock/cost-adjustments/settings', { enabled: true })).status).toBe(403);
    expect((await charoen.patch('/api/stock/cost-adjustments/settings', { enabled: true })).body).toMatchObject({ enabled: true, updatedBy: 'คุณเจริญ ศรีสุข' });

    const pre = (await suda.get(`/api/stock/cost-adjustments/preview?productId=${P('p3')}&warehouseId=${W('WH2')}`)).body;
    expect(Number(pre.qty)).toBeGreaterThan(0);
    expect((await chai.post('/api/stock/cost-adjustments', { lines: [line], reason: 'x' })).status).toBe(403); // no data.cost
    const rq = await suda.post('/api/stock/cost-adjustments', { lines: [line], reason: 'ราคาทุนจริงจากใบแจ้งหนี้' });
    expect(rq.status).toBe(201);
    expect(rq.body).toMatchObject({ status: 'pending', lines: [{ qty: pre.qty, oldCost: pre.avgCost, newCost: '20.5', warehouseName: 'โกดังหลังร้าน' }] });
    expect((await suda.post(`/api/stock/cost-adjustments/${rq.body.no}/decide`, { approve: true })).status).toBe(403); // own request
    const dash = (await charoen.get('/api/reports/dashboard')).body;
    expect(dash.approvals.items.some((x: { no: string }) => x.no === rq.body.no)).toBe(true);
    const ok = await charoen.post(`/api/stock/cost-adjustments/${rq.body.no}/decide`, { approve: true, note: 'ตรวจแล้ว' });
    expect(ok.body).toMatchObject({ status: 'approved', decidedBy: 'คุณเจริญ ศรีสุข' });
    const expected = ((20.5 - Number(pre.avgCost)) * Number(pre.qty)).toFixed(2);
    expect(ok.body.valueChange).toBe(expected);
    expect((await lotsOf(env.pool, P('p3'), W('WH2'))).filter((l) => Number(l.remaining) > 0).every((l) => Number(l.unit_cost) === 20.5)).toBe(true);
    const led = (await suda.get(`/api/stock/ledger?productId=${P('p3')}&warehouseId=${W('WH2')}`)).body.items[0];
    expect(led).toMatchObject({ docType: 'CA', docNo: rq.body.no, qty: '0' });

    // switched off again: nobody can change cost
    await charoen.patch('/api/stock/cost-adjustments/settings', { enabled: false });
    expect((await suda.post('/api/stock/cost-adjustments', { lines: [{ ...line, newCost: '21' }], reason: 'x' })).status).toBe(409);
  });

  it('rejected requests change nothing', async () => {
    await charoen.patch('/api/stock/cost-adjustments/settings', { enabled: true });
    const before = await lotsOf(env.pool, P('p5'), W('WH1'));
    const rq = (await suda.post('/api/stock/cost-adjustments', { lines: [{ productId: P('p5'), warehouseId: W('WH1'), newCost: '1' }], reason: 'ทดสอบ' })).body;
    expect((await charoen.post(`/api/stock/cost-adjustments/${rq.no}/decide`, { approve: false, note: 'ไม่ถูกต้อง' })).body.status).toBe('rejected');
    expect(await lotsOf(env.pool, P('p5'), W('WH1'))).toEqual(before);
  });
});
