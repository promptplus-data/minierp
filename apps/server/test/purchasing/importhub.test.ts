/** M04 Import Hub: templates, mapping, dry-run preview, commit in one transaction, re-import without duplicates. */
import readXlsxFile from 'read-excel-file/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, lotsOf, stockQty, TODAY, type Client, type Env, setupEnv } from '../helpers';

let env: Env;
let suda: Client; // manager: data.import
let chai: Client; // wh: no data.import
let acct: Client;
const P = (k: string) => env.seed.products[k]!;
const W = (k: string) => env.seed.warehouses[k]!;
const b64 = (s: string) => Buffer.from(s).toString('base64');
const csvFile = (name: string, text: string) => ({ fileName: name, contentBase64: b64(text) });

beforeAll(async () => {
  env = await setupEnv();
  await env.pool.query(`insert into users (tenant_id, username, name, role, password_hash) select tenant_id, 'nok', 'คุณนก (บัญชี)', 'acct', password_hash from users where username = 'suda'`);
  [suda, chai, acct] = await Promise.all([login(env.app, 'suda'), login(env.app, 'chai'), login(env.app, 'nok')]);
});
afterAll(async () => { await env.close(); });

describe('templates', () => {
  it('CSV (UTF-8 BOM) and XLSX per kind; forbidden without data.import', async () => {
    const csv = await env.app.inject({ method: 'GET', url: '/api/import/templates/opening_stock', headers: { authorization: `Bearer ${await token('suda')}` } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body.startsWith('﻿รหัสสินค้า,คลัง,วันที่ของล็อต (yyyymmdd)')).toBe(true);
    const x = await env.app.inject({ method: 'GET', url: '/api/import/templates/vendors?format=xlsx', headers: { authorization: `Bearer ${await token('suda')}` } });
    expect(x.statusCode).toBe(200);
    const sheet = await readXlsxFile(x.rawPayload);
    expect(sheet[0]!.data[0]!.slice(0, 3)).toEqual(['รหัสผู้ติดต่อ', 'ชื่อกิจการ / ชื่อ', 'เลขประจำตัวผู้เสียภาษี']);
    expect((await chai.get('/api/import/templates/products')).status).toBe(403);
    expect((await suda.get('/api/import/templates/nonsense')).status).toBe(400);
  });
});

async function token(u: string) {
  const r = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: '1234' } });
  return JSON.parse(r.body).token as string;
}

