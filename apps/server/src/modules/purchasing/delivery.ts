/**
 * M19-08 "นำเข้าไฟล์ใบส่งของ" (docs/integrations/onprem-delivery-file.md), both editions:
 * CSV / XLSX upload → column mapping remembered per shop (header signature) → preview with row validation →
 * one DRAFT goods receipt per delivery-note number (dedupe against received GRs and open drafts) → unmatched lines
 * mapped or created (product-code aliases remembered) → confirm = the normal manual receipt (lots + AP).
 */
import type { Tx } from '@erp/db';
import type { GrDraft } from '@erp/contracts';
import {
  d, exVat, guessMapping, matchUnit, money, parseDateCell, parseNumberCell, parseVatFlag, qty4, textCell, type Cell,
} from '@erp/core';
import { writeAudit } from '../../lib/audit';
import { can, requireAny, requirePerm, type Ctx, type Deps } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E, isUuid } from '../../lib/errors';
import { decodeCursor, likeEscape, pageOf } from '../../lib/paging';
import { receipt } from '../../services/inventory';
import { createProduct, requireWarehouse } from '../../services/master';
import { cellText, parseFile } from './fileparse';

type Field = 'product_code' | 'product_name' | 'qty' | 'unit' | 'unit_price' | 'dn_no' | 'po_no' | 'delivery_date' | 'dealer_name' | 'vat_flag' | 'invoice_no' | 'line_discount';
const FIELDS: { key: Field; aliases: string[]; required?: true }[] = [
  { key: 'product_code', aliases: ['รหัสสินค้า', 'รหัส', 'SKU', 'Item Code', 'Material', 'Product Code'], required: true },
  { key: 'product_name', aliases: ['ชื่อสินค้า', 'รายการ', 'Description', 'Product Name'], required: true },
  { key: 'qty', aliases: ['จำนวน', 'Qty', 'Quantity'], required: true },
  { key: 'unit', aliases: ['หน่วย', 'Unit', 'UOM'], required: true },
  { key: 'unit_price', aliases: ['ราคาต่อหน่วย', 'ราคา', 'Unit Price', 'Price'], required: true },
  { key: 'dn_no', aliases: ['เลขที่ใบส่งของ', 'ใบส่งของ', 'DN', 'Delivery No'] },
  { key: 'po_no', aliases: ['เลขที่ใบสั่งซื้อ', 'PO', 'PO No', 'Order No'] },
  { key: 'delivery_date', aliases: ['วันที่ส่ง', 'วันที่', 'Delivery Date'] },
  { key: 'dealer_name', aliases: ['ผู้แทนจำหน่าย', 'ผู้ขาย', 'Vendor', 'Supplier'] },
  { key: 'vat_flag', aliases: ['VAT', 'ภาษี', 'Price incl VAT'] },
  { key: 'invoice_no', aliases: ['เลขที่ใบกำกับ', 'Invoice No'] },
  { key: 'line_discount', aliases: ['ส่วนลด', 'Discount'] },
];
const REQUIRED = FIELDS.filter((f) => f.required).map((f) => f.key);
const LIMITS = { maxBytes: 5 * 1024 * 1024, maxRows: 2000 };
const PRICE_WARN = 0.3;

interface ProductLite { id: string; sku: string; name: string; barcode: string | null; kind: string; cost: string; units: { name: string; factor: string }[] }
interface AliasLite { product_id: string; vendor_id: string | null; unit_map: Record<string, number> }

interface AnalyzedRow {
  rowNo: number; cells: string[]; status: 'ok' | 'warn' | 'error'; messages: string[];
  productCode: string; productName: string; qty: string | null; unit: string; unitPrice: string | null; lineDiscount: string;
  dnNo: string | null; poNo: string | null; deliveryDate: string | null; dealerName: string | null; vatFlag: 'inc' | 'exc' | 'none' | null; invoiceNo: string | null;
  match: { productId: string; unitIdx: number | null; via: 'alias' | 'sku' | 'barcode' } | null;
}

interface Analysis {
  file: Awaited<ReturnType<typeof parseFile>>;
  mapping: Partial<Record<Field, number>>; profileId: string | null; profileName: string | null; missingRequired: Field[];
  rows: AnalyzedRow[];
  groups: { dnNo: string | null; poNo: string | null; deliveryDate: string | null; dealerName: string | null; vendorId: string | null; invoiceNo: string | null; vatFlag: 'inc' | 'exc' | 'none'; rows: AnalyzedRow[]; duplicate: { kind: 'received' | 'draft'; ref: string; date: string } | null }[];
  fileImportedAt: string | null;
}

