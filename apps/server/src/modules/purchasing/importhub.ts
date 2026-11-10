/**
 * M04 Import Hub: products, customers / vendors (PEAK contact fields), opening stock as FIFO lots (REQ-M04-08),
 * opening AR / AP balances (REQ-M04-02). Flow: template download → upload → column mapping (guessed from the
 * headers, remembered per source program, REQ-M04-03) → dry-run preview with a status per row (REQ-M04-04) →
 * commit in the request's single transaction. Re-importing never duplicates: masters match by code / tax id /
 * name, transactional rows by (source, document key) in import_keys (REQ-M04-07).
 */
import type { Tx } from '@erp/db';
import type { ImportKind } from '@erp/contracts';
import { addDays, d, dueDate, guessMapping, money, parseDateCell, parseNumberCell, qty4, taxIdValid, textCell, type Cell, type PaymentTerm } from '@erp/core';
import writeXlsxFile from 'write-excel-file/node';
import { writeAudit } from '../../lib/audit';
import { requireAny, type Ctx, type Deps } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E } from '../../lib/errors';
import { decodeCursor, pageOf } from '../../lib/paging';
import { addLot, recordIn } from '../../lib/stock';
import { cellText, parseFile, type ParsedFile } from './fileparse';

const LIMITS = { maxBytes: 10 * 1024 * 1024, maxRows: 10_000 };

interface FieldDef { key: string; label: string; required?: boolean; aliases: string[]; example: string }

const CONTACT: FieldDef[] = [
  { key: 'code', label: 'รหัสผู้ติดต่อ', aliases: ['รหัส', 'รหัสลูกค้า', 'รหัสผู้ขาย', 'รหัสผู้จำหน่าย', 'Contact Code', 'Code'], example: '' },
  { key: 'name', label: 'ชื่อกิจการ / ชื่อ', required: true, aliases: ['ชื่อ', 'ชื่อกิจการ', 'ชื่อลูกค้า', 'ชื่อผู้ขาย', 'ชื่อผู้จำหน่าย', 'ชื่อผู้ติดต่อ', 'Name', 'Company Name'], example: 'หจก. ช่างเอกการโยธา' },
  { key: 'tax_id', label: 'เลขประจำตัวผู้เสียภาษี', aliases: ['เลขผู้เสียภาษี', 'เลขภาษี', 'เลขทะเบียน 13 หลัก', 'Tax ID', 'TaxID'], example: '0503560001111' },
  { key: 'branch', label: 'สาขา', aliases: ['รหัสสาขา', 'เลขที่สาขา', 'Branch'], example: '00000' },
  { key: 'entity', label: 'ประเภทกิจการ', aliases: ['ประเภท', 'Entity Type'], example: 'ห้างหุ้นส่วนจำกัด' },
  { key: 'nationality', label: 'สัญชาติ', aliases: ['Nationality'], example: 'ไทย' },
  { key: 'address', label: 'ที่อยู่', aliases: ['ที่อยู่จดทะเบียน', 'Address'], example: '99 ถ.ช้างคลาน' },
  { key: 'sub_district', label: 'แขวง / ตำบล', aliases: ['ตำบล', 'แขวง', 'Sub-district'], example: 'ช้างคลาน' },
  { key: 'district', label: 'เขต / อำเภอ', aliases: ['อำเภอ', 'เขต', 'District'], example: 'เมืองเชียงใหม่' },
  { key: 'province', label: 'จังหวัด', aliases: ['Province'], example: 'เชียงใหม่' },
  { key: 'zip', label: 'รหัสไปรษณีย์', aliases: ['ไปรษณีย์', 'Zip', 'Postcode'], example: '50100' },
  { key: 'phone', label: 'เบอร์โทร', aliases: ['โทร', 'โทรศัพท์', 'Phone', 'Tel'], example: '081-234-5678' },
  { key: 'email', label: 'อีเมล', aliases: ['Email', 'E-mail'], example: '' },
  { key: 'term_days', label: 'เครดิต (วัน)', aliases: ['เครดิต', 'ระยะเวลาเครดิต', 'Credit Days', 'Credit Term'], example: '30' },
  { key: 'bank', label: 'ธนาคาร', aliases: ['Bank'], example: '' },
  { key: 'bank_account', label: 'เลขที่บัญชี', aliases: ['เลขบัญชี', 'Account No'], example: '' },
  { key: 'bank_account_name', label: 'ชื่อบัญชี', aliases: ['Account Name'], example: '' },
];