describe('customers (PEAK contact fields)', () => {
  const file = csvFile('cust.csv', 'ชื่อลูกค้า,เลขภาษี,โทร,เครดิต,วงเงิน,จังหวัด\nหจก. ช่างเอกการโยธา,0503560001111,081-234-5678,30,150000,เชียงใหม่\nคุณมานพ ศรีวงศ์,,089-111-2222,0,0,\nบจก. ล้านนาคอนสตรัคชั่น,05035600,053-111-222,45,300000,\nหจก. รุ่งเรืองก่อสร้าง,0503558001234,053-333-444,30,250000,\n');

  it('preview: guessed mapping, row statuses (ok / error / exists) with reasons, nothing written', async () => {
    const r = await suda.post('/api/import/preview', { kind: 'customers', source: 'Express', ...file });
    expect(r.status).toBe(200);
    expect(r.body.mapping).toMatchObject({ name: 0, tax_id: 1, phone: 2, term_days: 3, credit_limit: 4, province: 5 });
    expect(r.body.rows.map((x: { status: string }) => x.status)).toEqual(['warn', 'ok', 'error', 'exists']);
    expect(r.body.rows[0].messages[0]).toMatch(/หลักตรวจสอบ/); // invalid check digit → warning only
    expect(r.body.rows[2].messages).toEqual(['เลขผู้เสียภาษีต้องมี 13 หลัก']);
    expect(r.body.counts).toEqual({ ok: 1, warn: 1, error: 1, exists: 1 });
    expect((await env.pool.query(`select count(*)::int n from customers`)).rows[0].n).toBe(4);
  });

  it('commit all-or-nothing refuses a file with errors; onlyValid imports the rest and remembers the mapping per source', async () => {
    const pv = await suda.post('/api/import/preview', { kind: 'customers', source: 'Express', ...file });
    const strict = await suda.post('/api/import/commit', { kind: 'customers', source: 'Express', ...file, mapping: pv.body.mapping, onlyValid: false });
    expect(strict.status).toBe(400);
    expect(strict.body.details).toEqual({ errorRows: [4] });
    const r = await suda.post('/api/import/commit', { kind: 'customers', source: 'Express', ...file, mapping: { ...pv.body.mapping, phone: 2 }, updateExisting: true });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ no: 'IMP2610-0001', kind: 'customers', rowsTotal: 4, rowsCreated: 2, rowsUpdated: 1, rowsSkipped: 0, rowsError: 1, createdBy: 'คุณสุดา ศรีสุข' });
    const c = await env.pool.query(`select code, name, term, credit_limit::text, purchasing_contact from customers order by code`);
    expect(c.rows.map((x) => x.code)).toEqual(['C00000', 'C00001', 'C00002', 'C00003', 'C00004', 'C00005']);
    expect(c.rows[4]).toMatchObject({ name: 'หจก. ช่างเอกการโยธา', term: { t: 'days', x: 30 }, credit_limit: '150000.00', purchasing_contact: { province: 'เชียงใหม่' } });
    expect(c.rows[1].credit_limit).toBe('250000.00'); // updated existing (matched by tax id)
    // next file from the same program: mapping comes back without re-mapping
    const again = await suda.post('/api/import/preview', { kind: 'customers', source: 'Express', ...csvFile('c2.csv', 'col A,col B,col C,col D,col E,col F\nร้านใหม่,,02-111-1111,7,0,\n') });
    expect(again.body.profileName).toBe('Express');
    expect(again.body.missingRequired).toEqual([]);
    expect(again.body.mapping.name).toBe(0);
  });

  it('re-importing the same file flags it and creates nothing new (REQ-M04-07)', async () => {
    const pv = await suda.post('/api/import/preview', { kind: 'customers', source: 'Express', ...file });
    expect(pv.body.fileImportedAt).not.toBeNull();
    expect(pv.body.counts).toMatchObject({ exists: 3, error: 1 });
    const r = await suda.post('/api/import/commit', { kind: 'customers', source: 'Express', ...file, mapping: pv.body.mapping });
    expect(r.body).toMatchObject({ rowsCreated: 0, rowsUpdated: 0, rowsSkipped: 3 });
  });
});

describe('products and vendors', () => {
  it('creates products with two units, links a barcode match to the existing SCG product, warns on same name', async () => {
    const f = csvFile('p.csv', 'รหัส,ชื่อ,หน่วย,ราคา,บาร์โค้ด,หน่วยใหญ่,ตัวคูณหน่วยใหญ่\nC-001,ปูนตราเสือ 50kg,ถุง,145,8850001000014,,\nW-112,ลวดผูกเหล็ก 1 กก.,ม้วน,65,,มัด,10\nP-220,ก๊อกน้ำ สนาม,ตัว,,,,\nX-9,ทรายหยาบ,คิว,600,,,\n');
    const pv = await suda.post('/api/import/preview', { kind: 'products', ...f });
    expect(pv.body.rows.map((x: { status: string }) => x.status)).toEqual(['exists', 'ok', 'error', 'warn']);
    expect(pv.body.rows[0].messages[0]).toMatch(/SCG "ปูนซีเมนต์ตราเสือ 50 กก\."/);
    expect(pv.body.rows[2].messages).toEqual(['ไม่มีราคาขาย']);
    const r = await suda.post('/api/import/commit', { kind: 'products', ...f, mapping: pv.body.mapping });
    expect(r.body).toMatchObject({ rowsCreated: 2, rowsUpdated: 1, rowsError: 1 });
    const w = await suda.get('/api/products?q=W-112');
    expect(w.body.items[0]).toMatchObject({ sku: 'W-112', price: '65.00', units: [{ name: 'ม้วน', factor: '1' }, { name: 'มัด', factor: '10' }] });
    const alias = await env.pool.query(`select external_code, product_id from product_code_aliases`);
    expect(alias.rows).toEqual([{ external_code: 'C-001', product_id: P('p1') }]);
  });

  it('vendors get V-codes and payment terms', async () => {
    const f = csvFile('v.csv', 'ชื่อผู้ขาย,เลขผู้เสียภาษี,สาขา,เครดิต,ธนาคาร,เลขที่บัญชี\nบจก. สีสวยค้าส่ง,0105556012346,1,45,กสิกรไทย,123-4-56789-0\n');
    const pv = await suda.post('/api/import/preview', { kind: 'vendors', ...f });
    const r = await suda.post('/api/import/commit', { kind: 'vendors', ...f, mapping: pv.body.mapping });
    expect(r.body.rowsCreated).toBe(1);
    const v = await env.pool.query(`select code, branch, term, purchasing_contact from vendors where name = 'บจก. สีสวยค้าส่ง'`);
    expect(v.rows[0]).toEqual({ code: 'V00004', branch: '00001', term: { t: 'days', x: 45 }, purchasing_contact: { bank: 'กสิกรไทย', bank_account: '123-4-56789-0' } });
  });
});

