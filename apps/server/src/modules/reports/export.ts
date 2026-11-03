/**
 * M12 accounting export: PEAK / FlowAccount / Express / general journal / generic CSV, with history (REQ-M12-04).
 * A run builds its files, stores them (export_files) so they can be downloaded again, and records which documents
 * went out (export_run_docs) for "only not yet exported" and the "voided after export" warning.
 */
import type { Tx } from '@erp/db';
import type { ExportDataset, ExportGl, ExportRun, ExportRunReq, ExportTemplate } from '@erp/contracts';
import { EXPORT_COMBOS } from '@erp/contracts';
import {
  DEFAULT_GL, EXPRESS_HEAD, FLOWACCOUNT_HEAD, GENERIC_BOOK_HEAD, GL_LABELS, JOURNAL_HEAD, PEAK_CONTACT_HEAD, PEAK_DOC_HEAD, PEAK_PRODUCT_HEAD,
  d, dueDate, expressRows, flowAccountRows, genericBookRows, journalLines, journalRows, lineExVat, lineVatShares, missingGl, money, peakContactRows,
  peakDocRows, peakProductRows, qty4, splitPeakFiles, sum, thaiDateBE, type DocTotalsIn, type ExportCell, type GlMap, type PaymentTerm, type PeakDocIn,
} from '@erp/core';
import { writeAudit } from '../../lib/audit';
import { requirePerm, type Ctx, type Deps } from '../../lib/context';
import { E, isUuid } from '../../lib/errors';
import { decodeCursor, pageOf } from '../../lib/paging';
import { CONTENT_TYPE, fileBody, type Sheet } from './files';
import { Sources, checkRange } from './sources';
import { stockReport, stockSheet } from './stock';
import { purchaseDocs, vatReport, vatSheet, type PurchaseDocRow } from './vat';

// ---------- GL mapping ----------
const GL_COLS: Record<keyof GlMap, string> = {
  sale: 'sale', buy: 'buy', cogs: 'cogs', pdisc: 'pdisc', ar: 'ar', ap: 'ap', vatOut: 'vat_out', vatIn: 'vat_in', cash: 'cash', coupon: 'coupon', deposit: 'deposit',
};

export async function getGl(tx: Tx): Promise<GlMap> {
  const r = await tx.query<Record<string, string>>(`select * from report_gl_map`);
  const row = r.rows[0];
  if (!row) return { ...DEFAULT_GL };
  return Object.fromEntries((Object.keys(GL_COLS) as (keyof GlMap)[]).map((k) => [k, row[GL_COLS[k]] ?? DEFAULT_GL[k]])) as unknown as GlMap;
}

export async function updateGl(tx: Tx, ctx: Ctx, patch: Partial<ExportGl>): Promise<GlMap> {
  requirePerm(ctx, 'data.export');
  const before = await getGl(tx);
  const after: GlMap = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  const keys = Object.keys(GL_COLS) as (keyof GlMap)[];
  const changed = keys.filter((k) => before[k] !== after[k]);
  if (!changed.length) return before;
  await tx.query(
    `insert into report_gl_map (tenant_id, ${keys.map((k) => GL_COLS[k]).join(', ')}, updated_by, updated_at)
     values ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}, $${keys.length + 2}, now())
     on conflict (tenant_id) do update set ${keys.map((k) => `${GL_COLS[k]} = excluded.${GL_COLS[k]}`).join(', ')}, updated_by = excluded.updated_by, updated_at = now()`,
    [ctx.tenantId, ...keys.map((k) => after[k]), ctx.userId],
  );
  await writeAudit(tx, ctx, [{ action: 'update', object: 'gl-mapping', detail: changed.map((k) => `${GL_LABELS[k]}: ${before[k]} → ${after[k]}`).join(' · ') }]);
  return after;
}

// ---------- sources ----------
interface SaleDoc {
  id: string; no: string; type: string; date: string; status: 'active' | 'void'; vat_mode: 'inc' | 'exc' | 'none'; base7: string; exempt: string; vat: string; total: string;
  bill_disc: string; ref_no: string | null; ar_balance: string; payments: { method: string; amount: string }[]; code: string; name: string; tax_id: string | null; branch: string | null;
  term: PaymentTerm | null;
}

