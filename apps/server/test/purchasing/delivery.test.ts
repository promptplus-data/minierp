/** M19-08 delivery-file import (docs/integrations/onprem-delivery-file.md §8 AT-OP-01..07), BR-10 alert, REQ-M05-03/04. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import writeXlsxFile from 'write-excel-file/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, stockQty, TODAY, type Client, type Env, setupEnv } from '../helpers';

const SAMPLE = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs/integrations/samples/delivery-sample.csv'));
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');
/** UTF-8 text → TIS-620 bytes (Thai block U+0E01..U+0E5B maps to 0xA1..0xFB). */
const tis620 = (s: string) => Buffer.from([...s].map((ch) => { const c = ch.codePointAt(0)!; return c >= 0x0e01 && c <= 0x0e5b ? c - 0x0e01 + 0xa1 : c; }));

let env: Env;
let chai: Client; // wh: inv.receive, no data.cost
let suda: Client; // manager
let prae: Client; // cashier
const P = (k: string) => env.seed.products[k]!;
const W = (k: string) => env.seed.warehouses[k]!;

beforeAll(async () => {
  env = await setupEnv();
  [chai, suda, prae] = await Promise.all([login(env.app, 'chai'), login(env.app, 'suda'), login(env.app, 'prae')]);
});
afterAll(async () => { await env.close(); });

const file = (content: Buffer, extra: Record<string, unknown> = {}) => ({ fileName: 'delivery-sample.csv', contentBase64: b64(content), ...extra });