const FIELDS: Record<ImportKind, FieldDef[]> = {
  products: [
    { key: 'sku', label: 'รหัสสินค้า', required: true, aliases: ['รหัส', 'SKU', 'Product Code', 'Item Code'], example: 'W-112' },
    { key: 'name', label: 'ชื่อสินค้า', required: true, aliases: ['ชื่อ', 'Product Name', 'Description'], example: 'ลวดผูกเหล็ก 1 กก.' },
    { key: 'unit', label: 'หน่วยหลัก', required: true, aliases: ['หน่วย', 'หน่วยนับ', 'Unit', 'UOM'], example: 'ม้วน' },
    { key: 'price', label: 'ราคาขาย', required: true, aliases: ['ราคา', 'ราคาขายต่อหน่วย', 'Price', 'Sale Price'], example: '65' },
    { key: 'cost', label: 'ราคาซื้อ (ก่อน VAT)', aliases: ['ราคาซื้อ', 'ต้นทุน', 'ต้นทุนต่อหน่วย', 'Cost', 'Purchase Price'], example: '52' },
    { key: 'barcode', label: 'บาร์โค้ด', aliases: ['Barcode'], example: '' },
    { key: 'category', label: 'หมวดสินค้า', aliases: ['หมวด', 'หมวดหมู่', 'กลุ่มสินค้า', 'Category'], example: 'เหล็ก' },
    { key: 'kind', label: 'ประเภทสินค้า', aliases: ['ประเภท', 'Type'], example: 'สินค้า' },
    { key: 'vat', label: 'ภาษีขาย', aliases: ['VAT', 'ภาษี', 'อัตราภาษี'], example: '7' },
    { key: 'unit2', label: 'หน่วยใหญ่', aliases: ['หน่วยที่ 2'], example: 'มัด' },
    { key: 'factor2', label: 'ตัวคูณหน่วยใหญ่', aliases: ['อัตราแปลง', 'ตัวคูณ'], example: '10' },
    { key: 'reorder_point', label: 'จุดสั่งซื้อ', aliases: ['จุดสั่งซื้อขั้นต่ำ', 'Reorder Point', 'Min'], example: '20' },
  ],
  customers: [...CONTACT, { key: 'credit_limit', label: 'วงเงิน', aliases: ['วงเงินเครดิต', 'Credit Limit'], example: '150000' }],
  vendors: CONTACT,
  opening_stock: [
    { key: 'sku', label: 'รหัสสินค้า', required: true, aliases: ['รหัส', 'SKU', 'Product Code'], example: 'SCG-CEM-T50' },
    { key: 'warehouse', label: 'คลัง', required: true, aliases: ['รหัสคลัง', 'Warehouse'], example: 'WH2' },
    { key: 'lot_date', label: 'วันที่ของล็อต (yyyymmdd)', required: true, aliases: ['วันที่ของล็อต', 'วันที่ซื้อ', 'วันที่ซื้อ (yyyymmdd)', 'วันที่', 'Lot Date'], example: '20260915' },
    { key: 'qty', label: 'จำนวน (หน่วยหลัก)', required: true, aliases: ['จำนวน', 'Qty', 'Quantity'], example: '140' },
    { key: 'unit_cost', label: 'ต้นทุนต่อหน่วย (ก่อน VAT)', required: true, aliases: ['ต้นทุนต่อหน่วย', 'ต้นทุน', 'Unit Cost', 'Cost'], example: '118.34' },
  ],
  opening_ar: [
    { key: 'party', label: 'ลูกค้า (รหัส / ชื่อ / เลขภาษี)', required: true, aliases: ['ลูกค้า', 'รหัสลูกค้า', 'ชื่อลูกค้า', 'Customer'], example: 'C00001' },
    { key: 'doc_no', label: 'เลขที่เอกสารเดิม', required: true, aliases: ['เลขที่บิล', 'เลขที่เอกสาร', 'เลขที่ใบแจ้งหนี้', 'Doc No', 'Invoice No'], example: 'IV6909-118' },
    { key: 'date', label: 'วันที่', required: true, aliases: ['วันที่เอกสาร', 'Date'], example: '15/09/2569' },
    { key: 'due_date', label: 'วันครบกำหนด', aliases: ['ครบกำหนด', 'Due Date'], example: '15/10/2569' },
    { key: 'balance', label: 'ยอดคงค้าง', required: true, aliases: ['คงค้าง', 'ยอดคงเหลือ', 'Balance', 'Amount'], example: '48500' },
  ],
  opening_ap: [
    { key: 'party', label: 'ผู้ขาย (รหัส / ชื่อ / เลขภาษี)', required: true, aliases: ['ผู้ขาย', 'ผู้จำหน่าย', 'รหัสผู้ขาย', 'Vendor', 'Supplier'], example: 'V00001' },
    { key: 'doc_no', label: 'เลขที่ใบกำกับผู้ขาย', required: true, aliases: ['เลขที่บิล', 'เลขที่เอกสาร', 'เลขที่ใบกำกับ', 'Doc No', 'Invoice No'], example: 'INV-6909-221' },
    { key: 'date', label: 'วันที่', required: true, aliases: ['วันที่เอกสาร', 'Date'], example: '20/09/2569' },
    { key: 'due_date', label: 'วันครบกำหนด', aliases: ['ครบกำหนด', 'Due Date'], example: '20/10/2569' },
    { key: 'balance', label: 'ยอดคงค้าง', required: true, aliases: ['คงค้าง', 'ยอดคงเหลือ', 'Balance', 'Amount'], example: '25680' },
  ],
};