async function saleDocs(tx: Tx, from: string, to: string, opts: { withVoid: boolean; notIn?: ExportTemplate }): Promise<SaleDoc[]> {
  const r = await tx.query<SaleDoc>(
    `select d.id, d.no, d.type, d.date::text date, d.status, d.vat_mode, d.base7::text, d.exempt::text, d.vat::text, d.total::text, d.bill_disc::text,
            d.ref_no, d.ar_balance::text, d.payments, coalesce(c.code, 'C00000') code, coalesce(c.name, d.customer_name) name, c.tax_id, c.branch, c.term
       from docs d left join customers c on c.id = d.customer_id
      where d.type in ('ABB','INV','RC','CN') and d.date between $1::date and $2::date and ($3 or d.status = 'active')
        and ($4::text is null or not exists (
          select 1 from export_run_docs x join export_runs r on r.id = x.run_id where x.source = 'docs' and x.doc_id = d.id and r.template = $4))
      order by d.date, d.no`,
    [from, to, opts.withVoid, opts.notIn ?? null],
  );
  return r.rows;
}

interface SaleLine { doc_id: string; sku: string; name: string; qty: string; unit_price: string; discount: string; net_after_bill: string; vat: 'v7' | 'exempt' }
async function saleLines(tx: Tx, docIds: string[]): Promise<Map<string, SaleLine[]>> {
  const r = await tx.query<SaleLine>(
    `select l.doc_id, p.sku, l.name, l.qty::text, l.unit_price::text, l.discount::text, l.net_after_bill::text, l.vat
       from doc_lines l join products p on p.id = l.product_id where l.doc_id = any($1::uuid[]) order by l.doc_id, l.line_no`,
    [docIds],
  );
  const m = new Map<string, SaleLine[]>();
  for (const l of r.rows) m.set(l.doc_id, [...(m.get(l.doc_id) ?? []), l]);
  return m;
}

function peakSale(doc: SaleDoc, lines: SaleLine[]): PeakDocIn {
  const ex = lineExVat({ vatMode: doc.vat_mode, base7: doc.base7 }, lines.map((l) => ({ netAfterBill: l.net_after_bill, vat: l.vat })));
  const vats = lineVatShares(doc.vat, lines.map((l, i) => ({ exVat: ex[i]!, vat: doc.vat_mode === 'none' ? 'exempt' : l.vat })));
  return {
    date: doc.date, no: doc.no, ref: doc.ref_no, contactCode: doc.code, contactName: doc.name, taxId: doc.tax_id, branch: doc.branch,
    dueDate: doc.type === 'CN' ? null : d(doc.ar_balance).gt(0) ? dueDate(doc.date, doc.term) : doc.date, vatMode: doc.vat_mode, billDiscount: doc.bill_disc,
    note: doc.type === 'CN' ? `ใบลดหนี้ อ้างอิง ${doc.ref_no ?? ''}` : '',
    lines: lines.map((l, i) => ({ sku: l.sku, name: l.name, qty: l.qty, unitPrice: l.unit_price, discount: l.discount, vat: l.vat, exVat: ex[i]!, lineVat: vats[i]! })),
  };
}

const saleTotals = (x: SaleDoc): DocTotalsIn => ({ date: x.date, no: x.no, type: x.type, contactCode: x.code, contactName: x.name, taxId: x.tax_id, base7: x.base7, exempt: x.exempt, vat: x.vat, total: x.total, status: x.status });
const purchaseTotals = (x: PurchaseDocRow): DocTotalsIn => ({ date: x.date, no: x.vendorInvoiceNo, type: 'GR', contactCode: x.vendorCode, contactName: x.vendorName, taxId: x.taxId, base7: x.base7, exempt: x.exempt, vat: x.vat, total: x.total, status: x.status });

async function purchaseFiltered(tx: Tx, from: string, to: string, notIn?: ExportTemplate): Promise<PurchaseDocRow[]> {
  const rows = (await purchaseDocs(tx, new Sources(tx), from, to)).filter((x) => x.status === 'active');
  if (!notIn || !rows.length) return rows;
  const done = await tx.query<{ doc_id: string }>(
    `select x.doc_id from export_run_docs x join export_runs r on r.id = x.run_id where x.source = any($1::text[]) and x.doc_id = any($2::uuid[]) and r.template = $3`,
    [['stock_docs', 'plugin'], rows.map((x) => x.id), notIn],
  );
  const skip = new Set(done.rows.map((x) => x.doc_id));
  return rows.filter((x) => !skip.has(x.id));
}