describe('opening stock as FIFO lots (REQ-M04-08, BR-21)', () => {
  const f = csvFile('stock.csv', 'รหัส,คลัง,วันที่ซื้อ (yyyymmdd),จำนวน,ต้นทุน\nW-112,โกดังหลังร้าน,20260915,140,48.5\nW-112,โกดังหลังร้าน,20261020,200,52\nW-112,WH1,20261001,30,50\nPVC-4-85,โกดังหลังร้าน,2026-10-05,120,71\nX-999,หน้าร้าน,20261001,10,50\nSV-DLV,WH1,20261001,1,1\n');

  it('rows with a bad date or unknown code are errors; lots are dated so FIFO takes the oldest first', async () => {
    const pv = await suda.post('/api/import/preview', { kind: 'opening_stock', source: 'PEAK', ...f });
    expect(pv.body.rows.map((x: { status: string }) => x.status)).toEqual(['ok', 'ok', 'ok', 'error', 'error', 'error']);
    expect(pv.body.rows[3].messages).toEqual(['วันที่ต้องเป็น yyyymmdd เช่น 20261005']);
    expect(pv.body.rows[4].messages).toEqual(['ไม่พบรหัสสินค้า X-999 ให้นำเข้าสินค้าก่อน']);
    const r = await suda.post('/api/import/commit', { kind: 'opening_stock', source: 'PEAK', ...f, mapping: pv.body.mapping });
    expect(r.body).toMatchObject({ rowsCreated: 3, rowsError: 3 });
    const wId = (await suda.get('/api/products?q=W-112')).body.items[0].id;
    expect(await lotsOf(env.pool, wId, W('WH2'))).toEqual([
      { remaining: '140.0000', unit_cost: '48.5000', ref: r.body.no }, { remaining: '200.0000', unit_cost: '52.0000', ref: r.body.no },
    ]);
    const at = await env.pool.query(`select to_char(received_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') d from stock_lots where product_id = $1 order by received_at`, [wId]);
    expect(at.rows.map((x) => x.d)).toEqual(['2026-09-15 00:00', '2026-10-01 00:00', '2026-10-20 00:00']);
    // FIFO: issuing 150 from WH2 takes 140 @ 48.50 then 10 @ 52
    const iss = await suda.post('/api/stock/issues', { warehouseId: W('WH2'), lines: [{ productId: wId, qty: '150' }], reason: 'ใช้ในร้าน' });
    expect(iss.status).toBe(201);
    const m = await env.pool.query(`select cost::text from stock_moves where doc_no = $1`, [iss.body.no]);
    expect(m.rows[0].cost).toBe('7310.00'); // 140×48.5 + 10×52
    // the ledger shows the opening rows
    const led = await suda.get(`/api/stock/ledger?productId=${wId}&warehouseId=${W('WH2')}`);
    expect(led.body.items.map((x: { docType: string; qty: string; balance: string }) => [x.docType, x.qty, x.balance])).toEqual([['ADJ', '-150', '190'], ['OPEN', '200', '340'], ['OPEN', '140', '140']]);
  });

  it('re-importing skips the lots already loaded', async () => {
    const pv = await suda.post('/api/import/preview', { kind: 'opening_stock', source: 'PEAK', ...f });
    expect(pv.body.counts).toMatchObject({ exists: 3, error: 3 });
    const wId = (await suda.get('/api/products?q=W-112')).body.items[0].id;
    const before = await stockQty(env.pool, wId, W('WH2'));
    await suda.post('/api/import/commit', { kind: 'opening_stock', source: 'PEAK', ...f, mapping: pv.body.mapping });
    expect(await stockQty(env.pool, wId, W('WH2'))).toBe(before);
  });
});