export const KIND_TH: Record<ImportKind, string> = {
  products: 'สินค้า', customers: 'ลูกค้า', vendors: 'ผู้ขาย', opening_stock: 'สต็อกเปิด', opening_ar: 'ลูกหนี้คงค้าง', opening_ap: 'เจ้าหนี้คงค้าง',
};

const isMaster = (k: ImportKind) => k === 'products' || k === 'customers' || k === 'vendors';
const permFor = (ctx: Ctx, kind: ImportKind) => requireAny(ctx, kind === 'opening_ap' ? ['data.import', 'fin.ap'] : ['data.import']);

// ---------- templates ----------
export async function template(ctx: Ctx, kind: ImportKind, format: 'csv' | 'xlsx'): Promise<{ body: Buffer; type: string; fileName: string }> {
  permFor(ctx, kind);
  const f = FIELDS[kind];
  const fileName = `import-${kind.replace('_', '-')}.${format}`;
  if (format === 'xlsx') {
    const body = await writeXlsxFile([f.map((x) => ({ value: x.label, fontWeight: 'bold' as const })), f.map((x) => ({ value: x.example, type: String }))], { sheet: KIND_TH[kind] }).toBuffer();
    return { body, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName };
  }
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const text = `﻿${f.map((x) => esc(x.label)).join(',')}\r\n${f.map((x) => esc(x.example)).join(',')}\r\n`;
  return { body: Buffer.from(text, 'utf8'), type: 'text/csv; charset=utf-8', fileName };
}

// ---------- analysis (dry run) ----------
type Status = 'ok' | 'warn' | 'error' | 'exists';
interface Row { rowNo: number; cells: string[]; status: Status; messages: string[]; key: string; apply: ((tx: Tx, ctx: Ctx, batch: { id: string; no: string }, update: boolean) => Promise<'created' | 'updated' | 'skipped'>) | null }
interface Analysis { file: ParsedFile; mapping: Record<string, number>; missingRequired: string[]; rows: Row[]; profileName: string | null; fileImportedAt: string | null }

interface ImportReq { kind: ImportKind; mode: 'onboarding' | 'ongoing'; source: string; fileName: string; contentBase64: string; encoding: 'auto' | 'utf8' | 'tis620'; mapping?: Record<string, number> }

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();

async function analyze(tx: Tx, deps: Deps, req: ImportReq): Promise<Analysis> {
  const file = await parseFile(req.fileName, req.contentBase64, req.encoding, LIMITS);
  const defs = FIELDS[req.kind];
  let mapping = req.mapping;
  let profileName: string | null = null;
  if (!mapping) {
    // REQ-M04-03: the mapping saved for this source program (or for files with the same header row).
    const p = await tx.query<{ name: string; mapping: Record<string, number> }>(
      `select name, mapping from import_profiles where kind = $1 and active and (name = $2 or header_signature = $3)
        order by (header_signature = $3) desc, (name = $2) desc, updated_at desc limit 1`, [req.kind, req.source, file.signature]);
    if (p.rows[0]) { mapping = { ...p.rows[0].mapping }; profileName = p.rows[0].name; }
  }
  mapping = { ...(mapping ?? guessMapping(file.headers, defs.map((f) => ({ key: f.key, aliases: [f.label, ...f.aliases] })))) };
  for (const [k, v] of Object.entries(mapping)) if (!defs.some((f) => f.key === k) || v < 0 || v >= file.headers.length) delete mapping[k];
  const missingRequired = defs.filter((f) => f.required && mapping![f.key] == null).map((f) => f.key);
  const prev = await tx.query<{ created_at: Date }>(`select created_at from import_batches where kind = $1 and file_sha256 = $2 order by created_at limit 1`, [req.kind, file.sha256]);
  const base = { file, mapping, missingRequired, profileName, fileImportedAt: prev.rows[0]?.created_at.toISOString() ?? null };
  if (missingRequired.length) return { ...base, rows: file.rows.map((r) => ({ rowNo: r.rowNo, cells: r.cells.map(cellText), status: 'error', messages: ['ยังจับคู่คอลัมน์ที่จำเป็นไม่ครบ'], key: '', apply: null })) };
  const get = (cells: Cell[], k: string): Cell => (mapping![k] == null ? null : cells[mapping![k]!]);
  const txt = (cells: Cell[], k: string) => textCell(get(cells, k));
  const build = await BUILDERS[req.kind](tx, deps, req);
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const r of file.rows) {
    const out = await build((k) => get(r.cells, k), (k) => txt(r.cells, k));
    if (out.key && out.status !== 'error') {
      if (seen.has(out.key)) { out.status = 'error'; out.messages.push('ซ้ำกับแถวก่อนหน้าในไฟล์เดียวกัน'); out.apply = null; }
      seen.add(out.key);
    }
    rows.push({ rowNo: r.rowNo, cells: r.cells.map(cellText), ...out });
  }
  return { ...base, rows };
}

type Built = { status: Status; messages: string[]; key: string; apply: Row['apply'] };
type Builder = (tx: Tx, deps: Deps, req: ImportReq) => Promise<(get: (k: string) => Cell, txt: (k: string) => string) => Promise<Built>>;
const err = (messages: string[], key = ''): Built => ({ status: 'error', messages, key, apply: null });