/** GR lines (base unit, unit cost after the allocated bill discount); amounts rounded with the remainder on the last line. */
async function purchasePeak(tx: Tx, docs: PurchaseDocRow[]): Promise<PeakDocIn[]> {
  const ids = docs.filter((x) => x.source === 'stock_docs').map((x) => x.id);
  const r = ids.length ? await tx.query<{ doc_id: string; sku: string; name: string; qty: string; unit_cost: string }>(
    `select s.id doc_id, p.sku, p.name, (e->>'qty') qty, (e->>'unitCost') unit_cost
       from stock_docs s cross join lateral jsonb_array_elements(s.lines) with ordinality as x(e, i) join products p on p.id = (e->>'productId')::uuid
      where s.id = any($1::uuid[]) order by s.id, x.i`, [ids]) : { rows: [] };
  const byDoc = new Map<string, typeof r.rows>();
  for (const l of r.rows) byDoc.set(l.doc_id, [...(byDoc.get(l.doc_id) ?? []), l]);
  return docs.map((doc) => {
    const raw = byDoc.get(doc.id) ?? [];
    const exTotal = d(doc.base7).plus(d(doc.exempt));
    const amounts = raw.map((l) => d(money(d(l.qty).times(d(l.unit_cost)))));
    if (amounts.length) amounts[amounts.length - 1] = amounts[amounts.length - 1]!.plus(exTotal.minus(sum(amounts)));
    const vatOn = d(doc.vat).gt(0);
    const lines = raw.length
      ? raw.map((l, i) => ({ sku: l.sku, name: l.name, qty: l.qty, unitPrice: qty4(d(amounts[i]!).div(d(l.qty))), discount: '0', vat: (vatOn ? 'v7' : 'exempt') as 'v7' | 'exempt', exVat: money(amounts[i]!), lineVat: '0' }))
      : [{ sku: '', name: 'ซื้อสินค้า', qty: '1', unitPrice: money(exTotal), discount: '0', vat: (vatOn ? 'v7' : 'exempt') as 'v7' | 'exempt', exVat: money(exTotal), lineVat: '0' }];
    const vats = lineVatShares(doc.vat, lines.map((l) => ({ exVat: l.exVat, vat: l.vat })));
    lines.forEach((l, i) => { l.lineVat = vats[i]!; });
    if (d(doc.discount).gt(0)) lines.push({ sku: '', name: 'ส่วนลดรับจากผู้ขาย', qty: '1', unitPrice: money(d(doc.discount).neg()), discount: '0', vat: 'exempt', exVat: money(d(doc.discount).neg()), lineVat: '0.00' });
    return {
      date: doc.date, no: doc.vendorInvoiceNo, ref: doc.no, contactCode: doc.vendorCode, contactName: doc.vendorName, taxId: doc.taxId, branch: doc.branch,
      vatMode: vatOn ? 'exc' : 'none', billDiscount: '0', note: doc.source === 'stock_docs' ? `ใบรับสินค้า ${doc.no}` : '', lines,
    } satisfies PeakDocIn;
  });
}

// ---------- building a run ----------
interface Built { files: { name: string; rows: number; sheet: Sheet }[]; docs: { source: string; id: string; no: string }[]; warnings: string[] }

const fileBase = (tpl: string, ds: string, from?: string, to?: string) => `${tpl}-${ds}${from ? `-${from}_${to}` : ''}`;

function peakFiles(base: string, head: readonly (readonly string[])[], rows: ExportCell[][], extraWarn: string[] = []): Built['files'] {
  const parts = splitPeakFiles(rows);
  if (parts.length > 1) extraWarn.push(`PEAK รับไม่เกิน 1,000 แถวต่อไฟล์: แบ่งเป็น ${parts.length} ไฟล์`);
  return parts.map((p, i) => ({ name: parts.length > 1 ? `${base}-${i + 1}` : base, rows: p.length, sheet: [...head, ...p] }));
}