describe('opening AR / AP balances (REQ-M04-02)', () => {
  it('AR rows keep the old document number and dates; no tax document is issued', async () => {
    const f = csvFile('ar.csv', 'ลูกค้า,เลขที่บิล,วันที่,คงค้าง\nหจก. รุ่งเรืองก่อสร้าง,IV6909-118,15/09/2569,48500\nC00002,IV6909-130,28/09/2569,"32,400.00"\nไม่มีคนนี้,IV1,01/09/2569,10\n');
    const pv = await suda.post('/api/import/preview', { kind: 'opening_ar', ...f });
    expect(pv.body.rows.map((x: { status: string }) => x.status)).toEqual(['ok', 'ok', 'error']);
    const docsBefore = (await env.pool.query(`select count(*)::int n from docs`)).rows[0].n;
    const r = await suda.post('/api/import/commit', { kind: 'opening_ar', ...f, mapping: pv.body.mapping });
    expect(r.body.rowsCreated).toBe(2);
    const ar = await env.pool.query(`select doc_no, to_char(date,'YYYY-MM-DD') date, to_char(due_date,'YYYY-MM-DD') due, balance::text from ar_opening_balances order by doc_no`);
    expect(ar.rows).toEqual([
      { doc_no: 'IV6909-118', date: '2026-09-15', due: '2026-10-15', balance: '48500.00' }, // c1: 30 days
      { doc_no: 'IV6909-130', date: '2026-09-28', due: '2026-09-30', balance: '32400.00' }, // c2: end of month
    ]);
    expect((await env.pool.query(`select count(*)::int n from docs`)).rows[0].n).toBe(docsBefore);
  });

  it('AP rows become payable opening bills (accountant may import them) and show in aging', async () => {
    const f = csvFile('ap.csv', 'ผู้ขาย,เลขที่ใบกำกับ,วันที่,ครบกำหนด,คงค้าง\nV00001,INV-6909-221,20/09/2569,20/10/2569,25680\n');
    const pv = await acct.post('/api/import/preview', { kind: 'opening_ap', ...f });
    const r = await acct.post('/api/import/commit', { kind: 'opening_ap', ...f, mapping: pv.body.mapping });
    expect(r.status).toBe(201);
    const bills = await acct.get('/api/ap/bills?status=open');
    expect(bills.body.items[0]).toMatchObject({ source: 'opening', vendorInvoiceNo: 'INV-6909-221', termLabel: 'ยอดยกมา', total: '25680.00', dueDate: '2026-10-20', overdueDays: 6 });
    expect((await acct.get('/api/ap/aging')).body.buckets.d1_30).toBe('25680.00');
    expect((await acct.post('/api/import/preview', { kind: 'opening_stock', ...f })).status).toBe(403); // acct only gets AP
  });

  it('batch history is paged, newest first', async () => {
    const r = await suda.get('/api/import/batches?limit=3');
    expect(r.body.items).toHaveLength(3);
    expect(r.body.items[0].kind).toBe('opening_ap');
    expect(r.body.nextCursor).not.toBeNull();
    expect(TODAY).toBe('2026-10-26');
  });
});
