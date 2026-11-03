/** M12 accounting export: PEAK templates, FlowAccount / Express / journal / generic, GL mapping, history, only-new, changed-after-export. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { d, sum } from '@erp/core';
import { login } from '../helpers';
import { MONTH, TODAY, docSums, raw, setupReports, token, type ReportsEnv } from './helpers';

let env: ReportsEnv;
let tk: string;
const FROM = `${MONTH}-01`;

beforeAll(async () => {
  env = await setupReports();
  tk = await token(env.app, 'charoen');
});
afterAll(async () => { await env.close(); });

/** CSV text → rows (no quoted commas in our test data except where noted). */
const parse = (text: string) => text.replace(/^﻿/, '').trimEnd().split('\r\n').map((l) => {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i]!;
    if (quoted) {
      if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
});
const file = async (runId: string, seq: number) => {
  const r = await raw(env.app, tk, `/api/acct-export/runs/${runId}/files/${seq}`);
  expect(r.status).toBe(200);
  return r;
};
const run = (body: Record<string, unknown>) => env.owner.post('/api/acct-export/runs', body);

describe('GL mapping', () => {
  it('defaults to the shop chart; accountant edits it and the change is audited', async () => {
    const acct = await env.owner.get('/api/acct-export/gl');
    expect(acct.body).toMatchObject({ sale: '410101', buy: '114102', cogs: '510103', pdisc: '510104' });
    const prae = await login(env.app, 'prae');
    expect((await prae.patch('/api/acct-export/gl', { sale: '410199' })).status).toBe(403);
    const r = await env.owner.patch('/api/acct-export/gl', { sale: '410102' });
    expect(r.body.sale).toBe('410102');
    expect((await env.owner.patch('/api/acct-export/gl', { sale: 'bad code!' })).status).toBe(400);
    const log = await env.pool.query<{ detail: string }>(`select detail from audit_log where tenant_id = $1 and object = 'gl-mapping'`, [env.seed.tenantId]);
    expect(log.rows[0]!.detail).toBe('รายได้ขาย: 410101 → 410102');
    await env.owner.patch('/api/acct-export/gl', { sale: '410101' });
  });
});