async function build(tx: Tx, deps: Deps, ctx: Ctx, req: ExportRunReq, gl: GlMap): Promise<Built> {
  const from = req.from ?? '';
  const to = req.to ?? '';
  const notIn = req.onlyNew ? req.template : undefined;
  const warnings: string[] = [];
  const base = fileBase(req.template, req.dataset, req.from, req.to);
  const docsOut: Built['docs'] = [];

  if (req.dataset === 'products') {
    requirePerm(ctx, 'data.cost'); // buy price and lot cost
    const p = await tx.query<{ id: string; sku: string; name: string; units: { name: string }[]; price: string; cost: string; vat: 'v7' | 'exempt'; kind: string; barcode: string | null }>(
      `select id, sku, name, units, price::text, cost::text, vat, kind, barcode from products where active order by sku`);
    const lots = await tx.query<{ product_id: string; date: string; qty: string; unit_cost: string }>(
      `select product_id, to_char(received_at at time zone 'Asia/Bangkok', 'YYYY-MM-DD') date, sum(remaining)::text qty, unit_cost::text
         from stock_lots where remaining > 0 group by product_id, 2, unit_cost order by product_id, 2, unit_cost`);
    const byP = new Map<string, { date: string; qty: string; unitCost: string }[]>();
    for (const l of lots.rows) byP.set(l.product_id, [...(byP.get(l.product_id) ?? []), { date: l.date, qty: l.qty, unitCost: l.unit_cost }]);
    const rows = peakProductRows(p.rows.map((x) => ({
      sku: x.sku, name: x.name, unit: x.units[0]?.name ?? '', buyPrice: x.cost, buyVat: 'v7', salePrice: x.price, saleVat: x.vat, isStock: x.kind === 'stock', barcode: x.barcode, lots: byP.get(x.id) ?? [],
    })), gl);
    return { files: peakFiles(base, PEAK_PRODUCT_HEAD, rows, warnings), docs: [], warnings };
  }
  if (req.dataset === 'contacts') {
    const c = await tx.query<{ code: string; name: string; tax_id: string | null; branch: string | null; phone: string | null; term: PaymentTerm; credit_limit: string; grp: string }>(
      `select code, name, tax_id, branch, phone, term, credit_limit::text, grp from customers order by code`);
    const v = await tx.query<{ code: string; name: string; tax_id: string | null; branch: string | null; phone: string | null; term: PaymentTerm }>(
      `select code, name, tax_id, branch, phone, term from vendors order by code`);
    const GRP: Record<string, string> = { retail: 'ลูกค้าปลีก', whole: 'ลูกค้าส่ง', contr: 'ผู้รับเหมา' };
    const rows = peakContactRows([
      ...c.rows.filter((x) => x.code !== 'C00000').map((x) => ({ code: x.code, role: 'customer' as const, name: x.name, taxId: x.tax_id, branch: x.branch, phone: x.phone, term: x.term, creditLimit: x.credit_limit, group: GRP[x.grp] ?? x.grp })),
      ...v.rows.map((x) => ({ code: x.code, role: 'vendor' as const, name: x.name, taxId: x.tax_id, branch: x.branch, phone: x.phone, term: x.term, group: 'ผู้จำหน่าย' })),
    ], gl);
    return { files: peakFiles(base, PEAK_CONTACT_HEAD, rows, warnings), docs: [], warnings };
  }
  if (!req.from || !req.to) throw E.validation('Pick a date range');
  checkRange(from, to);

  if (req.dataset === 'stock') {
    const r = await stockReport(tx, deps, ctx, { asOf: to, only: 'all', slowDays: 90, format: 'json', limit: 100 }, true);
    return { files: [{ name: base, rows: r.rows.length, sheet: stockSheet(r) }], docs: [], warnings };
  }
  if (req.dataset === 'vatSales' || req.dataset === 'vatPurchase') {
    if (from.slice(0, 7) !== to.slice(0, 7)) throw E.validation('A VAT report covers one month');
    const r = await vatReport(tx, { month: from.slice(0, 7), kind: req.dataset === 'vatSales' ? 'sales' : 'purchase', format: 'json', limit: 100 }, true);
    return { files: [{ name: base, rows: r.rows.length, sheet: vatSheet(r) }], docs: [], warnings };
  }
  if (req.dataset === 'receipts') {
    const r = await tx.query<{ date: string; no: string; type: string; name: string; method: string; amount: string }>(
      `select d.date::text, d.no, d.type, d.customer_name name, p->>'method' method, (p->>'amount') amount
         from docs d cross join lateral jsonb_array_elements(d.payments) p
        where d.status = 'active' and d.type in ('ABB','INV','RC','CN') and d.date between $1::date and $2::date order by d.date, d.no`, [from, to]);
    const METHOD: Record<string, string> = { cash: 'เงินสด', transfer: 'โอน', promptpay: 'พร้อมเพย์', card: 'บัตร' };
    const rows = r.rows.map((x) => [thaiDateBE(x.date), x.no, x.name, METHOD[x.method] ?? x.method, money(d(x.amount).times(x.type === 'CN' ? -1 : 1))]);
    warnings.push('รับชำระหนี้จากใบวางบิล (M10) จะเพิ่มในไฟล์นี้เมื่อโมดูลลูกหนี้พร้อม');
    return { files: [{ name: base, rows: rows.length, sheet: [['วันที่', 'เลขที่', 'ลูกค้า', 'วิธีชำระ', 'จำนวนเงิน'], ...rows, ['', '', '', 'รวม', money(sum(rows.map((x) => x[4]!)))]] }], docs: [], warnings };
  }

  // Document datasets: sales or purchase.
  if (req.dataset === 'sales') {
    const docs = await saleDocs(tx, from, to, { withVoid: req.template === 'generic', notIn });
    for (const x of docs) docsOut.push({ source: 'docs', id: x.id, no: x.no });
    const live = docs.filter((x) => x.status === 'active');
    if (req.template === 'peak') {
      const lines = await saleLines(tx, live.map((x) => x.id));
      const sales = live.filter((x) => x.type !== 'CN').map((x) => peakSale(x, lines.get(x.id) ?? []));
      const cns = live.filter((x) => x.type === 'CN').map((x) => peakSale(x, lines.get(x.id) ?? []));
      const files = peakFiles(base, PEAK_DOC_HEAD, peakDocRows(sales, gl.sale), warnings);
      if (cns.length) files.push(...peakFiles(fileBase(req.template, 'creditnotes', req.from, req.to), PEAK_DOC_HEAD, peakDocRows(cns, gl.sale), warnings));
      if (missingGl(gl, ['sale']).length) warnings.push('ยังไม่ได้ตั้งบัญชีรายได้ขาย');
      return { files, docs: docsOut, warnings };
    }
    if (req.template === 'journal') {
      const miss = missingGl(gl, ['sale', 'vatOut', 'cash', 'ar']);
      if (miss.length) throw E.validation(`GL mapping missing: ${miss.map((k) => GL_LABELS[k]).join(', ')}`, { missing: miss });
      const jl = journalLines(live.map((x) => ({ date: x.date, no: x.no, side: 'sale' as const, type: x.type, paid: !d(x.ar_balance).gt(0), base7: x.base7, exempt: x.exempt, vat: x.vat, total: x.total })), gl);
      return { files: [{ name: base, rows: jl.length, sheet: [[...JOURNAL_HEAD], ...journalRows(jl)] }], docs: docsOut, warnings };
    }
    return { files: [docTotalsFile(req.template, base, (req.template === 'generic' ? docs : live).map(saleTotals))], docs: docsOut, warnings };
  }

  // purchase
  const docs = await purchaseFiltered(tx, from, to, notIn);
  for (const x of docs) docsOut.push({ source: x.source, id: x.id, no: x.no });
  if (docs.some((x) => x.source === 'stock_docs')) warnings.push('สมุดซื้อมาจากใบรับสินค้าที่บันทึกเอง: ราคาทุนไม่รวม VAT คิดภาษีซื้อ 7% ต่อใบเมื่อผู้ขายมีเลขผู้เสียภาษี');
  if (req.template === 'peak') return { files: peakFiles(base, PEAK_DOC_HEAD, peakDocRows(await purchasePeak(tx, docs), gl.buy), warnings), docs: docsOut, warnings };
  if (req.template === 'journal') {
    const miss = missingGl(gl, ['buy', 'vatIn', 'ap', 'pdisc']);
    if (miss.length) throw E.validation(`GL mapping missing: ${miss.map((k) => GL_LABELS[k]).join(', ')}`, { missing: miss });
    const jl = journalLines(docs.map((x) => ({ date: x.date, no: x.vendorInvoiceNo, side: 'purchase' as const, type: 'GR', paid: false, base7: x.base7, exempt: x.exempt, vat: x.vat, total: x.total, discount: x.discount })), gl);
    return { files: [{ name: base, rows: jl.length, sheet: [[...JOURNAL_HEAD], ...journalRows(jl)] }], docs: docsOut, warnings };
  }
  return { files: [docTotalsFile(req.template, base, docs.map(purchaseTotals))], docs: docsOut, warnings };
}