const products: Builder = async (tx) => {
  const existing = (await tx.query<{ id: string; sku: string; name: string; barcode: string | null; is_scg: boolean }>(`select id, sku, name, barcode, is_scg from products`)).rows;
  const bySku = new Map(existing.map((p) => [p.sku.toLowerCase(), p]));
  const byBarcode = new Map(existing.filter((p) => p.barcode).map((p) => [p.barcode!, p]));
  const byName = new Map(existing.map((p) => [norm(p.name), p]));
  return async (get, txt) => {
    const msgs: string[] = [];
    const sku = txt('sku');
    const name = txt('name');
    const unit = txt('unit');
    const price = parseNumberCell(get('price'));
    const cost = get('cost') == null || txt('cost') === '' ? null : parseNumberCell(get('cost'));
    const rp = txt('reorder_point') === '' ? '0' : parseNumberCell(get('reorder_point'));
    const kindT = norm(txt('kind'));
    const kind = kindT === '' || ['สินค้า', 'stock', 'สินค้าคงคลัง', 'นับสต็อก'].includes(kindT) ? 'stock' : ['บริการ', 'service'].includes(kindT) ? 'service' : null;
    const vatT = norm(txt('vat'));
    const vat = vatT === '' || ['7', '7%', 'v7', 'vat7', 'มี'].includes(vatT) ? 'v7' : ['0', '0%', 'exempt', 'ยกเว้น', 'ไม่มี', 'novat'].includes(vatT) ? 'exempt' : null;
    const unit2 = txt('unit2');
    const factor2 = unit2 ? parseNumberCell(get('factor2')) : null;
    if (!sku) msgs.push('ไม่มีรหัสสินค้า');
    if (sku.length > 64) msgs.push('รหัสสินค้ายาวเกิน 64 ตัวอักษร');
    if (!name) msgs.push('ไม่มีชื่อสินค้า');
    if (!unit) msgs.push('ไม่มีหน่วยหลัก');
    if (price == null) msgs.push('ไม่มีราคาขาย'); else if (d(price).lt(0)) msgs.push('ราคาขายติดลบ');
    if (cost != null && d(cost).lt(0)) msgs.push('ต้นทุนติดลบ');
    if (txt('cost') !== '' && cost == null) msgs.push('ต้นทุนไม่ใช่ตัวเลข');
    if (rp == null || d(rp).lt(0)) msgs.push('จุดสั่งซื้อไม่ถูกต้อง');
    if (!kind) msgs.push(`ไม่รู้จักประเภทสินค้า "${txt('kind')}" (สินค้า / บริการ)`);
    if (!vat) msgs.push(`ไม่รู้จักภาษี "${txt('vat')}" (7 / ยกเว้น)`);
    if (unit2 && (factor2 == null || !d(factor2).gt(0))) msgs.push('ตัวคูณหน่วยใหญ่ต้องมากกว่า 0');
    if (msgs.length) return err(msgs, sku.toLowerCase());
    const barcode = txt('barcode') || null;
    const units = [{ name: unit, factor: '1' }, ...(unit2 ? [{ name: unit2, factor: qty4(factor2!) }] : [])];
    const input = { sku, name, barcode, category: txt('category'), kind: kind!, vat: vat!, price: money(price!), units, reorderPoint: qty4(rp!), cost };
    const same = bySku.get(sku.toLowerCase());
    if (same) {
      return {
        status: 'exists', messages: [`รหัส ${same.sku} มีอยู่แล้ว (${same.name})`], key: sku.toLowerCase(),
        apply: async (t, ctx, _b, update) => {
          if (!update || same.is_scg) return 'skipped'; // SCG master items stay as synced (REQ-M03)
          await t.query(`update products set name = $2, barcode = coalesce($3, barcode), category = $4, price = $5, units = $6, reorder_point = $7, kind = $8, vat = $9 where id = $1`,
            [same.id, input.name, input.barcode, input.category, input.price, JSON.stringify(input.units), input.reorderPoint, input.kind, input.vat]);
          return 'updated';
        },
      };
    }
    // REQ-M04-05: a barcode hit is certain → link the old code to that product (alias) instead of a duplicate.
    const bc = barcode ? byBarcode.get(barcode) : undefined;
    if (bc) {
      return {
        status: 'exists', messages: [`บาร์โค้ดตรงกับสินค้า${bc.is_scg ? ' SCG' : ''} "${bc.name}" (${bc.sku}) จะผูกรหัส ${sku} เข้ากับสินค้านี้`], key: sku.toLowerCase(),
        apply: async (t, ctx) => {
          await t.query(
            `insert into product_code_aliases (tenant_id, vendor_id, external_code, product_id, created_by) values ($1, null, $2, $3, $4)
             on conflict (tenant_id, coalesce(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(external_code)) do update set product_id = excluded.product_id, active = true, updated_at = now()`,
            [ctx.tenantId, sku, bc.id, ctx.userId]);
          return 'updated';
        },
      };
    }
    // A same-name product is only suggested; the importer decides (not linked automatically when unsure).
    const nm = byName.get(norm(name));
    const warn = nm ? [`ชื่อเหมือนสินค้า "${nm.name}" (${nm.sku}) ตรวจว่าไม่ใช่สินค้าเดียวกัน`] : [];
    return {
      status: warn.length ? 'warn' : 'ok', messages: warn, key: sku.toLowerCase(),
      apply: async (t, ctx) => {
        await t.query(
          `insert into products (tenant_id, sku, name, barcode, category, is_scg, kind, vat, price, cost, units, reorder_point) values ($1,$2,$3,$4,$5,false,$6,$7,$8,$9,$10,$11)`,
          [ctx.tenantId, input.sku, input.name, input.barcode, input.category, input.kind, input.vat, input.price, input.cost ?? '0', JSON.stringify(input.units), input.reorderPoint]);
        return 'created';
      },
    };
  };
};