describe('PEAK (REQ-M12-06)', () => {
  it('sales: 2 header rows, 21 columns, one row per line, credit notes in their own file, account 410101', async () => {
    const r = await run({ template: 'peak', dataset: 'sales', from: FROM, to: TODAY });
    expect(r.status).toBe(201);
    expect(r.body.files.map((f: { name: string }) => f.name)).toEqual([`peak-sales-${FROM}_${TODAY}.csv`, `peak-creditnotes-${FROM}_${TODAY}.csv`]);
    const rows = parse((await file(r.body.id, 1)).text);
    expect(rows[0]).toHaveLength(21);
    expect(rows[1]![0]).toBe('');
    expect(rows[1]![1]).toBe('วันที่เอกสาร* (yyyymmdd)');
    const data = rows.slice(2);
    for (const x of data) expect(x).toHaveLength(21);
    const lines = await env.pool.query<{ n: number; docs: number }>(
      `select count(*)::int n, count(distinct d.id)::int docs from doc_lines l join docs d on d.id = l.doc_id
        where d.tenant_id = $1 and d.status = 'active' and d.type in ('ABB','INV','RC') and d.date between $2 and $3`, [env.seed.tenantId, FROM, TODAY]);
    expect(data).toHaveLength(lines.rows[0]!.n);
    expect(Number(data.at(-1)![0])).toBe(lines.rows[0]!.docs);
    expect(new Set(data.map((x) => x[12]))).toEqual(new Set(['410101']));
    // ex-VAT + VAT of every line add up to the documents
    const want = await env.pool.query<{ net: string; vat: string }>(
      `select sum(base7 + exempt)::numeric(14,2)::text net, sum(vat)::numeric(14,2)::text vat from docs
        where tenant_id = $1 and status = 'active' and type in ('ABB','INV','RC') and date between $2 and $3`, [env.seed.tenantId, FROM, TODAY]);
    expect(sum(data.map((x) => x[17]!)).toFixed(2)).toBe(want.rows[0]!.net);
    expect(sum(data.map((x) => x[18]!)).toFixed(2)).toBe(want.rows[0]!.vat);
    const inv = data.find((x) => x[2] === env.today.inv)!;
    expect(inv.slice(4, 10)).toEqual(['C00001', 'หจก. รุ่งเรืองก่อสร้าง', '0503558001234', '00000', '', 'รวมภาษี']);
    expect(data.some((x) => x[2] === env.today.voided)).toBe(false);
    const cn = parse((await file(r.body.id, 2)).text).slice(2);
    expect(cn[0]![3]).toMatch(/^ABB/); // อ้างอิงถึง
  });

  it('products: 21 columns with FIFO lots as extra rows; needs data.cost', async () => {
    const r = await run({ template: 'peak', dataset: 'products' });
    expect(r.status).toBe(201);
    const rows = parse((await file(r.body.id, 1)).text);
    expect(rows[1]).toHaveLength(21);
    const cement = rows.filter((x) => x[1] === 'SCG-CEM-T50');
    expect(cement[0]!.slice(9, 14)).toEqual(['114102', '410101', 'คำนวณ', 'FIFO', '510103']);
    const lotRows = rows.filter((x) => x[0] === cement[0]![0]);
    const lots = await env.pool.query<{ n: number }>(
      `select count(distinct (to_char(received_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD'), unit_cost))::int n from stock_lots where product_id = $1 and remaining > 0`, [env.seed.products.p1]);
    expect(lotRows).toHaveLength(lots.rows[0]!.n);
    expect(rows.find((x) => x[1] === 'SV-DLV')!.slice(11, 14)).toEqual(['ไม่คำนวณ', '', '']);
    const boy = await login(env.app, 'boy');
    expect((await boy.post('/api/acct-export/runs', { template: 'peak', dataset: 'products' })).status).toBe(403);
  });

  it('contacts: 47 columns, more than 1,000 rows split into files of at most 1,000 renumbered from 1', async () => {
    await env.pool.query(
      `insert into customers (tenant_id, code, name, phone) select $1, 'CX' || lpad(g::text, 5, '0'), 'ลูกค้าทดสอบ ' || g, '08' || lpad(g::text, 8, '0') from generate_series(1, 1200) g`,
      [env.seed.tenantId]);
    const r = await run({ template: 'peak', dataset: 'contacts' });
    expect(r.status).toBe(201);
    expect(r.body.files).toHaveLength(2);
    expect(r.body.files[0].rows).toBe(1000);
    expect(r.body.files[1].rows).toBe(1200 + 3 + 3 - 1000); // + demo customers (minus walk-in) + vendors
    expect(r.body.warnings.join(' ')).toContain('1,000');
    const f2 = parse((await file(r.body.id, 2)).text);
    expect(f2[1]).toHaveLength(47);
    expect(f2[2]![0]).toBe('1');
    const vendor = f2.find((x) => x[1] === 'V00002')!;
    expect(vendor.slice(2, 7)).toEqual(['ผู้ขาย', 'ไทย', '0105556012345', '00000', 'นิติบุคคล']);
    expect(vendor.slice(32, 36)).toEqual(['วันที่ X ของเดือนถัดไป', '5', '113101', '212101']);
  });

  it('purchase: goods receipts at account 114102 with 7% input VAT', async () => {
    await env.owner.post('/api/stock/receipts', {
      vendorId: env.seed.vendors.v1, vendorInvoiceNo: 'TV-6610-118', deliveryNo: 'DN-118', warehouseId: env.seed.warehouses.WH2,
      lines: [{ productId: env.seed.products.p1, qty: '40', unitCost: '121.50' }, { productId: env.seed.products.p3, qty: '200', unitCost: '19.20' }], billDiscount: '0',
    });
    const r = await run({ template: 'peak', dataset: 'purchase', from: FROM, to: TODAY });
    const rows = parse((await file(r.body.id, 1)).text).slice(2);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.slice(1, 6)).toEqual([TODAY.replace(/-/g, ''), 'TV-6610-118', rows[0]![3], 'V00001', 'หจก. ทวีพัฒนาวัสดุ (ผู้แทนจำหน่าย)']);
    expect(rows[0]![9]).toBe('แยกภาษี');
    expect(rows.map((x) => x[12])).toEqual(['114102', '114102']);
    expect(sum(rows.map((x) => x[17]!)).toFixed(2)).toBe('8700.00');
    expect(sum(rows.map((x) => x[18]!)).toFixed(2)).toBe('609.00');
    expect(r.body.warnings.join(' ')).toContain('ภาษีซื้อ 7%');
  });
});