async function analyze(
  tx: Tx, deps: Deps,
  req: { fileName: string; contentBase64: string; encoding: 'auto' | 'utf8' | 'tis620'; mapping?: Partial<Record<Field, number>>; vendorId?: string; vatFlagDefault?: 'inc' | 'exc' | 'none' },
): Promise<Analysis> {
  const file = await parseFile(req.fileName, req.contentBase64, req.encoding, LIMITS);
  let mapping = req.mapping;
  let profileId: string | null = null;
  let profileName: string | null = null;
  let profileVendor: string | null = null;
  let profileVat: string | null = null;
  const prof = await tx.query<{ id: string; name: string; mapping: Record<string, number>; vendor_id: string | null; vat_flag_default: string | null }>(
    `select id, name, mapping, vendor_id, vat_flag_default from import_profiles where kind = 'delivery' and active and header_signature = $1 order by updated_at desc limit 1`, [file.signature]);
  if (prof.rows[0]) {
    profileId = prof.rows[0].id;
    profileName = prof.rows[0].name;
    profileVendor = prof.rows[0].vendor_id;
    profileVat = prof.rows[0].vat_flag_default;
    mapping ??= prof.rows[0].mapping as Partial<Record<Field, number>>;
  }
  mapping ??= guessMapping(file.headers, FIELDS) as Partial<Record<Field, number>>;
  for (const [k, v] of Object.entries(mapping)) if (v == null || v < 0 || v >= file.headers.length) delete mapping[k as Field];
  const missingRequired = REQUIRED.filter((f) => mapping![f] == null);
  const vatDefault = req.vatFlagDefault ?? (profileVat as 'inc' | 'exc' | 'none' | null) ?? 'exc';

  const products = (await tx.query<ProductLite>(`select id, sku, name, barcode, kind, cost::text, units from products where active`)).rows;
  const bySku = new Map(products.map((p) => [p.sku.toLowerCase(), p]));
  const byBarcode = new Map(products.filter((p) => p.barcode).map((p) => [p.barcode!, p]));
  const byId = new Map(products.map((p) => [p.id, p]));
  const aliases = (await tx.query<AliasLite & { code: string }>(`select lower(external_code) code, product_id, vendor_id, unit_map from product_code_aliases where active`)).rows;
  const vendorId = req.vendorId && isUuid(req.vendorId) ? req.vendorId : profileVendor;
  const findAlias = (code: string, vid: string | null) => {
    const c = code.toLowerCase();
    return aliases.find((a) => a.code === c && a.vendor_id === vid) ?? aliases.find((a) => a.code === c && a.vendor_id == null);
  };

  const get = (cells: Cell[], f: Field): Cell => (mapping![f] == null ? null : cells[mapping![f]!]);
  const today = deps.today();
  const rows: AnalyzedRow[] = file.rows.map(({ rowNo, cells }) => {
    const msgs: string[] = [];
    let err = false;
    let warn = false;
    const code = textCell(get(cells, 'product_code'));
    const qtyS = parseNumberCell(get(cells, 'qty'));
    const priceS = parseNumberCell(get(cells, 'unit_price'));
    const discS = get(cells, 'line_discount') == null || textCell(get(cells, 'line_discount')) === '' ? '0' : parseNumberCell(get(cells, 'line_discount'));
    const dateCell = get(cells, 'delivery_date');
    const date = parseDateCell(dateCell);
    const vatCell = get(cells, 'vat_flag');
    const vat = vatCell == null || textCell(vatCell) === '' ? vatDefault : parseVatFlag(vatCell);
    if (!code) { err = true; msgs.push('ไม่มีรหัสสินค้า'); }
    if (qtyS == null) { err = true; msgs.push('จำนวนไม่ใช่ตัวเลข'); } else if (!d(qtyS).gt(0)) { err = true; msgs.push('จำนวนต้องมากกว่า 0'); }
    if (priceS == null) { err = true; msgs.push('ราคาไม่ใช่ตัวเลข'); } else if (d(priceS).lt(0)) { err = true; msgs.push('ราคาติดลบ'); }
    if (discS == null || d(discS).lt(0)) { err = true; msgs.push('ส่วนลดไม่ถูกต้อง'); }
    if (textCell(dateCell) && !date) { err = true; msgs.push('วันที่ไม่ถูกต้อง'); }
    if (date && date > today) { err = true; msgs.push('วันที่ส่งเป็นวันในอนาคต'); }
    if (vat == null) { warn = true; msgs.push(`ไม่รู้จักค่า VAT "${textCell(vatCell)}" ใช้ค่าเริ่มต้น`); }
    const unit = textCell(get(cells, 'unit'));
    let match: AnalyzedRow['match'] = null;
    if (code) {
      const a = findAlias(code, vendorId);
      const p = a ? byId.get(a.product_id) : bySku.get(code.toLowerCase()) ?? byBarcode.get(code);
      if (p) {
        const via = a ? 'alias' : bySku.has(code.toLowerCase()) ? 'sku' : 'barcode';
        let idx = a && a.unit_map[unit] != null ? a.unit_map[unit]! : matchUnit(unit, p.units);
        if (idx >= p.units.length) idx = -1;
        match = { productId: p.id, unitIdx: idx >= 0 ? idx : null, via };
        if (p.kind === 'service') { err = true; msgs.push(`${p.sku} เป็นบริการ รับเข้าสต็อกไม่ได้`); }
        if (idx < 0) msgs.push(`ยังไม่ผูกหน่วย "${unit}"`);
        else if (priceS && d(p.cost).gt(0) && !err) {
          const base = d(priceS).div(d(p.units[idx]!.factor));
          if (base.minus(d(p.cost)).abs().div(d(p.cost)).gt(PRICE_WARN)) { warn = true; msgs.push(`ราคาต่างจากต้นทุนล่าสุดเกิน 30%`); }
        }
      } else {
        msgs.push('ยังไม่ผูกกับสินค้าของร้าน');
      }
    }
    return {
      rowNo, cells: cells.map(cellText), status: err ? 'error' : warn ? 'warn' : 'ok', messages: msgs,
      productCode: code, productName: textCell(get(cells, 'product_name')), qty: qtyS, unit, unitPrice: priceS, lineDiscount: discS ?? '0',
      dnNo: textCell(get(cells, 'dn_no')) || null, poNo: textCell(get(cells, 'po_no')) || null, deliveryDate: date,
      dealerName: textCell(get(cells, 'dealer_name')) || null, vatFlag: vat ?? vatDefault, invoiceNo: textCell(get(cells, 'invoice_no')) || null, match,
    };
  });

  // Duplicate product codes inside one delivery note: warning (lines stay separate; moving average handles it).
  const seen = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.dnNo ?? ''}\u0001${r.productCode.toLowerCase()}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const r of rows) if ((seen.get(`${r.dnNo ?? ''}\u0001${r.productCode.toLowerCase()}`) ?? 0) > 1 && r.status !== 'error') {
    r.status = 'warn';
    r.messages.push('รหัสสินค้าซ้ำในใบส่งของเดียวกัน');
  }

  const vendors = (await tx.query<{ id: string; name: string; tax_id: string | null }>(`select id, name, tax_id from vendors`)).rows;
  const vendorFor = (dealer: string | null) => {
    if (vendorId) return vendorId;
    if (!dealer) return null;
    const n = dealer.replace(/\s+/g, '').toLowerCase();
    return vendors.find((v) => v.tax_id === dealer.trim())?.id
      ?? vendors.find((v) => { const vn = v.name.replace(/\s+/g, '').toLowerCase(); return vn.includes(n) || n.includes(vn.replace(/\(.*\)/, '')); })?.id ?? null;
  };
  const groups: Analysis['groups'] = [];
  for (const r of rows) {
    let g = groups.find((x) => x.dnNo === r.dnNo);
    if (!g) {
      g = { dnNo: r.dnNo, poNo: r.poNo, deliveryDate: r.deliveryDate, dealerName: r.dealerName, vendorId: vendorFor(r.dealerName), invoiceNo: r.invoiceNo, vatFlag: r.vatFlag ?? vatDefault, rows: [], duplicate: null };
      groups.push(g);
    }
    g.rows.push(r);
  }
  for (const g of groups) {
    if (!g.dnNo) continue;
    const got = await tx.query<{ no: string; date: string }>(`select no, to_char(date,'YYYY-MM-DD') date from stock_docs where type = 'GR' and delivery_no = $1 order by created_at limit 1`, [g.dnNo]);
    if (got.rows[0]) { g.duplicate = { kind: 'received', ref: got.rows[0].no, date: got.rows[0].date }; continue; }
    const dr = await tx.query<{ id: string; date: string }>(`select id, to_char(received_on,'YYYY-MM-DD') date from gr_drafts where status = 'draft' and dn_no = $1`, [g.dnNo]);
    if (dr.rows[0]) g.duplicate = { kind: 'draft', ref: g.dnNo, date: dr.rows[0].date };
  }
  const prev = await tx.query<{ created_at: Date }>(`select created_at from import_batches where kind = 'delivery' and file_sha256 = $1 order by created_at limit 1`, [file.sha256]);
  return { file, mapping, profileId, profileName, missingRequired, rows, groups, fileImportedAt: prev.rows[0]?.created_at.toISOString() ?? null };
}

