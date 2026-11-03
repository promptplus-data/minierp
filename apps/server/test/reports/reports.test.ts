/** M11 reports: sales & GP cross-checked against documents and the stock ledger, stock as of a date, VAT, costs, dashboard, isolation. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedMinimalTenant } from '@erp/db';
import { d, sum } from '@erp/core';
import { login, saleBody, type Client } from '../helpers';
import { MONTH, TODAY, docSums, ledgerCogs, raw, setupReports, token, type ReportsEnv } from './helpers';

let env: ReportsEnv;
const FROM = `${MONTH}-01`;

beforeAll(async () => { env = await setupReports(); });
afterAll(async () => { await env.close(); });

const q = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

describe('sales and gross profit (REQ-M11-01)', () => {
  it('totals match the live documents and GP uses the ledger cost; voided bills are excluded', async () => {
    const want = await docSums(env, FROM, TODAY);
    const cogs = await ledgerCogs(env, FROM, TODAY);
    const r = await env.owner.get(`/api/reports/sales?${q({ from: FROM, to: TODAY, by: 'day', limit: 100 })}`);
    expect(r.status).toBe(200);
    expect(r.body.totals).toMatchObject({ net: want.net, vat: want.vat, total: want.total, bills: want.bills, returns: want.cns, cogs });
    expect(r.body.totals.gp).toBe(d(want.net).minus(d(cogs)).toFixed(2));
    expect(sum(r.body.rows.map((x: { total: string }) => x.total)).toFixed(2)).toBe(want.total);
    expect(r.body.voided.count).toBeGreaterThanOrEqual(2); // seeded void + today's
    const today = r.body.rows.find((x: { key: string }) => x.key === TODAY);
    expect(today.bills).toBe(3); // the voided bill is not counted
    expect(today.total).toBe('2437.00');
  });

  it('every grouping adds up to the same totals (product, category, customer, seller, sale type, month)', async () => {
    const day = (await env.owner.get(`/api/reports/sales?${q({ from: FROM, to: TODAY, by: 'day', limit: 100 })}`)).body.totals;
    for (const by of ['product', 'category', 'customer', 'seller', 'saleType', 'month']) {
      const r = await env.owner.get(`/api/reports/sales?${q({ from: FROM, to: TODAY, by, limit: 100 })}`);
      expect(r.status, by).toBe(200);
      expect(r.body.totals.total, by).toBe(day.total);
      for (const k of ['net', 'vat', 'total', 'cogs'] as const) expect(sum(r.body.rows.map((x: Record<string, string>) => x[k])).toFixed(2), `${by}.${k}`).toBe(day[k]);
    }
  });

  it('per product: quantity net of returns and FIFO cost equal to the ledger', async () => {
    const r = await env.owner.get(`/api/reports/sales?${q({ from: FROM, to: TODAY, by: 'product', q: 'SCG-CEM-T50' })}`);
    expect(r.body.rows).toHaveLength(1);
    const row = r.body.rows[0];
    const sold = await env.pool.query<{ q: string; c: string }>(
      `select sum(case when d.type = 'CN' then -l.base_qty else l.base_qty end)::text q,
              (select sum(case when m.qty < 0 then m.cost else -m.cost end) from stock_moves m join docs dd on dd.id = m.doc_id
                where m.product_id = $1 and dd.status = 'active' and dd.type in ('ABB','INV','RC','CN') and dd.date between $2 and $3)::numeric(14,2)::text c
         from doc_lines l join docs d on d.id = l.doc_id where l.product_id = $1 and d.status = 'active' and d.type in ('ABB','INV','RC','CN') and d.date between $2 and $3`,
      [env.seed.products.p1, FROM, TODAY]);
    expect(d(row.qty).eq(d(sold.rows[0]!.q))).toBe(true);
    expect(row.cogs).toBe(sold.rows[0]!.c);
    expect(row.sub).toBe('SCG-CEM-T50');
    expect(Number(row.gpPct)).toBeGreaterThan(0);
  });

  it('a restocked credit note lowers sales and cost (seeded CN of AAC blocks)', async () => {
    const r = await env.owner.get(`/api/reports/sales?${q({ from: FROM, to: TODAY, by: 'product', q: 'SCG-AAC-75' })}`);
    expect(r.body.rows[0].returns).toBe(1);
    expect(r.body.totals.returns).toBe(1);
  });

  it('sale type: POS documents are retail', async () => {
    const r = await env.owner.get(`/api/reports/sales?${q({ from: FROM, to: TODAY, by: 'saleType' })}`);
    expect(r.body.rows.map((x: { key: string }) => x.key)).toEqual(['retail']);
    const none = await env.owner.get(`/api/reports/sales?${q({ from: FROM, to: TODAY, by: 'day', saleType: 'whole' })}`);
    expect(none.body.totals.total).toBe('0.00');
  });

  it('pages with a cursor; totals stay for the whole period', async () => {
    const p1 = await env.owner.get(`/api/reports/sales?${q({ from: FROM, to: TODAY, by: 'product', limit: 2 })}`);
    expect(p1.body.rows).toHaveLength(2);
    const p2 = await env.owner.get(`/api/reports/sales?${q({ from: FROM, to: TODAY, by: 'product', limit: 2, cursor: p1.body.nextCursor })}`);
    expect(p2.body.rows[0].key).not.toBe(p1.body.rows[0].key);
    expect(p2.body.totals.total).toBe(p1.body.totals.total);
    expect(d(p1.body.rows[0].net).gte(d(p1.body.rows[1].net))).toBe(true); // largest first
  });

  it('cost and GP are hidden without data.cost; cashier has no report access', async () => {
    const boy = await login(env.app, 'boy');
    const r = await boy.get(`/api/reports/sales?${q({ from: FROM, to: TODAY })}`);
    expect(r.status).toBe(200);
    expect(r.body.costVisible).toBe(false);
    expect(r.body.totals.cogs).toBeNull();
    expect(r.body.rows.every((x: { gp: unknown }) => x.gp === null)).toBe(true);
    const prae = await login(env.app, 'prae');
    expect((await prae.get(`/api/reports/sales?${q({ from: FROM, to: TODAY })}`)).status).toBe(403);
  });

  it('rejects bad ranges', async () => {
    expect((await env.owner.get(`/api/reports/sales?${q({ from: TODAY, to: FROM })}`)).status).toBe(400);
    expect((await env.owner.get(`/api/reports/sales?${q({ from: '2024-01-01', to: TODAY })}`)).status).toBe(400);
  });

  it('downloads CSV (UTF-8 BOM, Thai) and XLSX with the same totals', async () => {
    const t = await token(env.app, 'charoen');
    const csv = await raw(env.app, t, `/api/reports/sales?${q({ from: FROM, to: TODAY, by: 'day', format: 'csv' })}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('attachment');
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    expect(csv.text).toContain('รายงานยอดขายและกำไรขั้นต้น');
    const want = await docSums(env, FROM, TODAY);
    const last = csv.text.trim().split('\r\n').at(-1)!;
    expect(last.split(',')).toContain(want.total);
    const x = await raw(env.app, t, `/api/reports/sales?${q({ from: FROM, to: TODAY, by: 'day', format: 'xlsx' })}`);
    expect(x.status).toBe(200);
    expect(x.body.subarray(0, 2).toString()).toBe('PK');
    expect(x.headers['content-type']).toContain('spreadsheetml');
  });
});

describe('stock on hand (REQ-M11-02)', () => {
  it('today: quantity and FIFO value equal the live lots', async () => {
    const r = await env.owner.get(`/api/reports/stock?${q({ limit: 100 })}`);
    expect(r.status).toBe(200);
    const lots = await env.pool.query<{ q: string; v: string }>(
      `select sum(remaining)::text q, sum(remaining * unit_cost)::numeric(14,2)::text v from stock_lots where tenant_id = $1`, [env.seed.tenantId]);
    expect(d(r.body.totals.qty).eq(d(lots.rows[0]!.q))).toBe(true);
    expect(r.body.totals.value).toBe(lots.rows[0]!.v);
    const cement = r.body.rows.find((x: { sku: string }) => x.sku === 'SCG-CEM-T50');
    const cl = await env.pool.query<{ q: string; v: string }>(`select sum(remaining)::text q, sum(remaining * unit_cost)::numeric(14,2)::text v from stock_lots where product_id = $1`, [env.seed.products.p1]);
    expect(d(cement.qty).eq(d(cl.rows[0]!.q))).toBe(true);
    expect(cement.value).toBe(cl.rows[0]!.v);
    expect(cement.lastOut).toBe(TODAY);
  });

  it('as of yesterday puts back what was sold today (from the same lots) and ignores the void', async () => {
    const yesterday = (await env.owner.get(`/api/reports/stock?${q({ asOf: '2026-10-25', q: 'SCG-CEM-T50' })}`)).body.rows[0];
    const now = (await env.owner.get(`/api/reports/stock?${q({ q: 'SCG-CEM-T50' })}`)).body.rows[0];
    expect(d(yesterday.qty).minus(d(now.qty)).toFixed()).toBe('10');
    const soldCost = await env.pool.query<{ c: string }>(`select sum(m.cost)::text c from stock_moves m join docs dd on dd.id = m.doc_id where dd.no = $1 and m.product_id = $2`, [env.today.cement, env.seed.products.p1]);
    expect(d(yesterday.value).minus(d(now.value)).toFixed(2)).toBe(d(soldCost.rows[0]!.c).toFixed(2));
    const roof = (await env.owner.get(`/api/reports/stock?${q({ asOf: '2026-10-25', q: 'SCG-ROOF-LK' })}`)).body.rows[0];
    const roofNow = (await env.owner.get(`/api/reports/stock?${q({ q: 'SCG-ROOF-LK' })}`)).body.rows[0];
    expect(roof.qty).toBe(roofNow.qty); // sold and voided today: no net change
  });

  it('per warehouse, below reorder point and slow movers', async () => {
    const wh2 = await env.owner.get(`/api/reports/stock?${q({ warehouseId: env.seed.warehouses.WH2, q: 'SCG-CEM-T50' })}`);
    expect(wh2.body.rows[0].qty).toBe('340');
    await env.pool.query(`update products set reorder_point = 50 where id = $1`, [env.seed.products.p7]); // 10 left
    const low = await env.owner.get(`/api/reports/stock?${q({ only: 'low', limit: 100 })}`);
    expect(low.body.rows.map((x: { sku: string }) => x.sku)).toContain('PNT-PR9');
    const lowSql = await env.pool.query<{ n: number }>(
      `select count(*)::int n from products p where p.tenant_id = $1 and p.kind = 'stock' and p.active and p.reorder_point > 0
          and coalesce((select sum(remaining) from stock_lots l where l.product_id = p.id), 0) < p.reorder_point`, [env.seed.tenantId]);
    expect(low.body.rows).toHaveLength(lowSql.rows[0]!.n);
    expect(low.body.rows.every((x: { low: boolean }) => x.low)).toBe(true);
    const slow = await env.owner.get(`/api/reports/stock?${q({ only: 'slow', slowDays: 30, limit: 100 })}`);
    const skus = slow.body.rows.map((x: { sku: string }) => x.sku);
    expect(skus).toContain('SAND-C'); // never sold
    expect(skus).not.toContain('SCG-CEM-T50'); // sold today
  });

  it('value hidden without data.cost', async () => {
    const boy = await login(env.app, 'boy');
    const r = await boy.get('/api/reports/stock');
    expect(r.body.totals.value).toBeNull();
    expect(r.body.rows[0].value).toBeNull();
  });
});

describe('VAT reports (REQ-M11-03)', () => {
  it('output VAT: ABB summarised per day per POS, voided ABB at 0, totals equal the documents', async () => {
    const r = await env.owner.get(`/api/reports/vat?${q({ month: MONTH, limit: 100 })}`);
    expect(r.status).toBe(200);
    const want = await env.pool.query<{ base7: string; vat: string; n: number; voided: number }>(
      `select coalesce(sum(case when status = 'void' then 0 when type = 'CN' then -base7 else base7 end), 0)::numeric(14,2)::text base7,
              coalesce(sum(case when status = 'void' then 0 when type = 'CN' then -vat else vat end), 0)::numeric(14,2)::text vat,
              count(*)::int n, (count(*) filter (where status = 'void'))::int voided
         from docs where tenant_id = $1 and type in ('ABB','INV','CN') and date between $2 and $3`, [env.seed.tenantId, FROM, TODAY]);
    expect(r.body.totals).toMatchObject({ base7: want.rows[0]!.base7, vat: want.rows[0]!.vat, docs: want.rows[0]!.n, voided: want.rows[0]!.voided });
    const todayAbb = r.body.rows.find((x: { date: string; no: string }) => x.date === TODAY && x.no.startsWith('ABB'));
    expect(todayAbb.no).toContain('–');
    expect(todayAbb.name).toContain('POS-1');
    expect(todayAbb.note).toContain(`ยกเลิก 1 ใบ (${env.today.voided})`);
    expect(todayAbb.total).toBe('2017.00'); // 1,750 + 267; the voided 260 counts as 0
    const inv = r.body.rows.find((x: { no: string }) => x.no === env.today.inv);
    expect(inv).toMatchObject({ taxId: '0503558001234', branch: 'สำนักงานใหญ่', base7: '392.52', vat: '27.48' });
    const cn = r.body.rows.find((x: { no: string }) => x.no.startsWith('CN'));
    expect(Number(cn.total)).toBeLessThan(0);
    expect(r.body.shop.taxId).toBe('0505561004321');
  });

  it('a voided full tax invoice stays with zero amounts', async () => {
    const prae = await login(env.app, 'prae');
    const shift = (await prae.get('/api/shifts/current')).body.id;
    const s = await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p4', qty: '1', price: '210.00' }], '210.00', { docKind: 'full', customerId: env.seed.customers.c1 }));
    await env.owner.post(`/api/sales/docs/${s.body.no}/void`, { reason: 'ออกผิดลูกค้า / ข้อมูลภาษีผิด' });
    const r = await env.owner.get(`/api/reports/vat?${q({ month: MONTH, limit: 100 })}`);
    expect(r.body.rows.find((x: { no: string }) => x.no === s.body.no)).toMatchObject({ base7: '0.00', vat: '0.00', total: '0.00', note: 'ยกเลิก: ออกผิดลูกค้า / ข้อมูลภาษีผิด' });
  });

  it('input VAT from manual goods receipts: 7% per document with the vendor tax invoice number', async () => {
    const gr = await env.owner.post('/api/stock/receipts', {
      vendorId: env.seed.vendors.v2, vendorInvoiceNo: 'IV-6610-0042', deliveryNo: 'DN-1', warehouseId: env.seed.warehouses.WH2,
      lines: [{ productId: env.seed.products.p6, qty: '20', unitCost: '70.50' }], billDiscount: '10',
    });
    expect(gr.status).toBe(201);
    const r = await env.owner.get(`/api/reports/vat?${q({ month: MONTH, kind: 'purchase' })}`);
    expect(r.body.rows).toHaveLength(1);
    expect(r.body.rows[0]).toMatchObject({ no: 'IV-6610-0042', name: 'บจก. ท่อไทยค้าส่ง', taxId: '0105556012345', base7: '1400.00', vat: '98.00', total: '1498.00' });
    expect(r.body.sources[0].available).toBe(false);
    const t = await token(env.app, 'charoen');
    const csv = await raw(env.app, t, `/api/reports/vat?${q({ month: MONTH, kind: 'purchase', format: 'csv' })}`);
    expect(csv.text).toContain('รายงานภาษีซื้อ');
    expect(csv.text).toContain('เดือนภาษี ตุลาคม 2569');
  });
});

describe('internal cost (REQ-M11-06)', () => {
  it('issues and adjustments at FIFO cost; profit after internal cost', async () => {
    const before = (await env.owner.get(`/api/reports/costs?month=${MONTH}`)).body;
    const iss = await env.owner.post('/api/stock/issues', { warehouseId: env.seed.warehouses.WH2, lines: [{ productId: env.seed.products.p3, qty: '10' }], reason: 'ใช้ในร้าน' });
    expect(iss.status).toBe(201);
    const chai = await login(env.app, 'chai');
    const rq = await chai.post('/api/stock/adjust-requests', { warehouseId: env.seed.warehouses.WH2, lines: [{ productId: env.seed.products.p2, qtyDelta: '-3' }], reason: 'สินค้าแตกเสียหาย' });
    await env.owner.post(`/api/stock/adjust-requests/${rq.body.id}/approve`, {});
    const r = await env.owner.get(`/api/reports/costs?month=${MONTH}`);
    expect(r.status).toBe(200);
    const issueCost = await env.pool.query<{ c: string }>(`select sum(cost)::text c from stock_moves where doc_no = $1`, [iss.body.no]);
    const line = (k: string) => r.body.lines.find((x: { key: string }) => x.key === k);
    expect(d(line('issue').amount).minus(d(before.lines.find((x: { key: string }) => x.key === 'issue').amount)).toFixed(2)).toBe(d(issueCost.rows[0]!.c).toFixed(2));
    expect(line('adjShort').count).toBe(1);
    expect(d(line('adjShort').amount).gt(0)).toBe(true);
    expect(r.body.profitAfter).toBe(d(r.body.gp).minus(d(r.body.totalCost)).toFixed(2));
    expect(r.body.sources[0]).toMatchObject({ key: 'payroll', available: false });
  });
  it('needs data.cost', async () => {
    const boy = await login(env.app, 'boy');
    expect((await boy.get(`/api/reports/costs?month=${MONTH}`)).status).toBe(403);
  });
  it('promotions report says the source is missing', async () => {
    const r = await env.owner.get(`/api/reports/promotions?${q({ from: FROM, to: TODAY })}`);
    expect(r.body.rows).toEqual([]);
    expect(r.body.sources[0].available).toBe(false);
  });
});

describe('home dashboard (REQ-M11-04)', () => {
  it('owner: today, low stock, approvals and month cards match the data', async () => {
    const chai = await login(env.app, 'chai');
    await chai.post('/api/stock/adjust-requests', { warehouseId: env.seed.warehouses.WH1, lines: [{ productId: env.seed.products.p7, qtyDelta: '1' }], reason: 'นับแล้วไม่ตรง' });
    const r = await env.owner.get('/api/reports/dashboard');
    expect(r.status).toBe(200);
    const want = await env.pool.query<{ t: string; n: number }>(
      `select sum(total)::text t, count(*)::int n from docs where tenant_id = $1 and date = $2 and status = 'active' and type in ('ABB','INV','RC')`, [env.seed.tenantId, TODAY]);
    expect(r.body.salesToday).toMatchObject({ total: d(want.rows[0]!.t).toFixed(2), bills: want.rows[0]!.n });
    expect(r.body.sales7d).toHaveLength(7);
    expect(r.body.sales7d.at(-1).date).toBe(TODAY);
    expect(r.body.lowStock.count).toBeGreaterThan(0);
    expect(r.body.lowStock.items.map((x: { name: string }) => x.name)).toContain('สีรองพื้นปูนใหม่ 9 ลิตร');
    expect(r.body.approvals.count).toBe(1);
    expect(r.body.approvals.items[0].path).toBe('/stock');
    expect(r.body.month.gp).not.toBeNull();
    expect(r.body.arDue).toMatchObject({ count: 0 });
    expect(r.body.sources.map((x: { key: string }) => x.key)).toContain('grPending');
  });
  it('cashier: sales today only, nothing about cost, stock approvals or receivables', async () => {
    const prae = await login(env.app, 'prae');
    const r = await prae.get('/api/reports/dashboard');
    expect(r.body.salesToday).not.toBeNull();
    expect(r.body).toMatchObject({ month: null, sales7d: null, approvals: null, arDue: null });
  });
});

describe('tenant isolation (BR-14)', () => {
  let other: Client;
  beforeAll(async () => {
    const b = await seedMinimalTenant(env.pool, 'shopb', 'ร้านบี');
    other = await login(env.app, 'owner');
    void b;
  });
  it('another shop sees none of these documents, lots or exports', async () => {
    const s = await other.get(`/api/reports/sales?${q({ from: FROM, to: TODAY })}`);
    expect(s.body.totals).toMatchObject({ total: '0.00', bills: 0 });
    const st = await other.get('/api/reports/stock');
    expect(st.body.rows.map((x: { sku: string }) => x.sku)).toEqual(['B-ONLY']);
    const v = await other.get(`/api/reports/vat?month=${MONTH}`);
    expect(v.body.rows).toEqual([]);
    const dash = await other.get('/api/reports/dashboard');
    expect(dash.body.salesToday.total).toBe('0.00');
    const run = await env.owner.post('/api/acct-export/runs', { template: 'generic', dataset: 'sales', from: FROM, to: TODAY });
    expect(run.status).toBe(201);
    expect((await other.get('/api/acct-export/runs')).body.items).toEqual([]);
    expect((await other.get(`/api/acct-export/runs/${run.body.id}`)).status).toBe(404);
    const t = await token(env.app, 'owner');
    expect((await raw(env.app, t, `/api/acct-export/runs/${run.body.id}/files/1`)).status).toBe(404);
  });
});

describe('editions', () => {
  it('the SCG Family coupon report is not on on-prem', async () => {
    expect((await env.owner.get(`/api/reports/coupons?${q({ from: FROM, to: TODAY })}`)).status).toBe(404);
  });
});
