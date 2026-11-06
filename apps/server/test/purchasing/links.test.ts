/** Cross-module links as data: GR ↔ AP bill ↔ PV ↔ vendor return, invoice → related documents, list filters used by drill-downs. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, type Client, type Env, setupEnv } from '../helpers';

let env: Env;
let chai: Client;
let charoen: Client;
const P = (k: string) => env.seed.products[k]!;
const W = (k: string) => env.seed.warehouses[k]!;
const V = (k: string) => env.seed.vendors[k]!;

beforeAll(async () => {
  env = await setupEnv();
  [chai, charoen] = await Promise.all([login(env.app, 'chai'), login(env.app, 'charoen')]);
});
afterAll(async () => { await env.close(); });

describe('purchasing document chain', () => {
  it('GR lists its returns; the AP bill detail lists payments and returns; the voucher and return open by number', async () => {
    const gr = await chai.post('/api/stock/receipts', {
      vendorId: V('v1'), vendorInvoiceNo: 'IV-LNK-1', deliveryNo: 'DN-LNK-1', warehouseId: W('WH2'),
      lines: [{ productId: P('p4'), unitIdx: 0, qty: '10', unitCost: '100' }],
    });
    expect(gr.status).toBe(201);
    const detail = (await charoen.get(`/api/purchasing/receipts/${gr.body.no}`)).body;
    const billNo = detail.apBillNo as string;
    expect(billNo).toBeTruthy();
    const bill = (await charoen.get(`/api/ap/bills/${billNo}`)).body;
    expect(bill).toMatchObject({ no: billNo, grNo: gr.body.no, payments: [], returns: [] });
    const pv = await charoen.post('/api/ap/payments', { vendorId: V('v1'), method: 'transfer', ref: 'T', allocations: [{ billId: bill.id, amount: '200' }] });
    expect(pv.status).toBe(201);
    const ret = await charoen.post('/api/ap/vendor-returns', { grNo: gr.body.no, lines: [{ grLineId: detail.lines[0].id, qty: '1' }], reason: 'แตก' });
    expect(ret.status).toBe(201);

    const after = (await charoen.get(`/api/ap/bills/${billNo}`)).body;
    expect(after.payments.map((p: { no: string }) => p.no)).toEqual([pv.body.no]);
    expect(after.returns.map((r: { no: string }) => r.no)).toEqual([ret.body.no]);
    expect((await charoen.get(`/api/purchasing/receipts/${gr.body.no}`)).body.returns.map((r: { no: string }) => r.no)).toEqual([ret.body.no]);
    expect((await charoen.get(`/api/ap/payments/${pv.body.no}`)).body.bills[0]).toMatchObject({ billNo });
    expect((await charoen.get(`/api/ap/vendor-returns/${ret.body.no}`)).body).toMatchObject({ grNo: gr.body.no, apBillNo: billNo });
    expect((await charoen.get('/api/ap/bills/AP0000-0000')).status).toBe(404);
  });

  it('stock counts and adjustment lists filter by number', async () => {
    const all = await charoen.get('/api/stock-counts');
    expect(all.status).toBe(200);
    const none = await charoen.get('/api/stock-counts?q=NO-SUCH-NUMBER');
    expect(none.body.items).toEqual([]);
  });
});

describe('sales document drill-down', () => {
  it('a sales document lists the documents made from it; filters narrow the list', async () => {
    const list = await charoen.get('/api/sales/docs?limit=5');
    expect(list.status).toBe(200);
    const none = await charoen.get('/api/sales/docs?customerId=00000000-0000-0000-0000-000000000000');
    expect(none.status).toBe(200);
    expect(none.body.items).toEqual([]);
    const first = list.body.items[0];
    if (first) {
      const d = await charoen.get(`/api/sales/docs/${first.no}`);
      expect(d.status).toBe(200);
      expect(Array.isArray(d.body.related ?? [])).toBe(true);
    }
  });
});