function docTotalsFile(tpl: ExportTemplate, name: string, rows: DocTotalsIn[]): Built['files'][number] {
  if (tpl === 'express') return { name, rows: rows.length, sheet: [[...EXPRESS_HEAD], ...expressRows(rows)] };
  if (tpl === 'flowaccount') return { name, rows: rows.length, sheet: [[...FLOWACCOUNT_HEAD], ...flowAccountRows(rows)] };
  const body = genericBookRows(rows);
  const tot = (i: number) => money(sum(body.map((r) => r[i] as string)));
  return { name, rows: rows.length, sheet: [[...GENERIC_BOOK_HEAD], ...body, ['', '', '', '', 'รวม', '', tot(6), tot(7), tot(8), tot(9), '']] };
}

// ---------- runs ----------
interface RunRow {
  id: string; template: ExportTemplate; dataset: ExportDataset; format: 'csv' | 'xlsx'; date_from: string | null; date_to: string | null; only_new: boolean;
  rows: number; docs: number; warnings: string[]; created_by: string; created_at: Date;
}
const RUN_SELECT = `select r.id, r.template, r.dataset, r.format, r.date_from::text, r.date_to::text, r.only_new, r.rows, r.docs, r.warnings, u.name created_by, r.created_at
  from export_runs r join users u on u.id = r.created_by`;