const contacts = (table: 'customers' | 'vendors'): Builder => async (tx) => {
  const existing = (await tx.query<{ id: string; code: string; name: string; tax_id: string | null; branch: string | null }>(`select id, code, name, tax_id, branch from ${table}`)).rows;
  const prefix = table === 'customers' ? 'C' : 'V';
  const mx = await tx.query<{ n: number | null }>(`select max(substring(code from 2)::int) n from ${table} where code ~ '^${prefix}[0-9]{5}$'`);
  let next = mx.rows[0]?.n ?? 0;
  return async (get, txt) => {
    const msgs: string[] = [];
    const warns: string[] = [];
    const name = txt('name');
    const tax = txt('tax_id').replace(/[\s-]/g, '');
    const branchRaw = txt('branch');
    const branch = branchRaw ? (/^\d{1,5}$/.test(branchRaw) ? branchRaw.padStart(5, '0') : branchRaw === 'สำนักงานใหญ่' ? '00000' : null) : tax ? '00000' : null;
    const days = txt('term_days') === '' ? null : parseNumberCell(get('term_days'));
    const limit = table === 'customers' && txt('credit_limit') !== '' ? parseNumberCell(get('credit_limit')) : '0';
    if (!name) msgs.push('ไม่มีชื่อ');
    if (tax && !/^\d{13}$/.test(tax)) msgs.push('เลขผู้เสียภาษีต้องมี 13 หลัก');
    else if (tax && !taxIdValid(tax)) warns.push('เลขผู้เสียภาษีหลักตรวจสอบไม่ถูกต้อง ตรวจอีกครั้ง');
    if (branchRaw && branch == null) msgs.push('สาขาต้องเป็นตัวเลข 5 หลัก (สำนักงานใหญ่ = 00000)');
    if (days != null && (!d(days).isInteger() || d(days).lt(0) || d(days).gt(365))) msgs.push('เครดิต (วัน) ต้องเป็นจำนวนเต็ม 0–365');
    if (txt('term_days') !== '' && days == null) msgs.push('เครดิต (วัน) ไม่ใช่ตัวเลข');
    if (limit == null || d(limit).lt(0)) msgs.push('วงเงินไม่ถูกต้อง');
    const code = txt('code');
    const key = code ? `code:${code.toLowerCase()}` : tax ? `tax:${tax}:${branch}` : `name:${norm(name)}`;
    if (msgs.length) return err(msgs, key);
    const term: PaymentTerm = days == null || d(days).isZero() ? { t: 'cash' } : { t: 'days', x: Number(days) };
    const contact = Object.fromEntries(['entity', 'nationality', 'address', 'sub_district', 'district', 'province', 'zip', 'email', 'bank', 'bank_account', 'bank_account_name']
      .map((k) => [k, txt(k)]).filter(([, v]) => v));
    const phone = txt('phone') || null;
    const same = existing.find((c) => (code && c.code.toLowerCase() === code.toLowerCase()) || (tax && c.tax_id === tax && (c.branch ?? '00000') === branch))
      ?? existing.find((c) => norm(c.name) === norm(name));
    if (same) {
      return {
        status: 'exists', messages: [`มีอยู่แล้ว: ${same.code} ${same.name}`], key,
        apply: async (t, _ctx, _b, update) => {
          if (!update) return 'skipped';
          await t.query(`update ${table} set name = $2, tax_id = coalesce($3, tax_id), branch = coalesce($4, branch), phone = coalesce($5, phone), term = $6, purchasing_contact = purchasing_contact || $7::jsonb${table === 'customers' ? ', credit_limit = $8' : ''} where id = $1`,
            [same.id, name, tax || null, branch, phone, JSON.stringify(term), JSON.stringify(contact), ...(table === 'customers' ? [money(limit!)] : [])]);
          return 'updated';
        },
      };
    }
    return {
      status: warns.length ? 'warn' : 'ok', messages: warns, key,
      apply: async (t, ctx) => {
        const c = code || `${prefix}${String(++next).padStart(5, '0')}`;
        if (table === 'customers') {
          await t.query(`insert into customers (tenant_id, code, name, tax_id, branch, phone, credit_limit, term, purchasing_contact) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [ctx.tenantId, c, name, tax || null, branch, phone, money(limit!), JSON.stringify(term), JSON.stringify(contact)]);
        } else {
          await t.query(`insert into vendors (tenant_id, code, name, tax_id, branch, phone, term, purchasing_contact) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [ctx.tenantId, c, name, tax || null, branch, phone, JSON.stringify(term), JSON.stringify(contact)]);
        }
        return 'created';
      },
    };
  };
};