export async function deliveryPreview(tx: Tx, deps: Deps, ctx: Ctx, req: Parameters<typeof analyze>[2]) {
  requirePerm(ctx, 'inv.receive');
  const a = await analyze(tx, deps, req);
  return {
    headers: a.file.headers, encoding: a.file.encoding, delimiter: a.file.delimiter, signature: a.file.signature,
    mapping: a.mapping as Record<string, number>, profileId: a.profileId, profileName: a.profileName, missingRequired: a.missingRequired,
    rows: a.rows.map((r) => ({ rowNo: r.rowNo, cells: r.cells, status: r.status, messages: r.messages, productCode: r.productCode, productName: r.productName, qty: r.qty, unit: r.unit, unitPrice: r.unitPrice, dnNo: r.dnNo, match: r.match })),
    groups: a.groups.map((g) => ({
      dnNo: g.dnNo, poNo: g.poNo, deliveryDate: g.deliveryDate, dealerName: g.dealerName, vendorId: g.vendorId, lines: g.rows.length,
      unmatched: g.rows.filter((r) => r.status !== 'error' && (!r.match || r.match.unitIdx == null)).length, errors: g.rows.filter((r) => r.status === 'error').length, duplicate: g.duplicate,
    })),
    fileImportedAt: a.fileImportedAt,
    counts: { ok: a.rows.filter((r) => r.status === 'ok').length, warn: a.rows.filter((r) => r.status === 'warn').length, error: a.rows.filter((r) => r.status === 'error').length },
  };
}