async function toRuns(tx: Tx, rows: RunRow[]): Promise<ExportRun[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const files = await tx.query<{ run_id: string; seq: number; name: string; rows: number }>(`select run_id, seq, name, rows from export_files where run_id = any($1::uuid[]) order by run_id, seq`, [ids]);
  const changed = await tx.query<{ run_id: string; no: string; at: Date }>(
    `select x.run_id, d.no, d.void_at at from export_run_docs x join export_runs r on r.id = x.run_id join docs d on d.id = x.doc_id
      where x.run_id = any($1::uuid[]) and x.source = 'docs' and d.status = 'void' and d.void_at > r.created_at order by d.void_at`, [ids]);
  return rows.map((r) => ({
    id: r.id, template: r.template, dataset: r.dataset, format: r.format, from: r.date_from, to: r.date_to, onlyNew: r.only_new, rows: r.rows, docs: r.docs,
    files: files.rows.filter((f) => f.run_id === r.id).map((f) => ({ seq: f.seq, name: f.name, rows: f.rows })),
    warnings: r.warnings, changedAfter: changed.rows.filter((c) => c.run_id === r.id).map((c) => ({ no: c.no, at: c.at.toISOString() })),
    createdBy: r.created_by, createdAt: r.created_at.toISOString(),
  }));
}