/** Already-imported natural keys of a transactional kind (REQ-M04-07). */
async function importedKeys(tx: Tx, kind: string): Promise<Set<string>> {
  return new Set((await tx.query<{ key: string }>(`select key from import_keys where kind = $1`, [kind])).rows.map((r) => r.key));
}
async function claimKey(tx: Tx, ctx: Ctx, kind: string, key: string, batchId: string) {
  await tx.query(`insert into import_keys (tenant_id, kind, key, batch_id) values ($1,$2,$3,$4)`, [ctx.tenantId, kind, key, batchId]);
}

/** yyyymmdd (PEAK lot template) or an Excel date cell. */
function lotDate(v: Cell): string | null {
  if (v instanceof Date || (typeof v === 'number' && !/^\d{8}$/.test(String(v)))) return parseDateCell(v);
  const s = textCell(v);
  return /^\d{8}$/.test(s) ? parseDateCell(s) : null;
}

const openingStock: Builder = async (tx, deps, req) => {
  const prods = new Map((await tx.query<{ id: string; sku: string; kind: string; active: boolean }>(`select id, sku, kind, active from products`)).rows.map((p) => [p.sku.toLowerCase(), p]));
  const whs = (await tx.query<{ id: string; code: string; name: string; active: boolean }>(`select id, code, name, active from warehouses`)).rows;
  const done = await importedKeys(tx, 'opening_stock');
  const today = deps.today();
  return async (get, txt) => {
    const msgs: string[] = [];
    const sku = txt('sku');
    const p = prods.get(sku.toLowerCase());
    const whT = txt('warehouse');
    const wh = whs.find((w) => w.code.toLowerCase() === whT.toLowerCase()) ?? whs.find((w) => norm(w.name) === norm(whT));
    const date = lotDate(get('lot_date'));
    const qty = parseNumberCell(get('qty'));
    const cost = parseNumberCell(get('unit_cost'));
    if (!sku) msgs.push('ไม่มีรหัสสินค้า');
    else if (!p) msgs.push(`ไม่พบรหัสสินค้า ${sku} ให้นำเข้าสินค้าก่อน`);
    else if (p.kind !== 'stock') msgs.push(`${p.sku} เป็นบริการ ไม่มีสต็อก`);
    if (!wh) msgs.push(`ไม่พบคลัง "${whT}"`); else if (!wh.active) msgs.push(`คลัง ${wh.name} ปิดใช้งานแล้ว`);
    if (!date) msgs.push(`วันที่ต้องเป็น yyyymmdd เช่น 20261005`); else if (date > today) msgs.push('วันที่ของล็อตเป็นวันในอนาคต');
    if (qty == null || !d(qty).gt(0)) msgs.push('จำนวนต้องมากกว่า 0');
    if (cost == null || d(cost).lt(0)) msgs.push('ต้นทุนต่อหน่วยไม่ถูกต้อง');
    const key = `${req.source}|${sku.toLowerCase()}|${wh?.code ?? whT}|${date ?? txt('lot_date')}|${qty ?? ''}|${cost ?? ''}`;
    if (msgs.length) return err(msgs, key);
    if (done.has(key)) return { status: 'exists', messages: ['ล็อตนี้นำเข้าแล้วในรอบก่อน จะข้าม'], key, apply: async () => 'skipped' };
    return {
      status: 'ok', messages: [], key,
      apply: async (t, ctx, batch) => {
        // BR-21: a lot dated with the file's date (Bangkok midnight) so FIFO consumes it in date order.
        const at = `${addDays(date!, -1)}T17:00:00`;
        const lotId = await addLot(t, ctx, { productId: p!.id, warehouseId: wh!.id, qty: qty4(qty!), unitCost: qty4(cost!), ref: batch.no, receivedAt: at });
        const moveId = await recordIn(t, ctx, wh!.id, p!.id, [{ lotId, qty: qty4(qty!), unitCost: qty4(cost!) }], { docType: 'OPEN', docNo: batch.no, docId: batch.id, note: `สต็อกเปิด · ล็อต ${date}` });
        await t.query(`update stock_moves set at = $2 where id = $1`, [moveId, `${at}Z`]); // the ledger shows the opening row on the lot date
        await t.query(`update products set cost = $2 where id = $1 and cost = 0`, [p!.id, qty4(cost!)]);
        await claimKey(t, ctx, 'opening_stock', key, batch.id);
        return 'created';
      },
    };
  };
};

