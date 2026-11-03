/** M10: billing notes, receipts over several invoices / partial, WHT 1 % / 3 % / amount with 50 ทวิ, aging, due-soon card, statement. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedMinimalTenant } from '@erp/db';
import { login } from '../helpers';
import { arOf, ok, setupSales, type SalesEnv } from './sales-helpers';

let env: SalesEnv;
let P: Record<string, string>;
let C: Record<string, string>;
let WH2: string;
const inv: Record<string, string> = {};

const direct = async (customerId: string, qty: string, price: string, date?: string) =>
  (await ok(env.boy.post('/api/sales/invoices', { source: 'direct', customerId, warehouseId: WH2, date, lines: [{ productId: P.p3, qty, unitPrice: price }] }), 201)).doc.no as string;

beforeAll(async () => {
  env = await setupSales();
  P = env.seed.products;
  C = env.seed.customers;
  WH2 = env.seed.warehouses.WH2!;
  // c1: 30-day term. a = 10,700 (10,000 + VAT), b = 5,350, old = 2,140 dated 70 days ago (due 40 days ago)
  inv.a = await direct(C.c1!, '500', '20');
  inv.b = await direct(C.c1!, '250', '20');
  inv.old = await direct(C.c1!, '100', '20', '2026-08-17');
  // c2: end of month term
  inv.c2 = await direct(C.c2!, '50', '20');
});
afterAll(async () => { await env.close(); });

describe('billing notes (REQ-M10-01)', () => {
  it('groups unbilled invoices of one customer with a cheque collection date', async () => {
    const bn = await ok(env.owner.post('/api/ar/billing-notes', { customerId: C.c1, invoiceNos: [inv.a, inv.old], collectDate: '2026-11-05' }), 201);
    expect(bn.no).toMatch(/^BN2610-/);
    expect(bn.total).toBe('12840.00');
    expect(bn.lines.map((l: { invoiceNo: string }) => l.invoiceNo)).toEqual([inv.old, inv.a]); // oldest due first
    const unbilled = await ok(env.owner.get(`/api/ar/invoices?customerId=${C.c1}&unbilled=true`));
    expect(unbilled.items.map((x: { no: string }) => x.no)).toEqual([inv.b]);
    expect((await env.owner.post('/api/ar/billing-notes', { customerId: C.c1, invoiceNos: [inv.a] })).status).toBe(409);
    expect((await env.owner.post('/api/ar/billing-notes', { customerId: C.c1, invoiceNos: [inv.c2] })).status).toBe(400); // other customer
    // an invoice on an active billing note cannot be voided (BR-22)
    const v = await env.owner.post(`/api/sales/docs/${inv.old}/void`, { reason: 'x' });
    expect(v.status).toBe(409);
    expect(v.body.details.docs).toContain(bn.no);
  });
});

describe('receipts (REQ-M10-02/03)', () => {
  it('settles several invoices, one partially, with 3 % WHT on the pre-VAT amount and the 50 ทวิ number', async () => {
    const r = await ok(env.owner.post('/api/ar/receipts', {
      customerId: C.c1, method: 'cheque', cheque: { no: '0012345', bank: 'กสิกรไทย', date: '2026-10-30' },
      lines: [{ invoiceNo: inv.a, amount: '10700' }, { invoiceNo: inv.b, amount: '2675' }], wht: { mode: 'rate', rate: '3' }, whtCertNo: 'WHT-2569/0101',
    }), 201);
    expect(r.no).toMatch(/^RE2610-/);
    expect(r).toMatchObject({ settled: '13375.00', wht: '375.00', cash: '13000.00', whtRate: '3', whtCertNo: 'WHT-2569/0101' });
    expect(r.lines.map((l: { whtBase: string; wht: string }) => [l.whtBase, l.wht])).toEqual([['10000.00', '300.00'], ['2500.00', '75.00']]);
    expect(await arOf(env, inv.a!)).toBe('0.00');
    expect(await arOf(env, inv.b!)).toBe('2675.00');
    const i = await ok(env.owner.get(`/api/sales/invoices/${inv.b}`));
    expect(i).toMatchObject({ arBalance: '2675.00', settled: '2675.00' });
  });

  it('refuses more than the balance, a paid invoice, a duplicate line and a cheque without details', async () => {
    expect((await env.owner.post('/api/ar/receipts', { customerId: C.c1, method: 'cash', lines: [{ invoiceNo: inv.b, amount: '2675.01' }] })).status).toBe(409);
    expect((await env.owner.post('/api/ar/receipts', { customerId: C.c1, method: 'cash', lines: [{ invoiceNo: inv.a, amount: '1' }] })).status).toBe(409);
    expect((await env.owner.post('/api/ar/receipts', { customerId: C.c1, method: 'cash', lines: [{ invoiceNo: inv.b, amount: '1' }, { invoiceNo: inv.b, amount: '1' }] })).status).toBe(400);
    expect((await env.owner.post('/api/ar/receipts', { customerId: C.c1, method: 'cheque', lines: [{ invoiceNo: inv.b, amount: '1' }] })).status).toBe(400);
  });

  it('1 % rate and a typed WHT amount; WHT cannot exceed the pre-VAT base', async () => {
    const r1 = await ok(env.owner.post('/api/ar/receipts', { customerId: C.c2, method: 'transfer', lines: [{ invoiceNo: inv.c2, amount: '535' }], wht: { mode: 'rate', rate: '1' } }), 201);
    expect(r1).toMatchObject({ wht: '5.00', cash: '530.00' });
    expect(await arOf(env, inv.c2!)).toBe('535.00');
    expect((await env.owner.post('/api/ar/receipts', { customerId: C.c2, method: 'cash', lines: [{ invoiceNo: inv.c2, amount: '535' }], wht: { mode: 'amount', amount: '501' } })).status).toBe(400);
    const r2 = await ok(env.owner.post('/api/ar/receipts', { customerId: C.c2, method: 'cash', lines: [{ invoiceNo: inv.c2, amount: '535' }], wht: { mode: 'amount', amount: '15' } }), 201);
    expect(r2).toMatchObject({ settled: '535.00', wht: '15.00', cash: '520.00', whtRate: null });
    expect(await arOf(env, inv.c2!)).toBe('0.00');
    const whtList = await ok(env.owner.get('/api/ar/receipts?status=wht'));
    expect(whtList.items).toHaveLength(3);
  });

  it('voiding a receipt gives the invoices their balance back; the invoice can be voided only after', async () => {
    const r = await ok(env.owner.post('/api/ar/receipts', { customerId: C.c1, method: 'transfer', lines: [{ invoiceNo: inv.b, amount: '1000' }] }), 201);
    expect(await arOf(env, inv.b!)).toBe('1675.00');
    const v = await env.owner.post(`/api/sales/docs/${inv.b}/void`, { reason: 'x' });
    expect(v.status).toBe(409);
    expect(v.body.details.docs).toEqual(expect.arrayContaining([r.no]));
    const vr = await ok(env.owner.post(`/api/ar/receipts/${r.no}/void`, { reason: 'โอนซ้ำ' }));
    expect(vr.status).toBe('void');
    expect(await arOf(env, inv.b!)).toBe('2675.00');
  });

  it('only fin.ar may receive money; sales may read', async () => {
    expect((await env.boy.post('/api/ar/receipts', { customerId: C.c1, method: 'cash', lines: [{ invoiceNo: inv.b, amount: '1' }] })).status).toBe(403);
    expect((await env.boy.get('/api/ar/receipts')).status).toBe(200);
    expect((await env.prae.get('/api/ar/aging')).status).toBe(403);
  });
});

describe('aging, due soon, statement (REQ-M10-04/05/06)', () => {
  it('buckets by days past the PEAK-term due date and totals every customer', async () => {
    const a = await ok(env.owner.get('/api/ar/aging'));
    expect(a.asOf).toBe('2026-10-26');
    const c1 = a.items.find((x: { customer: { id: string } }) => x.customer.id === C.c1);
    // old: due 2026-09-16 → 40 days late; b: 2,675 not due (30-day term)
    expect(c1.buckets).toEqual({ notDue: '2675.00', d1_30: '0.00', d31_60: '2140.00', d61_90: '0.00', over90: '0.00' });
    expect(c1).toMatchObject({ balance: '4815.00', invoices: 2, overdue: 1, limit: '200000.00' });
    expect(a.totals.total).toBe('4815.00');
    const later = await ok(env.owner.get('/api/ar/aging?asOf=2026-12-26'));
    expect(later.totals).toMatchObject({ d31_60: '2675.00', over90: '2140.00' });
    const over = await ok(env.owner.get('/api/ar/invoices?bucket=d31_60'));
    expect(over.items.map((x: { no: string; overdueDays: number }) => [x.no, x.overdueDays])).toEqual([[inv.old, 40]]);
  });

  it('home card: due within 7 days and overdue', async () => {
    const extra = await direct(C.c2!, '10', '20'); // due 2026-10-31
    const due = await ok(env.owner.get('/api/ar/due-soon'));
    expect(due.dueSoon).toEqual({ customers: 1, invoices: 1, amount: '214.00' });
    expect(due.overdue).toEqual({ customers: 1, invoices: 1, amount: '2140.00' });
    expect(extra).toMatch(/^INV/);
  });

  it('statement: opening balance, invoices, receipts and WHT with a running balance', async () => {
    const s = await ok(env.owner.get(`/api/ar/statement?customerId=${C.c1}&from=2026-10-01&to=2026-10-26`));
    expect(s.opening).toBe('2140.00');
    expect(s.lines.map((l: { kind: string }) => l.kind)).toEqual(['INV', 'INV', 'RC', 'WHT']);
    expect(s.closing).toBe('4815.00');
    expect(s.open.map((x: { no: string }) => x.no)).toEqual([inv.old, inv.b]);
  });

  it('BR-14: another shop sees none of these receivables', async () => {
    await seedMinimalTenant(env.pool, 'shopb', 'ร้าน B');
    const b = await login(env.app, 'owner', '1234').catch(async () => {
      const r = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner', password: '1234', tenant: 'shopb' } });
      return { get: (url: string) => env.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${JSON.parse(r.body).token}` } }).then((x) => ({ status: x.statusCode, body: JSON.parse(x.body) })) };
    });
    const a = await b.get('/api/ar/aging');
    expect(a.status).toBe(200);
    expect(a.body.items).toEqual([]);
    expect((await b.get(`/api/sales/invoices/${inv.a}`)).status).toBe(404);
  });
});
