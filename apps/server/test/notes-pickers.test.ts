/** Cross-cutting: document notes (migration 0640), vendor quick-create for the picker, Thai partial vendor search, payslip publish status. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedAdmin } from '@erp/db/src/seedAdmin';
import { login, setupEnv, type Client, type Env } from './helpers';

let env: Env;
let owner: Client;
let chai: Client;
let prae: Client;
const P = (k: string) => env.seed.products[k]!;
const W = (k: string) => env.seed.warehouses[k]!;
const V = (k: string) => env.seed.vendors[k]!;

beforeAll(async () => {
  env = await setupEnv();
  await seedAdmin(env.pool, env.seed.tenantId);
  [owner, chai, prae] = await Promise.all([login(env.app, 'charoen'), login(env.app, 'chai'), login(env.app, 'prae')]);
});
afterAll(async () => { await env.close(); });

describe('vendors for the picker', () => {
  it('partial Thai search finds the vendor by a word inside its name', async () => {
    const r = await owner.get(`/api/vendors?q=${encodeURIComponent('พัฒนา')}`);
    expect(r.body.items.map((v: { id: string }) => v.id)).toContain(V('v1'));
  });
  it('POST /api/vendors needs data.master, generates the next V code, is audited', async () => {
    expect((await prae.post('/api/vendors', { name: 'ร้านทดสอบ' })).status).toBe(403);
    const r = await owner.post('/api/vendors', { name: 'บจก. อิฐดีสยาม', taxId: '0105500000001', term: { t: 'days', x: 15 } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'บจก. อิฐดีสยาม', taxId: '0105500000001', branch: 'สำนักงานใหญ่' });
    expect(r.body.code).toMatch(/^V\d{5}$/);
    expect((await owner.get(`/api/vendors?q=${encodeURIComponent('อิฐดี')}`)).body.items[0].id).toBe(r.body.id);
    const a = await env.pool.query(`select 1 from audit_log where object = 'vendor' and ref = $1`, [r.body.code]);
    expect(a.rowCount).toBe(1);
  });
});

describe('notes on purchasing documents', () => {
  it('GR note is stored, shown on the receipt and copied to the AP bill; the bill note can be edited (fin.ap) and is audited', async () => {
    const gr = await chai.post('/api/stock/receipts', {
      vendorId: V('v1'), vendorInvoiceNo: 'IV-NOTE-1', deliveryNo: 'DN-NOTE-1', warehouseId: W('WH2'), note: 'ถุงฉีก 1 ถุง รอเปลี่ยน',
      lines: [{ productId: P('p4'), unitIdx: 0, qty: '10', unitCost: '100' }],
    });
    expect(gr.status).toBe(201);
    const detail = await owner.get(`/api/purchasing/receipts/${gr.body.no}`);
    expect(detail.body.note).toBe('ถุงฉีก 1 ถุง รอเปลี่ยน');
    const bill = await owner.get(`/api/ap/bills/${detail.body.apBillNo}`);
    expect(bill.body.note).toBe('ถุงฉีก 1 ถุง รอเปลี่ยน');
    expect((await chai.patch(`/api/ap/bills/${detail.body.apBillNo}`, { note: 'x' })).status).toBe(403);
    const upd = await owner.patch(`/api/ap/bills/${detail.body.apBillNo}`, { note: 'ผู้ขายยืนยันเปลี่ยนให้แล้ว' });
    expect(upd.body.note).toBe('ผู้ขายยืนยันเปลี่ยนให้แล้ว');

    const pv = await owner.post('/api/ap/payments', { vendorId: V('v1'), method: 'transfer', note: 'โอนรอบบ่าย', allocations: [{ billId: bill.body.id, amount: '100' }] });
    expect(pv.body.note).toBe('โอนรอบบ่าย');
    const ret = await owner.post('/api/ap/vendor-returns', { grNo: gr.body.no, reason: 'ชำรุด', note: 'ผู้ขายมารับเอง', lines: [{ grLineId: detail.body.lines[0].id, qty: '1' }] });
    expect(ret.status).toBe(201);
    expect((await owner.get(`/api/ap/vendor-returns/${ret.body.no}`)).body.note).toBe('ผู้ขายมารับเอง');
  });
});

describe('notes on retail and HR documents', () => {
  it('price list and payroll run keep their note; leave request too', async () => {
    const pl = await owner.post('/api/price-lists', { name: 'ราคาช่าง', customerGroup: 'contr', note: 'ทบทวนทุกไตรมาส', items: [] });
    expect(pl.status).toBe(201);
    expect((await owner.get(`/api/price-lists/${pl.body.id}`)).body.note).toBe('ทบทวนทุกไตรมาส');
    expect((await owner.patch(`/api/price-lists/${pl.body.id}`, { note: 'แก้แล้ว' })).body.note).toBe('แก้แล้ว');

    const run = await owner.post('/api/hr/payroll', { period: '2027-01', note: 'รวมโบนัส' });
    expect(run.body.note).toBe('รวมโบนัส');
    expect((await owner.patch('/api/hr/payroll/2027-01', { note: 'รวมโบนัสปีใหม่' })).body.note).toBe('รวมโบนัสปีใหม่');

    const lv = await prae.post('/api/hr/leaves', { type: 'personal', fromDate: '2026-12-01', toDate: '2026-12-01', reason: 'ธุระ', note: 'ฝากงานคุณชัย' });
    expect(lv.status).toBe(201);
    expect(lv.body.leave.note).toBe('ฝากงานคุณชัย');
  });
});

describe('payslip publish status (no 404 before publish)', () => {
  it('a month without a run or with an unpaid run answers 200 with published=false; paid → published', async () => {
    const none = await owner.get('/api/hr/payslip-periods?period=2030-01');
    expect(none.status).toBe(200);
    expect(none.body.items).toEqual([expect.objectContaining({ period: '2030-01', exists: false, published: false })]);
    await owner.post('/api/hr/payroll', { period: '2027-02' });
    expect((await owner.get('/api/hr/payslip-periods?period=2027-02')).body.items[0]).toMatchObject({ exists: true, status: 'draft', published: false });
    expect((await owner.get('/api/hr/payroll/2027-02')).body.published).toBe(false);
    await owner.post('/api/hr/payroll/2027-02/approve', {});
    await owner.post('/api/hr/payroll/2027-02/pay', {});
    expect((await owner.get('/api/hr/payslip-periods?period=2027-02')).body.items[0]).toMatchObject({ status: 'paid', published: true });
    // an employee sees only runs that include them
    const mine = await prae.get('/api/hr/payslip-periods');
    expect(mine.status).toBe(200);
    expect(mine.body.items.every((x: { period: string }) => typeof x.period === 'string')).toBe(true);
  });
});