describe('preview', () => {
  it('AT-OP-01: UTF-8 BOM sample → mapping guessed from Thai headers, 2 DN groups + 1 without DN, matches by SKU', async () => {
    const r = await chai.post('/api/delivery-imports/preview', file(SAMPLE));
    expect(r.status).toBe(200);
    expect(r.body.encoding).toBe('utf8');
    expect(r.body.delimiter).toBe(',');
    expect(r.body.missingRequired).toEqual([]);
    expect(r.body.mapping).toMatchObject({ product_code: 0, product_name: 1, qty: 2, unit: 3, unit_price: 4, dn_no: 5, po_no: 6, delivery_date: 7, dealer_name: 8, vat_flag: 9 });
    expect(r.body.rows).toHaveLength(6);
    expect(r.body.rows[1].productName).toBe('กระเบื้องหลังคาลอนคู่ 50×120 ซม., สีเทา'); // quoted comma
    expect(r.body.rows[4].unitPrice).toBe('2150'); // "2,150.00"
    expect(r.body.rows[0].match).toEqual({ productId: P('p1'), unitIdx: 0, via: 'sku' });
    expect(r.body.rows[4].match).toEqual({ productId: P('p3'), unitIdx: 1, via: 'sku' }); // พาเลท
    expect(r.body.rows[1].match).toBeNull();
    expect(r.body.groups.map((g: { dnNo: string | null; lines: number; unmatched: number; vendorId: string | null; deliveryDate: string }) => [g.dnNo, g.lines, g.unmatched, g.vendorId, g.deliveryDate])).toEqual([
      ['8100234561', 3, 2, env.seed.vendors.v1, '2026-10-22'],
      ['8100234577', 2, 1, env.seed.vendors.v1, '2026-10-23'],
      [null, 1, 1, env.seed.vendors.v2, '2026-10-24'],
    ]);
    // 2,150 per pallet of 200 = 10.75 per ก้อน vs current cost 19.50: price differs > 30% → warning (spec §6)
    expect(r.body.rows[4]).toMatchObject({ status: 'warn', messages: ['ราคาต่างจากต้นทุนล่าสุดเกิน 30%'] });
    expect(r.body.counts).toEqual({ ok: 5, warn: 1, error: 0 });
  });

  it('AT-OP-02: the same file in TIS-620 decodes the Thai names', async () => {
    const text = SAMPLE.toString('utf8').replace(/^﻿/, '');
    const r = await chai.post('/api/delivery-imports/preview', file(tis620(text)));
    expect(r.status).toBe(200);
    expect(r.body.encoding).toBe('tis620');
    expect(r.body.headers[0]).toBe('รหัสสินค้า');
    expect(r.body.rows[0].productName).toBe('ปูนซีเมนต์ตราเสือ 50 กก.');
    expect(r.body.missingRequired).toEqual([]);
  });

  it('AT-OP-05: bad qty / price are row errors; the rest of the file still previews', async () => {
    const csv = 'รหัสสินค้า;ชื่อสินค้า;จำนวน;หน่วย;ราคาต่อหน่วย\nSCG-CEM-T50;ปูน;-5;ถุง;121\nSCG-CEM-T50;ปูน;10;ถุง;abc\nSCG-CEM-T50;ปูน;10;ถุง;121\nSV-DLV;ค่าส่ง;1;เที่ยว;300\n';
    const r = await chai.post('/api/delivery-imports/preview', file(Buffer.from(csv)));
    expect(r.body.delimiter).toBe(';');
    expect(r.body.rows.map((x: { status: string }) => x.status)).toEqual(['error', 'error', 'warn', 'error']);
    expect(r.body.rows[0].messages).toContain('จำนวนต้องมากกว่า 0');
    expect(r.body.rows[1].messages).toContain('ราคาไม่ใช่ตัวเลข');
    expect(r.body.rows[3].messages[0]).toMatch(/เป็นบริการ/);
  });

  it('AT-OP-06 and AT-OP-07: VAT-inclusive price → ex-VAT cost; XLSX with an Excel date and a BE date', async () => {
    const xlsx = await writeXlsxFile([
      [{ value: 'Item Code' }, { value: 'Description' }, { value: 'Qty' }, { value: 'UOM' }, { value: 'Price' }, { value: 'DN' }, { value: 'Delivery Date' }, { value: 'Price incl VAT' }],
      [{ value: 'SCG-CEM-T50' }, { value: 'ปูน' }, { value: 10 }, { value: 'bag' }, { value: 129.47 }, { value: 'X-1' }, { value: new Date(Date.UTC(2026, 9, 22)), type: Date, format: 'dd/mm/yyyy' }, { value: 'Y' }],
      [{ value: 'SCG-AAC-75' }, { value: 'อิฐ' }, { value: 1 }, { value: 'pallet' }, { value: 4600.5 }, { value: 'X-2' }, { value: '23/10/2569' }, { value: 'N' }],
    ]).toBuffer();
    const pv = await suda.post('/api/delivery-imports/preview', { fileName: 'dn.xlsx', contentBase64: b64(xlsx) });
    expect(pv.status).toBe(200);
    expect(pv.body.encoding).toBe('xlsx');
    expect(pv.body.groups.map((g: { deliveryDate: string }) => g.deliveryDate)).toEqual(['2026-10-22', '2026-10-23']);
    expect(pv.body.rows[0].match.unitIdx).toBe(0); // bag → ถุง
    expect(pv.body.rows[1].match.unitIdx).toBe(1); // pallet → พาเลท
    const c = await suda.post('/api/delivery-imports/commit', { fileName: 'dn.xlsx', contentBase64: b64(xlsx), mapping: pv.body.mapping, saveProfile: false });
    expect(c.status).toBe(201);
    const dr = await suda.get(`/api/gr-drafts/${c.body.drafts[0].id}`);
    expect(dr.body.vatFlag).toBe('inc');
    expect(dr.body.lines[0].unitCost).toBe('121'); // 129.47 / 1.07
    expect((await chai.get(`/api/gr-drafts/${c.body.drafts[0].id}`)).body.lines[0].unitCost).toBeNull(); // no data.cost
    for (const d of c.body.drafts) await suda.post(`/api/gr-drafts/${d.id}/cancel`, { reason: 'ทดสอบ' });
  });

  it('rejects files without the required columns mapped, and a cashier', async () => {
    const r = await chai.post('/api/delivery-imports/preview', file(Buffer.from('a,b\n1,2\n')));
    expect(r.body.missingRequired).toEqual(['product_code', 'product_name', 'qty', 'unit', 'unit_price']);
    const c = await chai.post('/api/delivery-imports/commit', { ...file(Buffer.from('a,b\n1,2\n')), mapping: {} });
    expect(c.status).toBe(400);
    expect((await prae.post('/api/delivery-imports/preview', file(SAMPLE))).status).toBe(403);
    expect((await chai.post('/api/delivery-imports/preview', { fileName: 'x.pdf', contentBase64: b64('x') })).status).toBe(400);
  });
});