const openingBalance = (side: 'ar' | 'ap'): Builder => async (tx, deps, req) => {
  const table = side === 'ar' ? 'customers' : 'vendors';
  const parties = (await tx.query<{ id: string; code: string; name: string; tax_id: string | null; term: PaymentTerm }>(`select id, code, name, tax_id, term from ${table}`)).rows;
  const kind = side === 'ar' ? 'opening_ar' : 'opening_ap';
  const done = await importedKeys(tx, kind);
  const today = deps.today();
  return async (get, txt) => {
    const msgs: string[] = [];
    const who = txt('party');
    const p = parties.find((x) => x.code.toLowerCase() === who.toLowerCase()) ?? parties.find((x) => x.tax_id && x.tax_id === who.replace(/[\s-]/g, '')) ?? parties.find((x) => norm(x.name) === norm(who));
    const docNo = txt('doc_no');
    const date = parseDateCell(get('date'));
    const dueRaw = txt('due_date');
    const due = dueRaw ? parseDateCell(get('due_date')) : null;
    const bal = parseNumberCell(get('balance'));
    if (!who) msgs.push(side === 'ar' ? 'ไม่มีลูกค้า' : 'ไม่มีผู้ขาย');
    else if (!p) msgs.push(`ไม่พบ${side === 'ar' ? 'ลูกค้า' : 'ผู้ขาย'} "${who}" ให้นำเข้าผู้ติดต่อก่อน`);
    if (!docNo) msgs.push('ไม่มีเลขที่เอกสารเดิม');
    if (!date) msgs.push('วันที่ไม่ถูกต้อง'); else if (date > today) msgs.push('วันที่เป็นวันในอนาคต');
    if (dueRaw && !due) msgs.push('วันครบกำหนดไม่ถูกต้อง');
    if (date && due && due < date) msgs.push('วันครบกำหนดก่อนวันที่เอกสาร');
    if (bal == null || !d(bal).gt(0)) msgs.push('ยอดคงค้างต้องมากกว่า 0');
    const key = `${req.source}|${p?.code ?? who.toLowerCase()}|${docNo.toLowerCase()}`;
    if (msgs.length) return err(msgs, key);
    const dueOn = due ?? dueDate(date!, p!.term);
    if (done.has(key)) return { status: 'exists', messages: ['เอกสารนี้นำเข้าแล้วในรอบก่อน จะข้าม'], key, apply: async () => 'skipped' };
    if (side === 'ap') {
      const dup = await tx.query(`select 1 from ap_bills where vendor_id = $1 and vendor_invoice_no = $2`, [p!.id, docNo]);
      if (dup.rowCount) return { status: 'exists', messages: [`ใบกำกับ ${docNo} ของผู้ขายนี้มีในระบบแล้ว จะข้าม`], key, apply: async () => 'skipped' };
    }
    return {
      status: 'ok', messages: due ? [] : [`ครบกำหนด ${dueOn} ตามเงื่อนไขชำระ`], key,
      apply: async (t, ctx, batch) => {
        // REQ-M04-02: no new tax document is issued for opening balances.
        if (side === 'ar') {
          await t.query(`insert into ar_opening_balances (tenant_id, customer_id, doc_no, date, due_date, amount, balance, batch_id) values ($1,$2,$3,$4,$5,$6,$6,$7)`,
            [ctx.tenantId, p!.id, docNo, date, dueOn, money(bal!), batch.id]);
        } else {
          const no = await nextDocNo(t, ctx.tenantId, 'AP', deps.today());
          await t.query(`insert into ap_bills (tenant_id, no, source, vendor_id, vendor_invoice_no, date, due_date, base, total, created_by) values ($1,$2,'opening',$3,$4,$5,$6,$7,$7,$8)`,
            [ctx.tenantId, no, p!.id, docNo, date, dueOn, money(bal!), ctx.userId]);
        }
        await claimKey(t, ctx, kind, key, batch.id);
        return 'created';
      },
    };
  };
};

const BUILDERS: Record<ImportKind, Builder> = {
  products, customers: contacts('customers'), vendors: contacts('vendors'), opening_stock: openingStock, opening_ar: openingBalance('ar'), opening_ap: openingBalance('ap'),
};

const counts = (rows: Row[]) => ({
  ok: rows.filter((r) => r.status === 'ok').length, warn: rows.filter((r) => r.status === 'warn').length,
  error: rows.filter((r) => r.status === 'error').length, exists: rows.filter((r) => r.status === 'exists').length,
});

export async function preview(tx: Tx, deps: Deps, ctx: Ctx, req: ImportReq) {
  permFor(ctx, req.kind);
  if (req.mode === 'ongoing' && !isMaster(req.kind)) throw E.validation('ส่งข้อมูลเป็นรอบนำเข้าได้เฉพาะข้อมูลหลัก');
  const a = await analyze(tx, deps, req);
  return {
    kind: req.kind, headers: a.file.headers, fields: FIELDS[req.kind].map((f) => ({ key: f.key, label: f.label, required: !!f.required })),
    mapping: a.mapping, missingRequired: a.missingRequired,
    rows: a.rows.map((r) => ({ rowNo: r.rowNo, cells: r.cells, status: r.status, messages: r.messages, key: r.key })),
    counts: counts(a.rows), fileImportedAt: a.fileImportedAt, profileName: a.profileName,
  };
}