describe('other programs and files (REQ-M12-01..03)', () => {
  it('generic sales book: totals equal the sales report; voided documents listed at 0', async () => {
    const r = await run({ template: 'generic', dataset: 'sales', from: FROM, to: TODAY });
    const rows = parse((await file(r.body.id, 1)).text);
    expect(rows[0]![0]).toBe('เลขที่');
    const want = await docSums(env, FROM, TODAY);
    expect(rows.at(-1)![9]).toBe(want.total);
    const rep = await env.owner.get(`/api/reports/sales?from=${FROM}&to=${TODAY}`);
    expect(rows.at(-1)![9]).toBe(rep.body.totals.total);
    expect(rows.find((x) => x[0] === env.today.voided)!.slice(9)).toEqual(['0.00', 'ยกเลิก']);
  });

  it('Express and FlowAccount: their column headers, credit notes negative', async () => {
    const ex = await run({ template: 'express', dataset: 'sales', from: FROM, to: TODAY });
    const e = parse((await file(ex.body.id, 1)).text);
    expect(e[0]).toEqual(['DOCNUM', 'DOCDAT', 'CUSCOD', 'AMOUNT', 'VATAMT', 'NETAMT']);
    expect(e.find((x) => x[0]!.startsWith('CN'))![5]!.startsWith('-')).toBe(true);
    expect(e.find((x) => x[0] === env.today.inv)!.slice(1, 3)).toEqual(['26/10/2569', 'C00001']);
    const fa = await run({ template: 'flowaccount', dataset: 'sales', from: FROM, to: TODAY, format: 'xlsx' });
    const x = await file(fa.body.id, 1);
    expect(x.headers['content-type']).toContain('spreadsheetml');
    expect(x.body.subarray(0, 2).toString()).toBe('PK');
    expect(fa.body.files[0].name).toMatch(/\.xlsx$/);
  });

  it('journal: debit equals credit for every document', async () => {
    const r = await run({ template: 'journal', dataset: 'sales', from: FROM, to: TODAY });
    const rows = parse((await file(r.body.id, 1)).text).slice(1);
    const byDoc = new Map<string, { dr: ReturnType<typeof d>; cr: ReturnType<typeof d> }>();
    for (const x of rows) {
      const t = byDoc.get(x[1]!) ?? { dr: d(0), cr: d(0) };
      byDoc.set(x[1]!, { dr: t.dr.plus(d(x[4] || 0)), cr: t.cr.plus(d(x[5] || 0)) });
    }
    expect(byDoc.size).toBeGreaterThan(10);
    for (const [no, t] of byDoc) expect(t.dr.toFixed(2), no).toBe(t.cr.toFixed(2));
    expect(rows.some((x) => x[2] === '215101')).toBe(true);
  });

  it('VAT report and stock as files; receipts by payment method', async () => {
    const v = await run({ template: 'generic', dataset: 'vatSales', from: FROM, to: TODAY });
    expect(parse((await file(v.body.id, 1)).text)[0]![0]).toBe('รายงานภาษีขาย');
    expect((await run({ template: 'generic', dataset: 'vatSales', from: '2026-09-01', to: TODAY })).status).toBe(400);
    const s = await run({ template: 'generic', dataset: 'stock', from: FROM, to: TODAY });
    expect(s.body.files[0].rows).toBeGreaterThan(5);
    const rc = await run({ template: 'generic', dataset: 'receipts', from: FROM, to: TODAY });
    const rows = parse((await file(rc.body.id, 1)).text);
    const want = await docSums(env, FROM, TODAY);
    expect(rows.at(-1)![4]).toBe(want.total);
  });

  it('rejects a template/data mismatch and a missing range', async () => {
    expect((await run({ template: 'express', dataset: 'products' })).status).toBe(400);
    expect((await run({ template: 'peak', dataset: 'sales' })).status).toBe(400);
  });
});

describe('history (REQ-M12-04)', () => {
  it('lists runs newest first with who, period and files; audited', async () => {
    const r = await env.owner.get('/api/acct-export/runs?limit=3');
    expect(r.body.items).toHaveLength(3);
    expect(r.body.nextCursor).toBeTruthy();
    expect(r.body.items[0]).toMatchObject({ createdBy: 'คุณเจริญ ศรีสุข' });
    const p2 = await env.owner.get(`/api/acct-export/runs?limit=3&cursor=${r.body.nextCursor}`);
    expect(p2.body.items[0].id).not.toBe(r.body.items[0].id);
    const log = await env.pool.query(`select 1 from audit_log where tenant_id = $1 and action = 'export'`, [env.seed.tenantId]);
    expect(log.rowCount).toBeGreaterThan(5);
    const acct = await login(env.app, 'boy');
    expect((await acct.get('/api/acct-export/runs')).status).toBe(403);
  });

  it('"only not yet exported" skips documents of earlier runs of the same program; a void after export is flagged', async () => {
    const first = await run({ template: 'express', dataset: 'sales', from: TODAY, to: TODAY, onlyNew: true });
    expect(first.body.docs).toBeGreaterThan(0); // today's docs have not gone to Express with onlyNew... but the earlier full run had them
    const again = await run({ template: 'express', dataset: 'sales', from: TODAY, to: TODAY, onlyNew: true });
    expect(again.body.docs).toBe(0);
    expect(again.body.rows).toBe(0);
    const peakAgain = await run({ template: 'flowaccount', dataset: 'sales', from: TODAY, to: TODAY, onlyNew: true });
    expect(peakAgain.body.docs).toBe(0); // FlowAccount already had them (earlier xlsx run)

    await env.owner.post(`/api/sales/docs/${env.today.pvc}/void`, { reason: 'ลูกค้าเปลี่ยนใจก่อนรับของ' });
    const old = await env.owner.get(`/api/acct-export/runs/${first.body.id}`);
    expect(old.body.changedAfter.map((x: { no: string }) => x.no)).toContain(env.today.pvc);
    const next = await run({ template: 'generic', dataset: 'sales', from: TODAY, to: TODAY });
    expect(next.body.warnings.join(' ')).toContain(env.today.pvc);
  });
});