describe('commit → drafts → confirm', () => {
  let drafts: { id: string; dnNo: string | null; lines: number; unmatched: number }[];

  it('creates one draft per DN, no stock yet, and remembers the column mapping', async () => {
    const before = await stockQty(env.pool, P('p1'), W('WH2'));
    const pv = await chai.post('/api/delivery-imports/preview', file(SAMPLE));
    const r = await chai.post('/api/delivery-imports/commit', { ...file(SAMPLE), mapping: pv.body.mapping, warehouseId: W('WH2'), profileName: 'ทวีพัฒนา' });
    expect(r.status).toBe(201);
    expect(r.body.batchNo).toBe('IMP2610-0002');
    drafts = r.body.drafts;
    expect(drafts.map((d) => [d.dnNo, d.lines, d.unmatched])).toEqual([['8100234561', 3, 2], ['8100234577', 2, 1], [null, 1, 1]]);
    expect(await stockQty(env.pool, P('p1'), W('WH2'))).toBe(before); // REQ-M05-03: stock only on confirm
    const prof = await chai.get('/api/import/profiles');
    expect(prof.body.items.map((p: { name: string }) => p.name)).toEqual(['ทวีพัฒนา']);
  });

  it('second preview: same file is flagged, open-draft DN is a duplicate, saved mapping is used', async () => {
    const r = await chai.post('/api/delivery-imports/preview', file(SAMPLE));
    expect(r.body.profileName).toBe('ทวีพัฒนา');
    expect(r.body.fileImportedAt).not.toBeNull();
    expect(r.body.groups[0].duplicate).toMatchObject({ kind: 'draft', ref: '8100234561' });
    const again = await chai.post('/api/delivery-imports/commit', { ...file(SAMPLE), mapping: r.body.mapping, saveProfile: false });
    expect(again.body.drafts.map((d: { dnNo: string | null }) => d.dnNo)).toEqual([null]); // only the DN-less part
    expect(again.body.skipped.map((s: { dnNo: string }) => s.dnNo)).toEqual(['8100234561', '8100234577']);
    await chai.post(`/api/gr-drafts/${again.body.drafts[0].id}/cancel`, {});
  });

  it('lists drafts paged (oldest first) and BR-10 raises the alert after 2 days', async () => {
    const list = await chai.get('/api/gr-drafts?limit=2');
    expect(list.body.items).toHaveLength(2);
    expect(list.body.nextCursor).not.toBeNull();
    const p2 = await chai.get(`/api/gr-drafts?limit=2&cursor=${list.body.nextCursor}`);
    expect(p2.body.items).toHaveLength(1);
    expect((await chai.get('/api/purchasing/gr-alerts')).body.count).toBe(0);
    await env.pool.query(`update gr_drafts set received_on = $1::date - 2 where dn_no = '8100234561'`, [TODAY]);
    const a = await prae.get('/api/purchasing/gr-alerts'); // banner shows for every role
    expect(a.body).toMatchObject({ days: 2, count: 1, items: [{ dnNo: '8100234561', ageDays: 2 }] });
    const dash = await suda.get('/api/purchasing/dashboard');
    expect(dash.body).toMatchObject({ draftCount: 3, overdueDrafts: 1 });
  });

  it('REQ-M05-04: cannot confirm until every line is mapped; mapping is remembered as an alias', async () => {
    const id = drafts[0]!.id;
    const d0 = (await chai.get(`/api/gr-drafts/${id}`)).body;
    expect(d0.vendorId).toBe(env.seed.vendors.v1);
    expect(d0.warehouseId).toBe(W('WH2'));
    const blocked = await chai.post(`/api/gr-drafts/${id}/confirm`, { vendorInvoiceNo: 'IV-8812', deliveryNo: '8100234561' });
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toMatch(/ผูกสินค้าให้ครบ/);
    const roof = d0.lines.find((l: { externalCode: string }) => l.externalCode === 'SCG-ROOF-DL-GY');
    const ridge = d0.lines.find((l: { externalCode: string }) => l.externalCode === 'SCG-RIDGE-C');
    const up = await chai.patch(`/api/gr-drafts/${id}`, { lines: [{ lineId: roof.id, productId: P('p2') }] });
    expect(up.status).toBe(200);
    expect(up.body.lines.find((l: { id: string }) => l.id === roof.id)).toMatchObject({ productId: P('p2'), unitIdx: 0 }); // แผ่น
    const np = await chai.post(`/api/gr-drafts/${id}/lines/${ridge.id}/product`, { sku: 'SCG-RIDGE-C', name: 'ครอบสันโค้ง ลอนคู่ สีเทา', unitName: 'ชิ้น', price: '55' });
    expect(np.status).toBe(200);
    expect(np.body.unmatched).toBe(0);
    const aliases = await chai.get('/api/import/aliases');
    expect(aliases.body.items.map((a: { externalCode: string }) => a.externalCode)).toEqual(['SCG-RIDGE-C', 'SCG-ROOF-DL-GY']);
  });

  it('REQ-M05-03: short receipt needs a reason; confirm adds stock and creates the AP bill', async () => {
    const id = drafts[0]!.id;
    const d0 = (await chai.get(`/api/gr-drafts/${id}`)).body;
    const cem = d0.lines.find((l: { externalCode: string }) => l.externalCode === 'SCG-CEM-T50');
    await chai.patch(`/api/gr-drafts/${id}`, { lines: [{ lineId: cem.id, receivedQty: '200', damagedQty: '2' }] });
    const noReason = await chai.post(`/api/gr-drafts/${id}/confirm`, { vendorInvoiceNo: 'IV-8812', deliveryNo: '8100234561' });
    expect(noReason.status).toBe(400);
    const before = await stockQty(env.pool, P('p1'), W('WH2'));
    const ok = await chai.post(`/api/gr-drafts/${id}/confirm`, { vendorInvoiceNo: 'IV-8812', deliveryNo: '8100234561', shortReason: 'ถุงแตก 2 ถุง' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ grNo: 'GR2610-0001', apBillNo: 'AP2610-0001' });
    expect(await stockQty(env.pool, P('p1'), W('WH2'))).toBe(before + 198);
    const again = await chai.post(`/api/gr-drafts/${id}/confirm`, { vendorInvoiceNo: 'IV-8812', deliveryNo: '8100234561' });
    expect(again.status).toBe(409);
    expect((await chai.get('/api/purchasing/gr-alerts')).body.count).toBe(0); // confirmed drafts stop alerting
  });

  it('AT-OP-03 and AT-OP-04: same headers reuse the mapping, aliases need no re-mapping, a received DN is skipped', async () => {
    const csv = `${SAMPLE.toString('utf8').split('\n')[0]}\nSCG-ROOF-DL-GY,กระเบื้อง,100,แผ่น,43.50,8100239999,,25/10/2569,หจก. ทวีพัฒนาวัสดุ,N\nSCG-CEM-T50,ปูน,10,ถุง,121,8100234561,,25/10/2569,หจก. ทวีพัฒนาวัสดุ,N\n`;
    const pv = await chai.post('/api/delivery-imports/preview', file(Buffer.from(csv)));
    expect(pv.body.profileName).toBe('ทวีพัฒนา');
    expect(pv.body.rows[0].match).toEqual({ productId: P('p2'), unitIdx: 0, via: 'alias' });
    expect(pv.body.groups[1].duplicate).toEqual({ kind: 'received', ref: 'GR2610-0001', date: TODAY });
    const before = await stockQty(env.pool, P('p1'), W('WH2'));
    const c = await chai.post('/api/delivery-imports/commit', { ...file(Buffer.from(csv)), mapping: pv.body.mapping });
    expect(c.body.skipped).toEqual([{ dnNo: '8100234561', reason: `DN 8100234561 รับแล้วใน GR2610-0001 เมื่อ ${TODAY}` }]);
    expect(c.body.drafts).toHaveLength(1);
    expect(c.body.drafts[0].unmatched).toBe(0);
    expect(await stockQty(env.pool, P('p1'), W('WH2'))).toBe(before);
    // forcing a re-import needs a reason
    const f = await chai.post('/api/delivery-imports/commit', { ...file(Buffer.from(csv)), mapping: pv.body.mapping, forceDnNos: ['8100234561'] });
    expect(f.status).toBe(400);
  });

  it('a draft without DN needs the DN number at confirm, and a duplicate DN is refused', async () => {
    const id = drafts[2]!.id;
    const d0 = (await chai.get(`/api/gr-drafts/${id}`)).body;
    expect(d0.dnNo).toBeNull();
    await chai.patch(`/api/gr-drafts/${id}`, { lines: [{ lineId: d0.lines[0].id, productId: P('p6') }], warehouseId: W('WH2') });
    const dup = await chai.patch(`/api/gr-drafts/${id}`, { dnNo: '8100234561' });
    expect(dup.status).toBe(409);
    const missing = await chai.post(`/api/gr-drafts/${id}/confirm`, { vendorInvoiceNo: 'TT-1' });
    expect(missing.status).toBe(400);
    const dupConfirm = await chai.post(`/api/gr-drafts/${id}/confirm`, { vendorInvoiceNo: 'TT-1', deliveryNo: '8100234561' });
    expect(dupConfirm.status).toBe(409);
    const ok = await chai.post(`/api/gr-drafts/${id}/confirm`, { vendorInvoiceNo: 'TT-1', deliveryNo: 'DN-TT-77' });
    expect(ok.status).toBe(200);
    const audit = await env.pool.query(`select action, object from audit_log where object in ('delivery-file','gr-draft') order by id`);
    expect(audit.rows.map((r) => `${r.action}:${r.object}`)).toEqual(expect.arrayContaining(['import:delivery-file', 'update:gr-draft', 'confirm:gr-draft', 'cancel:gr-draft']));
  });
});