/** Commits the file in the request transaction: all rows, or (onlyValid) every row that passed. */
export async function commit(tx: Tx, deps: Deps, ctx: Ctx, req: ImportReq & { mapping: Record<string, number>; onlyValid: boolean; updateExisting: boolean; saveMapping: boolean; note?: string }) {
  permFor(ctx, req.kind);
  if (req.mode === 'ongoing' && !isMaster(req.kind)) throw E.validation('ส่งข้อมูลเป็นรอบนำเข้าได้เฉพาะข้อมูลหลัก');
  const a = await analyze(tx, deps, req);
  if (a.missingRequired.length) throw E.validation(`ยังไม่ได้จับคู่คอลัมน์: ${a.missingRequired.join(', ')}`, { missing: a.missingRequired });
  const c = counts(a.rows);
  if (c.error && !req.onlyValid) throw E.validation(`มี ${c.error} แถวที่ผิด แก้ไฟล์ก่อน หรือเลือกบันทึกเฉพาะแถวที่ผ่าน`, { errorRows: a.rows.filter((r) => r.status === 'error').map((r) => r.rowNo) });
  if (!a.rows.some((r) => r.apply)) throw E.validation('ไม่มีแถวที่นำเข้าได้');
  const no = await nextDocNo(tx, ctx.tenantId, 'IMP', deps.today());
  const b = await tx.query<{ id: string; created_at: Date }>(
    `insert into import_batches (tenant_id, no, kind, mode, source, file_name, file_sha256, rows_total, rows_error, created_by, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id, created_at`,
    [ctx.tenantId, no, req.kind, req.mode, req.source, req.fileName, a.file.sha256, a.rows.length, c.error, ctx.userId, req.note?.trim() ?? '']);
  const batch = { id: b.rows[0]!.id, no };
  const n = { created: 0, updated: 0, skipped: 0 };
  for (const r of a.rows) {
    if (!r.apply) continue;
    n[await r.apply(tx, ctx, batch, req.updateExisting)]++;
  }
  await tx.query(`update import_batches set rows_created = $2, rows_updated = $3, rows_skipped = $4 where id = $1`, [batch.id, n.created, n.updated, n.skipped]);
  if (req.saveMapping) {
    await tx.query(
      `insert into import_profiles (tenant_id, kind, name, header_signature, mapping, encoding, delimiter, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (tenant_id, kind, header_signature, name) do update set mapping = excluded.mapping, encoding = excluded.encoding, delimiter = excluded.delimiter, active = true, updated_at = now()`,
      [ctx.tenantId, req.kind, req.source, a.file.signature, JSON.stringify(a.mapping), a.file.encoding, a.file.delimiter, ctx.userId]);
  }
  await writeAudit(tx, ctx, [{
    action: 'import', object: `import-${req.kind}`, ref: no,
    detail: `${KIND_TH[req.kind]} · ${req.source} · ${req.fileName} · สร้าง ${n.created} · อัปเดต ${n.updated} · ข้าม ${n.skipped} · ผิด ${c.error}`,
  }]);
  return {
    id: batch.id, no, kind: req.kind, mode: req.mode, source: req.source, fileName: req.fileName, rowsTotal: a.rows.length,
    rowsCreated: n.created, rowsUpdated: n.updated, rowsSkipped: n.skipped, rowsError: c.error, createdBy: ctx.name, createdAt: b.rows[0]!.created_at.toISOString(),
    note: req.note?.trim() ?? '',
  };
}

export async function listBatches(tx: Tx, ctx: Ctx, q: { limit: number; cursor?: string }) {
  requireAny(ctx, ['data.import', 'inv.receive', 'fin.ap']);
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  let where = '';
  if (cur) { params.push(cur[0], cur[1]); where = `where (b.created_at, b.id) < ($1::timestamptz, $2::uuid)`; }
  params.push(q.limit + 1);
  const r = await tx.query<{ id: string; no: string; kind: string; mode: string; source: string; file_name: string; rows_total: number; rows_created: number; rows_updated: number; rows_skipped: number; rows_error: number; created_by: string; created_at: Date; note: string }>(
    `select b.id, b.no, b.kind, b.mode, b.source, b.file_name, b.rows_total, b.rows_created, b.rows_updated, b.rows_skipped, b.rows_error, u.name created_by, b.created_at, b.note
       from import_batches b join users u on u.id = b.created_by ${where} order by b.created_at desc, b.id desc limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (x) => [x.created_at.toISOString(), x.id], (x) => ({
    id: x.id, no: x.no, kind: x.kind, mode: x.mode, source: x.source, fileName: x.file_name, rowsTotal: x.rows_total, rowsCreated: x.rows_created,
    rowsUpdated: x.rows_updated, rowsSkipped: x.rows_skipped, rowsError: x.rows_error, createdBy: x.created_by, createdAt: x.created_at.toISOString(),
    note: x.note,
  }));
}