export async function createRun(tx: Tx, deps: Deps, ctx: Ctx, req: ExportRunReq): Promise<ExportRun> {
  requirePerm(ctx, 'data.export');
  if (!EXPORT_COMBOS[req.template].includes(req.dataset)) throw E.validation(`Template ${req.template} cannot export ${req.dataset}`);
  if (req.from && req.to && req.to < req.from) throw E.validation('to must not be before from');
  const gl = await getGl(tx);
  const b = await build(tx, deps, ctx, req, gl);
  // Documents of this period that went out earlier and were voided since then: fix them in the accounting program.
  if (req.from && req.to && (req.dataset === 'sales')) {
    const v = await tx.query<{ no: string }>(
      `select distinct d.no from docs d join export_run_docs x on x.doc_id = d.id and x.source = 'docs' join export_runs r on r.id = x.run_id
        where d.status = 'void' and d.void_at > r.created_at and d.date between $1::date and $2::date order by d.no`, [req.from, req.to]);
    if (v.rows.length) b.warnings.push(`เอกสารที่ส่งออกไปแล้วถูกยกเลิกภายหลัง ให้แก้ในโปรแกรมบัญชี: ${v.rows.map((x) => x.no).join(', ')}`);
  }
  const rows = b.files.reduce((a, f) => a + f.rows, 0);
  const run = await tx.query<{ id: string }>(
    `insert into export_runs (tenant_id, template, dataset, format, date_from, date_to, only_new, rows, docs, files, warnings, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [ctx.tenantId, req.template, req.dataset, req.format, req.from ?? null, req.to ?? null, req.onlyNew, rows, b.docs.length, b.files.length, JSON.stringify(b.warnings), ctx.userId],
  );
  const runId = run.rows[0]!.id;
  for (const [i, f] of b.files.entries()) {
    await tx.query(
      `insert into export_files (tenant_id, run_id, seq, name, content_type, rows, content) values ($1,$2,$3,$4,$5,$6,$7)`,
      [ctx.tenantId, runId, i + 1, `${f.name}.${req.format}`, CONTENT_TYPE[req.format], f.rows, fileBody(req.format, f.sheet, f.name.slice(0, 31))],
    );
  }
  if (b.docs.length) {
    await tx.query(
      `insert into export_run_docs (tenant_id, run_id, source, doc_id, doc_no) select $1, $2, s, i::uuid, n from unnest($3::text[], $4::text[], $5::text[]) as t(s, i, n)`,
      [ctx.tenantId, runId, b.docs.map((x) => x.source), b.docs.map((x) => x.id), b.docs.map((x) => x.no)],
    );
  }
  await writeAudit(tx, ctx, [{
    action: 'export', object: `export-${req.template}`, ref: runId,
    detail: `${req.dataset} · ${req.from ? `${req.from} – ${req.to}` : 'ข้อมูลหลัก'}${req.onlyNew ? ' · เฉพาะที่ยังไม่ส่งออก' : ''} · ${rows} แถว ${b.files.length} ไฟล์ (${req.format})`,
  }]);
  return (await getRun(tx, ctx, runId));
}

export async function listRuns(tx: Tx, ctx: Ctx, q: { limit: number; cursor?: string }) {
  requirePerm(ctx, 'data.export', { readOnly: true });
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  let where = '';
  if (cur) {
    params.push(cur[0], cur[1]);
    where = `where (r.created_at, r.id) < ($1::timestamptz, $2::uuid)`;
  }
  params.push(q.limit + 1);
  const r = await tx.query<RunRow>(`${RUN_SELECT} ${where} order by r.created_at desc, r.id desc limit $${params.length}`, params);
  const pg = pageOf(r.rows, q.limit, (x) => [x.created_at.toISOString(), x.id], (x) => x);
  return { items: await toRuns(tx, pg.items), nextCursor: pg.nextCursor };
}

export async function getRun(tx: Tx, ctx: Ctx, id: string): Promise<ExportRun> {
  requirePerm(ctx, 'data.export', { readOnly: true });
  if (!isUuid(id)) throw E.notFound('Export run not found');
  const r = await tx.query<RunRow>(`${RUN_SELECT} where r.id = $1`, [id]);
  if (!r.rows[0]) throw E.notFound('Export run not found');
  return (await toRuns(tx, r.rows))[0]!;
}

export async function getFile(tx: Tx, ctx: Ctx, id: string, seq: number): Promise<{ name: string; contentType: string; content: Buffer }> {
  requirePerm(ctx, 'data.export', { readOnly: true });
  if (!isUuid(id) || !Number.isInteger(seq)) throw E.notFound('File not found');
  const r = await tx.query<{ name: string; content_type: string; content: Buffer }>(`select name, content_type, content from export_files where run_id = $1 and seq = $2`, [id, seq]);
  if (!r.rows[0]) throw E.notFound('File not found');
  return { name: r.rows[0].name, contentType: r.rows[0].content_type, content: r.rows[0].content };
}