export async function deliveryCommit(
  tx: Tx, deps: Deps, ctx: Ctx,
  req: Parameters<typeof analyze>[2] & { mapping: Partial<Record<Field, number>>; warehouseId?: string; saveProfile: boolean; profileName?: string; forceDnNos: string[]; forceReason?: string },
) {
  requirePerm(ctx, 'inv.receive');
  const a = await analyze(tx, deps, req);
  if (a.missingRequired.length) throw E.validation(`ยังไม่ได้จับคู่คอลัมน์: ${a.missingRequired.join(', ')}`, { missing: a.missingRequired });
  if (req.forceDnNos.length && !req.forceReason?.trim()) throw E.validation('นำเข้าซ้ำต้องระบุเหตุผล');
  const wh = req.warehouseId ? (await requireWarehouse(tx, req.warehouseId)).id : null;
  const no = await nextDocNo(tx, ctx.tenantId, 'IMP', deps.today());
  const batch = await tx.query<{ id: string }>(
    `insert into import_batches (tenant_id, no, kind, mode, source, file_name, file_sha256, rows_total, rows_error, created_by)
     values ($1,$2,'delivery','delivery',$3,$4,$5,$6,$7,$8) returning id`,
    [ctx.tenantId, no, a.profileName ?? req.profileName ?? 'ไฟล์ใบส่งของ', req.fileName, a.file.sha256, a.rows.length, a.rows.filter((r) => r.status === 'error').length, ctx.userId]);
  const batchId = batch.rows[0]!.id;
  const drafts: { id: string; dnNo: string | null; lines: number; unmatched: number }[] = [];
  const skipped: { dnNo: string | null; reason: string }[] = [];
  let created = 0;
  for (const g of a.groups) {
    const forced = g.dnNo != null && req.forceDnNos.includes(g.dnNo);
    if (g.duplicate && !(forced && g.duplicate.kind === 'received')) {
      skipped.push({ dnNo: g.dnNo, reason: g.duplicate.kind === 'received' ? `DN ${g.dnNo} รับแล้วใน ${g.duplicate.ref} เมื่อ ${g.duplicate.date}` : `DN ${g.dnNo} มีใบรับของร่างค้างอยู่แล้ว` });
      continue;
    }
    const good = g.rows.filter((r) => r.status !== 'error');
    if (!good.length) {
      skipped.push({ dnNo: g.dnNo, reason: 'ทุกบรรทัดมีข้อผิดพลาด' });
      continue;
    }
    const dr = await tx.query<{ id: string }>(
      `insert into gr_drafts (tenant_id, batch_id, dn_no, po_no, invoice_no, dealer_name, vendor_id, warehouse_id, delivery_date, received_on, vat_flag, force_reason, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [ctx.tenantId, batchId, g.dnNo, g.poNo, g.invoiceNo, g.dealerName, g.vendorId, wh, g.deliveryDate, deps.today(), g.vatFlag, forced ? req.forceReason!.trim() : null, ctx.userId]);
    for (const [i, r] of good.entries()) {
      await tx.query(
        `insert into gr_draft_lines (tenant_id, draft_id, line_no, row_no, external_code, external_name, unit_text, qty, unit_price, line_discount, product_id, unit_idx, received_qty, warnings)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$8,$13)`,
        [ctx.tenantId, dr.rows[0]!.id, i + 1, r.rowNo, r.productCode, r.productName || r.productCode, r.unit, r.qty, r.unitPrice, money(r.lineDiscount), r.match?.productId ?? null, r.match?.unitIdx ?? null, JSON.stringify(r.messages)]);
    }
    created += good.length;
    drafts.push({ id: dr.rows[0]!.id, dnNo: g.dnNo, lines: good.length, unmatched: good.filter((r) => !r.match || r.match.unitIdx == null).length });
  }
  await tx.query(`update import_batches set rows_created = $2, rows_skipped = $3 where id = $1`, [batchId, created, a.rows.length - created - a.rows.filter((r) => r.status === 'error').length]);
  if (req.saveProfile) {
    const name = (req.profileName?.trim() || a.profileName || a.groups[0]?.dealerName || 'ไฟล์ใบส่งของ').slice(0, 80);
    await tx.query(
      `insert into import_profiles (tenant_id, kind, name, header_signature, mapping, encoding, delimiter, vat_flag_default, vendor_id, created_by)
       values ($1,'delivery',$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (tenant_id, kind, header_signature, name) do update set mapping = excluded.mapping, encoding = excluded.encoding, delimiter = excluded.delimiter,
         vat_flag_default = excluded.vat_flag_default, vendor_id = coalesce(excluded.vendor_id, import_profiles.vendor_id), active = true, updated_at = now()`,
      [ctx.tenantId, name, a.file.signature, JSON.stringify(a.mapping), a.file.encoding, a.file.delimiter, req.vatFlagDefault ?? null, req.vendorId && isUuid(req.vendorId) ? req.vendorId : null, ctx.userId]);
  }
  await writeAudit(tx, ctx, [{
    action: 'import', object: 'delivery-file', ref: no,
    detail: `${req.fileName} · ใบรับของร่าง ${drafts.length} ใบ (${drafts.map((x) => x.dnNo ?? 'ไม่มี DN').join(', ')})${skipped.length ? ` · ข้าม ${skipped.map((s) => s.dnNo ?? '-').join(', ')}` : ''}${req.forceDnNos.length ? ` · นำเข้าซ้ำ: ${req.forceReason}` : ''}`,
  }]);
  return { batchNo: no, drafts, skipped, errorRows: a.rows.filter((r) => r.status === 'error').length };
}

// ---------- drafts ----------
interface DraftRow {
  id: string; dn_no: string | null; po_no: string | null; invoice_no: string | null; dealer_name: string | null; vendor_id: string | null; warehouse_id: string | null;
  delivery_date: string | null; received_on: string; vat_flag: 'inc' | 'exc' | 'none'; status: GrDraft['status']; confirmed_no: string | null; created_by: string; unmatched: number; line_count: number; vat_registered: boolean;
}
const DRAFT_SELECT = `
  select g.id, g.dn_no, g.po_no, g.invoice_no, g.dealer_name, g.vendor_id, g.warehouse_id, to_char(g.delivery_date,'YYYY-MM-DD') delivery_date,
         to_char(g.received_on,'YYYY-MM-DD') received_on, g.vat_flag, g.status, g.confirmed_no, u.name created_by, t.vat_registered,
         (select count(*)::int from gr_draft_lines l where l.draft_id = g.id and (l.product_id is null or l.unit_idx is null)) unmatched,
         (select count(*)::int from gr_draft_lines l where l.draft_id = g.id) line_count
    from gr_drafts g join users u on u.id = g.created_by join tenants t on t.id = g.tenant_id`;
const age = (on: string, today: string) => Math.max(0, Math.round((Date.parse(today) - Date.parse(on)) / 864e5));
const draftHead = (r: DraftRow, today: string) => ({
  id: r.id, dnNo: r.dn_no, poNo: r.po_no, invoiceNo: r.invoice_no, dealerName: r.dealer_name, vendorId: r.vendor_id, warehouseId: r.warehouse_id,
  deliveryDate: r.delivery_date, receivedOn: r.received_on, ageDays: age(r.received_on, today), vatFlag: r.vat_flag, status: r.status, confirmedNo: r.confirmed_no,
  unmatched: r.unmatched, createdBy: r.created_by,
});

/** Unit cost per line unit for the receipt: price − line discount per unit, ex VAT when the file price includes VAT (VAT shop). */
export function draftUnitCost(l: { qty: string; unit_price: string; line_discount: string }, vatFlag: 'inc' | 'exc' | 'none', vatRegistered: boolean): string {
  const net = d(l.unit_price).minus(d(l.line_discount).div(d(l.qty)));
  const v = net.lt(0) ? d(0) : net;
  return vatFlag === 'inc' && vatRegistered ? exVat(v.toFixed()) : qty4(v);
}

export async function listDrafts(tx: Tx, deps: Deps, ctx: Ctx, q: { q?: string; limit: number; cursor?: string; status: GrDraft['status'] }) {
  requireAny(ctx, ['inv.receive', 'inv.view'], { readOnly: true });
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [q.status];
  const where = ['g.status = $1'];
  for (const w of (q.q ?? '').trim().split(/\s+/).filter(Boolean)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(coalesce(g.dn_no,'') ilike $${params.length} or coalesce(g.po_no,'') ilike $${params.length} or coalesce(g.dealer_name,'') ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(g.received_on, g.id) > ($${params.length - 1}::date, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<DraftRow>(`${DRAFT_SELECT} where ${where.join(' and ')} order by g.received_on, g.id limit $${params.length}`, params);
  const today = deps.today();
  return pageOf(r.rows, q.limit, (x) => [x.received_on, x.id], (x) => ({ ...draftHead(x, today), lineCount: x.line_count }));
}

export async function getDraft(tx: Tx, deps: Deps, ctx: Ctx, id: string): Promise<GrDraft> {
  requireAny(ctx, ['inv.receive', 'inv.view'], { readOnly: true });
  if (!isUuid(id)) throw E.notFound('ไม่พบใบรับของร่าง');
  const r = await tx.query<DraftRow>(`${DRAFT_SELECT} where g.id = $1`, [id]);
  const g = r.rows[0];
  if (!g) throw E.notFound('ไม่พบใบรับของร่าง');
  const lines = await tx.query<{ id: string; line_no: number; row_no: number; external_code: string; external_name: string; unit_text: string; qty: string; unit_price: string; line_discount: string; product_id: string | null; unit_idx: number | null; received_qty: string | null; damaged_qty: string; warnings: string[] }>(
    `select id, line_no, row_no, external_code, external_name, unit_text, qty::text, unit_price::text, line_discount::text, product_id, unit_idx, received_qty::text, damaged_qty::text, warnings
       from gr_draft_lines where draft_id = $1 order by line_no`, [g.id]);
  const seeCost = can(ctx, 'data.cost') === 1;
  return {
    ...draftHead(g, deps.today()),
    lines: lines.rows.map((l) => ({
      id: l.id, lineNo: l.line_no, rowNo: l.row_no, externalCode: l.external_code, externalName: l.external_name, unitText: l.unit_text, qty: qty4(l.qty),
      unitPrice: qty4(l.unit_price), lineDiscount: money(l.line_discount), productId: l.product_id, unitIdx: l.unit_idx,
      receivedQty: qty4(l.received_qty ?? l.qty), damagedQty: qty4(l.damaged_qty),
      unitCost: seeCost ? draftUnitCost(l, g.vat_flag, g.vat_registered) : null, warnings: l.warnings,
    })),
  };
}

async function lockDraft(tx: Tx, id: string) {
  if (!isUuid(id)) throw E.notFound('ไม่พบใบรับของร่าง');
  const r = await tx.query<{ id: string; status: string; dn_no: string | null; vendor_id: string | null; warehouse_id: string | null; vat_flag: 'inc' | 'exc' | 'none'; force_reason: string | null }>(
    `select id, status, dn_no, vendor_id, warehouse_id, vat_flag, force_reason from gr_drafts where id = $1 for update`, [id]);
  const g = r.rows[0];
  if (!g) throw E.notFound('ไม่พบใบรับของร่าง');
  if (g.status !== 'draft') throw E.conflict(`ใบรับของนี้${g.status === 'confirmed' ? 'ยืนยันรับแล้ว' : 'ถูกยกเลิกแล้ว'}`);
  return g;
}

/** Remembers file code → product (and the file unit → unit index) for the next file (spec §3.4). */
async function rememberAlias(tx: Tx, ctx: Ctx, code: string, productId: string, unitText: string, unitIdx: number | null) {
  const unitMap = unitIdx == null ? {} : { [unitText]: unitIdx };
  await tx.query(
    `insert into product_code_aliases (tenant_id, vendor_id, external_code, product_id, unit_map, created_by) values ($1, null, $2, $3, $4, $5)
     on conflict (tenant_id, coalesce(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(external_code))
     do update set product_id = excluded.product_id, active = true, updated_at = now(),
       unit_map = case when product_code_aliases.product_id = excluded.product_id then product_code_aliases.unit_map || excluded.unit_map else excluded.unit_map end`,
    [ctx.tenantId, code, productId, JSON.stringify(unitMap), ctx.userId]);
}

export async function updateDraft(
  tx: Tx, deps: Deps, ctx: Ctx, id: string,
  req: { vendorId?: string | null; warehouseId?: string | null; invoiceNo?: string | null; dnNo?: string | null; lines?: { lineId: string; productId?: string | null; unitIdx?: number | null; receivedQty?: string; damagedQty?: string }[] },
) {
  requirePerm(ctx, 'inv.receive');
  const g = await lockDraft(tx, id);
  if (req.vendorId !== undefined) {
    if (req.vendorId && (!isUuid(req.vendorId) || !(await tx.query(`select 1 from vendors where id = $1`, [req.vendorId])).rowCount)) throw E.validation('Unknown vendor');
    await tx.query(`update gr_drafts set vendor_id = $2 where id = $1`, [g.id, req.vendorId]);
  }
  if (req.warehouseId !== undefined) {
    if (req.warehouseId) await requireWarehouse(tx, req.warehouseId);
    await tx.query(`update gr_drafts set warehouse_id = $2 where id = $1`, [g.id, req.warehouseId]);
  }
  if (req.invoiceNo !== undefined) await tx.query(`update gr_drafts set invoice_no = $2 where id = $1`, [g.id, req.invoiceNo?.trim() || null]);
  if (req.dnNo !== undefined) {
    const dn = req.dnNo?.trim() || null;
    if (dn) {
      const dup = await tx.query<{ no: string }>(`select no from stock_docs where type = 'GR' and delivery_no = $1`, [dn]);
      if (dup.rows[0] && !g.force_reason) throw E.conflict(`DN ${dn} รับแล้วใน ${dup.rows[0].no}`);
      const dd = await tx.query(`select 1 from gr_drafts where status = 'draft' and dn_no = $1 and id <> $2`, [dn, g.id]);
      if (dd.rowCount) throw E.conflict(`DN ${dn} มีใบรับของร่างค้างอยู่แล้ว`);
    }
    await tx.query(`update gr_drafts set dn_no = $2 where id = $1`, [g.id, dn]);
  }
  const mapped: string[] = [];
  for (const l of req.lines ?? []) {
    if (!isUuid(l.lineId)) throw E.validation('Unknown line');
    const cur = await tx.query<{ external_code: string; unit_text: string; product_id: string | null; unit_idx: number | null }>(
      `select external_code, unit_text, product_id, unit_idx from gr_draft_lines where id = $1 and draft_id = $2`, [l.lineId, g.id]);
    const row = cur.rows[0];
    if (!row) throw E.validation('Unknown line');
    let productId = l.productId === undefined ? row.product_id : l.productId;
    let unitIdx = l.unitIdx === undefined ? row.unit_idx : l.unitIdx;
    if (l.productId !== undefined && l.productId !== row.product_id && l.unitIdx === undefined) unitIdx = null;
    if (productId) {
      const p = await tx.query<{ kind: string; units: { name: string }[]; sku: string }>(`select kind, units, sku from products where id = $1`, [isUuid(productId) ? productId : null]);
      const pr = p.rows[0];
      if (!pr) throw E.validation('Unknown product');
      if (pr.kind !== 'stock') throw E.validation(`${pr.sku} เป็นบริการ รับเข้าสต็อกไม่ได้`);
      if (unitIdx == null) { const m = matchUnit(row.unit_text, pr.units); unitIdx = m >= 0 ? m : null; }
      if (unitIdx != null && unitIdx >= pr.units.length) throw E.validation(`${pr.sku} has no unit #${unitIdx}`);
    } else {
      productId = null;
      unitIdx = null;
    }
    if (l.receivedQty !== undefined && d(l.receivedQty).lt(0)) throw E.validation('จำนวนรับต้องไม่ติดลบ');
    await tx.query(
      `update gr_draft_lines set product_id = $2, unit_idx = $3, received_qty = coalesce($4, received_qty), damaged_qty = coalesce($5, damaged_qty) where id = $1`,
      [l.lineId, productId, unitIdx, l.receivedQty ?? null, l.damagedQty ?? null]);
    if (productId && (productId !== row.product_id || unitIdx !== row.unit_idx)) {
      await rememberAlias(tx, ctx, row.external_code, productId, row.unit_text, unitIdx);
      mapped.push(row.external_code);
    }
  }
  const head = await tx.query<{ dn_no: string | null }>(`select dn_no from gr_drafts where id = $1`, [g.id]);
  await writeAudit(tx, ctx, [{ action: 'update', object: 'gr-draft', ref: head.rows[0]?.dn_no ?? g.id, detail: mapped.length ? `ผูกสินค้า ${mapped.join(', ')}` : 'แก้ไขใบรับของร่าง' }]);
  return getDraft(tx, deps, ctx, g.id);
}

export async function createProductForLine(tx: Tx, deps: Deps, ctx: Ctx, id: string, lineId: string, req: { sku: string; name: string; unitName: string; price: string; category: string }) {
  requireAny(ctx, ['data.master', 'inv.receive']); // REQ-M05-04: the warehouse keeper creates the product from the GR screen
  const g = await lockDraft(tx, id);
  if (!isUuid(lineId)) throw E.validation('Unknown line');
  const l = await tx.query<{ external_code: string; unit_text: string; unit_price: string; qty: string; line_discount: string }>(
    `select external_code, unit_text, unit_price::text, qty::text, line_discount::text from gr_draft_lines where id = $1 and draft_id = $2`, [lineId, g.id]);
  const row = l.rows[0];
  if (!row) throw E.validation('Unknown line');
  const dup = await tx.query(`select 1 from products where lower(sku) = lower($1)`, [req.sku]);
  if (dup.rowCount) throw E.conflict(`รหัสสินค้า ${req.sku} มีอยู่แล้ว ให้เลือกผูกกับสินค้าเดิม`);
  const p = await createProduct(tx, ctx, {
    sku: req.sku.trim(), name: req.name.trim(), category: req.category, isScg: false, kind: 'stock', vat: 'v7', price: money(req.price),
    units: [{ name: req.unitName.trim(), factor: '1' }], reorderPoint: '0',
  });
  await tx.query(`update gr_draft_lines set product_id = $2, unit_idx = 0 where id = $1`, [lineId, p.id]);
  await rememberAlias(tx, ctx, row.external_code, p.id, row.unit_text, 0);
  await writeAudit(tx, ctx, [{ action: 'create', object: 'product', ref: p.sku, detail: `จากใบรับของร่าง DN ${g.dn_no ?? '-'} · ${p.name}` }]);
  return getDraft(tx, deps, ctx, g.id);
}

export async function confirmDraft(tx: Tx, deps: Deps, ctx: Ctx, id: string, req: { vendorInvoiceNo: string; deliveryNo: string; billDiscount: string; shortReason?: string }) {
  requirePerm(ctx, 'inv.receive');
  const g = await lockDraft(tx, id);
  if (!g.vendor_id) throw E.validation('เลือกผู้ขายก่อนยืนยันรับ');
  if (!g.warehouse_id) throw E.validation('เลือกคลังรับเข้าก่อนยืนยันรับ');
  const lines = await tx.query<{ id: string; external_code: string; qty: string; unit_price: string; line_discount: string; product_id: string | null; unit_idx: number | null; received_qty: string | null; damaged_qty: string }>(
    `select id, external_code, qty::text, unit_price::text, line_discount::text, product_id, unit_idx, received_qty::text, damaged_qty::text from gr_draft_lines where draft_id = $1 order by line_no`, [g.id]);
  const unmatched = lines.rows.filter((l) => !l.product_id || l.unit_idx == null);
  if (unmatched.length) throw E.validation(`ผูกสินค้าให้ครบก่อนยืนยันรับ (${unmatched.map((l) => l.external_code).join(', ')})`, { unmatched: unmatched.map((l) => l.id) }); // REQ-M05-04
  const mismatch = lines.rows.some((l) => !d(l.received_qty ?? l.qty).eq(d(l.qty)) || d(l.damaged_qty).gt(0));
  if (mismatch && !req.shortReason?.trim()) throw E.validation('รับไม่ตรงใบส่งของ ต้องระบุเหตุผล'); // REQ-M05-03
  const dn = req.deliveryNo.trim();
  if (!g.force_reason) {
    const dup = await tx.query<{ no: string }>(`select no from stock_docs where type = 'GR' and delivery_no = $1`, [dn]);
    if (dup.rows[0]) throw E.conflict(`DN ${dn} รับแล้วใน ${dup.rows[0].no}`);
  }
  const vat = (await tx.query<{ vat_registered: boolean }>(`select vat_registered from tenants where id = $1`, [ctx.tenantId])).rows[0]?.vat_registered ?? true;
  const recv = lines.rows.map((l) => {
    const accepted = d(l.received_qty ?? l.qty).minus(d(l.damaged_qty));
    if (accepted.lt(0)) throw E.validation(`${l.external_code}: จำนวนเสียหายมากกว่าจำนวนรับ`);
    return { productId: l.product_id!, unitIdx: l.unit_idx!, qty: qty4(accepted), unitCost: draftUnitCost(l, g.vat_flag, vat) };
  }).filter((l) => d(l.qty).gt(0));
  if (!recv.length) throw E.validation('ไม่มีสินค้าที่รับเข้าได้');
  const doc = await receipt(tx, deps, ctx, { vendorId: g.vendor_id, vendorInvoiceNo: req.vendorInvoiceNo.trim(), deliveryNo: dn, warehouseId: g.warehouse_id, lines: recv, billDiscount: req.billDiscount });
  await tx.query(`update gr_drafts set status = 'confirmed', confirmed_doc_id = $2, confirmed_no = $3, dn_no = $4, invoice_no = $5, short_reason = $6 where id = $1`,
    [g.id, doc.id, doc.no, dn, req.vendorInvoiceNo.trim(), req.shortReason?.trim() || null]);
  const ap = await tx.query<{ no: string }>(`select no from ap_bills where gr_doc_id = $1`, [doc.id]);
  await writeAudit(tx, ctx, [{ action: 'confirm', object: 'gr-draft', ref: dn, detail: `ยืนยันรับเป็น ${doc.no}${req.shortReason?.trim() ? ` · รับไม่ตรง: ${req.shortReason.trim()}` : ''}` }]);
  return { grNo: doc.no, apBillNo: ap.rows[0]?.no ?? null };
}

export async function cancelDraft(tx: Tx, ctx: Ctx, id: string, reason?: string) {
  requirePerm(ctx, 'inv.receive');
  const g = await lockDraft(tx, id);
  await tx.query(`update gr_drafts set status = 'cancelled' where id = $1`, [g.id]);
  await writeAudit(tx, ctx, [{ action: 'cancel', object: 'gr-draft', ref: g.dn_no ?? g.id, detail: reason?.trim() || 'ยกเลิกใบรับของร่าง' }]);
  return { ok: true };
}

// ---------- profiles and aliases ----------
export async function listProfiles(tx: Tx, ctx: Ctx, q: { limit: number; cursor?: string }) {
  requireAny(ctx, ['inv.receive', 'data.import']);
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  let where = 'where active';
  if (cur) { params.push(cur[0], cur[1]); where += ` and (updated_at, id) < ($1::timestamptz, $2::uuid)`; }
  params.push(q.limit + 1);
  const r = await tx.query<{ id: string; kind: string; name: string; mapping: Record<string, number>; encoding: string | null; vendor_id: string | null; updated_at: Date }>(
    `select id, kind, name, mapping, encoding, vendor_id, updated_at from import_profiles ${where} order by updated_at desc, id desc limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (x) => [x.updated_at.toISOString(), x.id], (x) => ({ id: x.id, kind: x.kind, name: x.name, mapping: x.mapping, encoding: x.encoding, vendorId: x.vendor_id, updatedAt: x.updated_at.toISOString() }));
}

export async function disableProfile(tx: Tx, ctx: Ctx, id: string) {
  requireAny(ctx, ['inv.receive', 'data.import']);
  if (!isUuid(id)) throw E.notFound('ไม่พบ mapping');
  const r = await tx.query<{ name: string }>(`update import_profiles set active = false, updated_at = now() where id = $1 and active returning name`, [id]);
  if (!r.rows[0]) throw E.notFound('ไม่พบ mapping');
  await writeAudit(tx, ctx, [{ action: 'delete', object: 'import-profile', ref: r.rows[0].name, detail: 'ลบการจับคู่คอลัมน์' }]);
  return { ok: true };
}

export async function listAliases(tx: Tx, ctx: Ctx, q: { q?: string; limit: number; cursor?: string }) {
  requireAny(ctx, ['inv.receive', 'data.import']);
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where = ['a.active'];
  for (const w of (q.q ?? '').trim().split(/\s+/).filter(Boolean)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(a.external_code ilike $${params.length} or p.name ilike $${params.length} or p.sku ilike $${params.length})`);
  }
  if (cur) { params.push(cur[0], cur[1]); where.push(`(a.external_code, a.id) > ($${params.length - 1}, $${params.length}::uuid)`); }
  params.push(q.limit + 1);
  const r = await tx.query<{ id: string; vendor_id: string | null; external_code: string; product_id: string; name: string; unit_map: Record<string, number>; updated_at: Date }>(
    `select a.id, a.vendor_id, a.external_code, a.product_id, p.name, a.unit_map, a.updated_at from product_code_aliases a join products p on p.id = a.product_id
      where ${where.join(' and ')} order by a.external_code, a.id limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (x) => [x.external_code, x.id], (x) => ({ id: x.id, vendorId: x.vendor_id, externalCode: x.external_code, productId: x.product_id, productName: x.name, unitMap: x.unit_map, updatedAt: x.updated_at.toISOString() }));
}

export async function disableAlias(tx: Tx, ctx: Ctx, id: string) {
  requireAny(ctx, ['inv.receive', 'data.import']);
  if (!isUuid(id)) throw E.notFound('ไม่พบรหัสที่ผูกไว้');
  const r = await tx.query<{ external_code: string }>(`update product_code_aliases set active = false, updated_at = now() where id = $1 and active returning external_code`, [id]);
  if (!r.rows[0]) throw E.notFound('ไม่พบรหัสที่ผูกไว้');
  await writeAudit(tx, ctx, [{ action: 'delete', object: 'product-alias', ref: r.rows[0].external_code, detail: 'ลบการผูกรหัสสินค้า' }]);
  return { ok: true };
}

