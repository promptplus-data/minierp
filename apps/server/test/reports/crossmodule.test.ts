/** M11 / M12 against the other groups' documents: B2B invoices (A), AP bills (B), promotions (C), payroll (D). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedAdmin } from '@erp/db/src/seedAdmin';
import { d, sum } from '@erp/core';
import { login } from '../helpers';
import { MONTH, TODAY, ledgerCogs, raw, setupReports, token, type ReportsEnv } from './helpers';

let env: ReportsEnv;
const FROM = `${MONTH}-01`;
const q = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
const totals = async () => (await env.owner.get(`/api/reports/sales?${q({ from: FROM, to: TODAY })}`)).body.totals;

beforeAll(async () => {
  env = await setupReports();
  await seedAdmin(env.pool, env.seed.tenantId);
});
afterAll(async () => { await env.close(); });

describe('B2B invoices (group A) in sales, GP, VAT and the home cards', () => {
  it('a credit invoice adds exactly its ex-VAT value, VAT and ledger cost; a void takes it all back', async () => {
    const before = await totals();
    const boy = await login(env.app, 'boy');
    const r = await boy.post('/api/sales/invoices', {
      source: 'direct', customerId: env.seed.customers.c2, warehouseId: env.seed.warehouses.WH2, lines: [{ productId: env.seed.products.p4, qty: '10', unitPrice: '196.26' }],
    });
    expect(r.status).toBe(201);
    const no = r.body.doc.no as string;
    const t = r.body.doc.totals as { base7: string; exempt: string; vat: string; total: string };
    const after = await totals();
    expect(d(after.net).minus(d(before.net)).toFixed(2)).toBe(d(t.base7).plus(d(t.exempt)).toFixed(2));
    expect(d(after.vat).minus(d(before.vat)).toFixed(2)).toBe(d(t.vat).toFixed(2));
    expect(after.bills - before.bills).toBe(1);
    const cost = await env.pool.query<{ c: string }>(`select sum(m.cost)::text c from stock_moves m join docs x on x.id = m.doc_id where x.no = $1`, [no]);
    expect(d(after.cogs).minus(d(before.cogs)).toFixed(2)).toBe(d(cost.rows[0]!.c).toFixed(2));
    expect(after.cogs).toBe(await ledgerCogs(env, FROM, TODAY));
    const whole = (await env.owner.get(`/api/reports/sales?${q({ from: FROM, to: TODAY, by: 'saleType', saleType: 'whole' })}`)).body.totals;
    expect(d(whole.net).gte(d(t.base7))).toBe(true);

    const vat = await env.owner.get(`/api/reports/vat?${q({ month: MONTH, limit: 100 })}`);
    expect(vat.body.rows.find((x: { no: string }) => x.no === no)).toMatchObject({ base7: t.base7, vat: t.vat, total: t.total, name: expect.stringContaining('') });
    const dash = await env.owner.get('/api/reports/dashboard');
    expect(dash.body.arDue.items.map((x: { no: string }) => x.no)).toContain(no);
    expect(dash.body.arDue.items.find((x: { no: string }) => x.no === no).balance).toBe(t.total);

    expect((await env.owner.post(`/api/sales/docs/${no}/void`, { reason: 'ออกผิดลูกค้า' })).status).toBe(200);
    const back = await totals();
    expect(back).toMatchObject({ net: before.net, vat: before.vat, bills: before.bills, cogs: before.cogs });
    const vat2 = await env.owner.get(`/api/reports/vat?${q({ month: MONTH, limit: 100 })}`);
    expect(vat2.body.rows.find((x: { no: string }) => x.no === no)).toMatchObject({ base7: '0.00', vat: '0.00', total: '0.00' });
    expect((await env.owner.get('/api/reports/dashboard')).body.arDue.items.map((x: { no: string }) => x.no)).not.toContain(no);
  });
});

describe('AP bills (group B) in the input VAT report and the purchase book', () => {
  it('input VAT equals the AP bills of the month, discount and all; the export has the same VAT', async () => {
    const gr = await env.owner.post('/api/stock/receipts', {
      vendorId: env.seed.vendors.v1, vendorInvoiceNo: 'TV-X-501', deliveryNo: 'DN-501', warehouseId: env.seed.warehouses.WH2,
      lines: [{ productId: env.seed.products.p1, qty: '30', unitCost: '120.00' }, { productId: env.seed.products.p3, qty: '100', unitCost: '19.00' }], billDiscount: '100',
    });
    expect(gr.status).toBe(201);
    const bills = await env.pool.query<{ vat: string; net: string; n: number }>(
      `select coalesce(sum(vat), 0)::text vat, coalesce(sum(base - discount), 0)::text net, count(*)::int n from ap_bills
        where tenant_id = $1 and source = 'gr' and status = 'active' and to_char(date, 'YYYY-MM') = $2`, [env.seed.tenantId, MONTH]);
    const v = await env.owner.get(`/api/reports/vat?${q({ month: MONTH, kind: 'purchase', limit: 100 })}`);
    expect(v.body.totals.docs).toBe(bills.rows[0]!.n);
    expect(v.body.totals.vat).toBe(d(bills.rows[0]!.vat).toFixed(2));
    expect(d(v.body.totals.base7).plus(d(v.body.totals.exempt)).toFixed(2)).toBe(d(bills.rows[0]!.net).toFixed(2));
    const mine = v.body.rows.find((x: { no: string }) => x.no === 'TV-X-501');
    const ex = await env.owner.post('/api/acct-export/runs', { template: 'peak', dataset: 'purchase', from: TODAY, to: TODAY });
    expect(ex.status).toBe(201);
    const f = await raw(env.app, await token(env.app, 'charoen'), `/api/acct-export/runs/${ex.body.id}/files/1`);
    const all = f.text.replace(/^\uFEFF/, '').trimEnd().split('\r\n').slice(2).map((l) => l.split(','));
    const at = all.findIndex((x) => x[2] === 'TV-X-501');
    const rows = all.slice(at, at + 3);
    expect(rows).toHaveLength(3); // two goods lines and the discount line
    expect(sum(rows.map((x) => x[17]!)).toFixed(2)).toBe('5400.00');
    expect(sum(rows.map((x) => x[18]!)).toFixed(2)).toBe('378.00');
    expect(mine).toMatchObject({ base7: '5400.00', vat: '378.00', total: '5778.00' }); // 3,600 + 1,900 − 100 discount, VAT on 5,400
  });
});

describe('promotions (group C) and labour cost (group D)', () => {
  it('the promotion report lists what the retail report lists', async () => {
    const created = await env.owner.post('/api/promos', {
      name: 'ลดท่อ PVC 10%', kind: 'disc', mode: 'pct', value: '10', items: [{ productId: env.seed.products.p6 }],
      channels: ['pos'], start: FROM, end: `${MONTH}-31`,
    });
    expect(created.status).toBe(201);
    const mine = (await env.owner.get(`/api/reports/promotions?${q({ from: FROM, to: TODAY })}`)).body;
    const theirs = (await env.owner.get(`/api/promos/pnl?${q({ from: FROM, to: TODAY })}`)).body.items;
    expect(mine.sources[0].available).toBe(true);
    expect(mine.rows.map((x: { key: string }) => x.key).sort()).toEqual(theirs.map((x: { promoId: string }) => x.promoId).sort());
    expect(mine.rows).toHaveLength(1);
    expect(mine.rows[0]).toMatchObject({ bills: 0, sales: '0.00' });
  });

  it('payroll and employer SSO of an approved run enter the internal cost; hidden without hr.salary', async () => {
    const r = await env.owner.get('/api/reports/costs?month=2026-09');
    const hr = await env.pool.query<{ gross: string; sso: string }>(`select gross::text, employer_sso::text sso from hr_labour_cost_monthly where tenant_id = $1 and period = '2026-09'`, [env.seed.tenantId]);
    expect(hr.rowCount).toBe(1);
    const line = (k: string) => r.body.lines.find((x: { key: string }) => x.key === k);
    expect(line('payroll').amount).toBe(hr.rows[0]!.gross);
    expect(line('sso').amount).toBe(hr.rows[0]!.sso);
    expect(r.body.sources[0]).toMatchObject({ key: 'payroll', available: true });
    expect(d(r.body.totalCost).gte(d(hr.rows[0]!.gross).plus(d(hr.rows[0]!.sso)))).toBe(true);
    const mgr = await login(env.app, 'suda'); // accountant/manager: data.cost yes, hr.salary no
    const m = await mgr.get('/api/reports/costs?month=2026-09');
    if (m.status === 200) expect(m.body.lines.find((x: { key: string }) => x.key === 'payroll').amount).toBeNull();
  });

  it('pending leave requests reach the manager home approvals card, not the cashier', async () => {
    const owner = (await env.owner.get('/api/reports/dashboard')).body;
    const n = await env.pool.query<{ n: number }>(`select count(*)::int n from leave_requests where tenant_id = $1 and status = 'pending'`, [env.seed.tenantId]);
    expect(owner.approvals.items.filter((x: { kind: string }) => x.kind === 'leave').length).toBe(Math.min(5, n.rows[0]!.n));
    expect((await (await login(env.app, 'prae')).get('/api/reports/dashboard')).body.approvals).toBeNull();
  });
});
