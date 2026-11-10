/** POS sale, sales documents, void (M07, M08). */
import { searchTokens } from '@erp/core';
import type { Tx } from '@erp/db';
import type { DocSummary, PageQuery, PosApproval, PosApprovalReq, PosPreview, PosPreviewReq, PosSaleReq, SalesDoc } from '@erp/contracts';
import {
  approverCovers, approverRoles, calcDoc, checkBelowCost, d, discReasonText, dueDate, fmtTHB, lineDiscount, margin, money, needsOverride, netUnitPricesExVat, perm,
  priceExVat, qty4, round4, scopeCovers, sum, takeLots, type DocLine as CoreLine, type PaymentTerm, type PriceChange,
} from '@erp/core';
import { posIdOf, requireAbbDevice } from '../modules/retail/devices';
import { retailPosPricing } from '../modules/retail/pricing';
import { verifyApproval } from '../lib/approval';
import { writeAudit, type AuditInput } from '../lib/audit';
import { can, requirePerm, type Ctx, type Deps } from '../lib/context';
import { nextDocNo } from '../lib/docno';
import { E, isUuid } from '../lib/errors';
import { decodeCursor, likeEscape, pageOf } from '../lib/paging';
import { applyOut, lockLots, planTakes, reverseOuts } from '../lib/stock';
import { loadProducts, requireWarehouse, unitOf, type ProductRow, type ProductUnitRow } from './master';
// Read-only reuse of module A (M10): customer row and outstanding AR / overdue for the POS credit check.
import { creditInfo, loadCustomer } from '../modules/sales/common';

export const SALE_TYPES = ['ABB', 'INV', 'RC'] as const;

interface DocRow {
  id: string; no: string; type: SalesDoc['type']; date: string; customer_id: string | null; customer_name: string; customer_phone: string | null;
  vat_mode: SalesDoc['vatMode']; warehouse_id: string | null; shift_id: string | null; gross: string; line_disc: string; bill_disc: string; base7: string;
  exempt: string; vat: string; total: string; ar_balance: string; payments: SalesDoc['payments']; status: SalesDoc['status']; void_by_name: string | null;
  void_at: Date | null; void_reason: string | null; created_by_name: string; ref_no: string | null; ref_doc_id: string | null; created_at: Date; device_id: string | null;
  note: string; disc_reason: string | null;
}
interface LineRow {
  id: string; product_id: string; name: string; unit_name: string; unit_factor: string; qty: string; base_qty: string; unit_price: string;
  discount: string; net: string; net_after_bill: string; vat: 'v7' | 'exempt'; returned_qty: string; cogs: string | null; src_line_id: string | null;
  retail_promo_id: string | null; retail_promo_name: string | null; retail_list_price: string | null; retail_price_source: 'customer' | 'group' | 'promo' | 'bundle' | null;
  retail_bundle_no: number | null; retail_bundle_sets: string | null; retail_bundle_qty: string | null; retail_bundle_price: string | null;
}

const DOC_SELECT = `select d.id, d.no, d.type, d.date, d.customer_id, d.customer_name, d.customer_phone, d.vat_mode, d.warehouse_id, d.shift_id,
  d.gross::text, d.line_disc::text, d.bill_disc::text, d.base7::text, d.exempt::text, d.vat::text, d.total::text, d.ar_balance::text, d.payments,
  d.status, vu.name as void_by_name, d.void_at, d.void_reason, cu.name as created_by_name, d.ref_no, d.ref_doc_id, d.created_at, d.device_id,
  d.note, d.disc_reason
  from docs d join users cu on cu.id = d.created_by left join users vu on vu.id = d.void_by`;

export async function getDocRow(tx: Tx, no: string, opts: { forUpdate?: boolean } = {}): Promise<DocRow> {
  if (opts.forUpdate) await tx.query(`select id from docs where no = $1 for update`, [no]);
  const r = await tx.query<DocRow>(`${DOC_SELECT} where d.no = $1`, [no]);
  if (!r.rows[0]) throw E.notFound(`Document ${no} not found`);
  return r.rows[0];
}

export async function getLines(tx: Tx, docId: string): Promise<LineRow[]> {
  const r = await tx.query<LineRow>(
    `select id, product_id, name, unit_name, unit_factor::text, qty::text, base_qty::text, unit_price::text, discount::text, net::text,
            net_after_bill::text, vat, returned_qty::text, cogs::text, src_line_id,
            retail_promo_id, retail_promo_name, retail_list_price::text, retail_price_source, retail_bundle_no, retail_bundle_sets::text, retail_bundle_qty::text,
            retail_bundle_price::text
       from doc_lines where doc_id = $1 order by line_no`,
    [docId],
  );
  return r.rows;
}

export async function getDoc(tx: Tx, ctx: Ctx, no: string): Promise<SalesDoc> {
  const row = await getDocRow(tx, no);
  const lines = await getLines(tx, row.id);
  const seeCost = can(ctx, 'data.cost') === 1;
  return {
    id: row.id, no: row.no, type: row.type, date: row.date,
    customer: { id: row.customer_id, name: row.customer_name, phone: row.customer_phone },
    vatMode: row.vat_mode,
    lines: lines.map((l) => ({
      id: l.id, productId: l.product_id, name: l.name, unitName: l.unit_name, qty: qty4(l.qty), unitPrice: qty4(l.unit_price), discount: money(l.discount),
      net: money(l.net), returnedQty: qty4(l.returned_qty), cogs: seeCost && l.cogs != null ? money(l.cogs) : null,
      ...(l.retail_price_source ? {
        listPrice: l.retail_list_price != null ? qty4(l.retail_list_price) : null, priceSource: l.retail_price_source,
        promo: l.retail_promo_id ? { id: l.retail_promo_id, name: l.retail_promo_name ?? '' } : null,
        bundle: l.retail_bundle_no != null && l.retail_promo_id ? {
          no: l.retail_bundle_no, promoId: l.retail_promo_id, name: l.retail_promo_name ?? '', sets: qty4(l.retail_bundle_sets ?? 0),
          qtyPerSet: qty4(l.retail_bundle_qty ?? 0), setPrice: money(l.retail_bundle_price ?? 0),
        } : null,
      } : {}),
    })),
    totals: { gross: row.gross, lineDisc: row.line_disc, billDisc: row.bill_disc, base7: row.base7, exempt: row.exempt, vat: row.vat, total: row.total },
    payments: row.payments, status: row.status,
    voided: row.status === 'void' ? { by: row.void_by_name ?? '', at: row.void_at!.toISOString(), reason: row.void_reason ?? '' } : null,
    createdBy: row.created_by_name, ref: row.ref_no,
    // whether the referenced bill has a B2B invoice page (else the client opens it as a POS document, no 404 probe)
    ...(row.ref_doc_id ? { refB2b: !!(await tx.query(`select 1 from sales_invoices where doc_id = $1`, [row.ref_doc_id])).rowCount } : {}),
    ...(row.type === 'ABB' ? { posId: await posIdOf(tx, row.device_id) } : {}),
    related: await relatedDocs(tx, row.id),
    note: row.note, discReason: row.disc_reason, arBalance: row.status === 'void' ? '0.00' : money(row.ar_balance),
  };
}

/** Documents made from this one: CN / full tax invoice (docs.ref_doc_id), billing notes, receipts and delivery orders of a tax invoice. */
async function relatedDocs(tx: Tx, docId: string): Promise<NonNullable<SalesDoc['related']>> {
  const r = await tx.query<{ no: string; kind: 'CN' | 'INV' | 'BN' | 'RE' | 'DO'; status: 'active' | 'void' }>(
    `select no, type kind, status from docs where ref_doc_id = $1 and type in ('CN','INV')
     union all select bn.no, 'BN', bn.status from ar_billing_note_lines l join ar_billing_notes bn on bn.id = l.bn_id where l.invoice_doc_id = $1
     union all select r.no, 'RE', r.status from ar_receipt_lines l join ar_receipts r on r.id = l.receipt_id where l.invoice_doc_id = $1
     union all select dl.no, 'DO', dl.status from sales_deliveries dl where dl.inv_doc_id = $1
     union all select dl.no, 'DO', dl.status from sales_invoice_deliveries x join sales_deliveries dl on dl.id = x.delivery_id where x.invoice_doc_id = $1
     order by 1`, [docId]);
  const seen = new Set<string>();
  return r.rows.filter((x) => (seen.has(x.no) ? false : (seen.add(x.no), true)));
}

/** Lower-cased haystack for the returns bill picker (REQ-M08-06): bill no, customer, member, products, amount. */
export function searchText(parts: { no: string; customer?: { name: string; code?: string | null; phone?: string | null; taxId?: string | null } | null; memberId?: string | null; products: { name: string; sku: string }[]; total: string }): string {
  const t = d(parts.total);
  return [
    parts.no, parts.customer?.name, parts.customer?.code, parts.customer?.phone, parts.customer?.phone?.replace(/\D/g, ''), parts.customer?.taxId, parts.memberId,
    ...parts.products.flatMap((p) => [p.name, p.sku]),
    money(t), fmtTHB(t), t.toDecimalPlaces(0).toFixed(0),
  ].filter(Boolean).join(' ').toLowerCase();
}

/**
 * BR-20: the caller's own open shift, locked FOR SHARE until COMMIT. Closing a shift takes FOR UPDATE, so a
 * sale / cash refund and a close serialize: either the close waits and then counts this document, or the
 * document sees the shift already closed.
 */
export async function requireOwnOpenShift(tx: Tx, ctx: Ctx, shiftId?: string): Promise<{ id: string; no: string; device_id: string }> {
  if (shiftId !== undefined && !isUuid(shiftId)) throw E.shiftRequired();
  const r = await tx.query<{ id: string; no: string; device_id: string; user_id: string; closed_at: Date | null }>(
    shiftId
      ? `select id, no, device_id, user_id, closed_at from shifts where id = $1 for share`
      : `select id, no, device_id, user_id, closed_at from shifts where user_id = $1 and closed_at is null for share`,
    [shiftId ?? ctx.userId],
  );
  const s = r.rows[0];
  if (!s || s.closed_at || s.user_id !== ctx.userId) throw E.shiftRequired();
  return s;
}

export interface SaleResult { doc: SalesDoc; replay: boolean }

/** One doc line of a POS sale being built: a cart line, or one component of a bundle (module C, M15). */
interface PosLine {
  p: ProductRow; u: ProductUnitRow; qty: string; unitPrice: string; core: CoreLine & { baseQty: string };
  retail: { listPrice: string; source: 'customer' | 'group' | 'promo' | 'bundle'; promo: { id: string; name: string; belowCost: boolean } | null } | null;
  bundle: { no: number; sets: string; qtyPerSet: string; setPrice: string; amount: string } | null;
}
type PosCustomer = { id: string; name: string; code: string; phone: string | null; tax_id: string | null };
interface BuiltBill {
  customer: PosCustomer | null; lines: PosLine[]; reqLines: number; retail: Awaited<ReturnType<typeof retailPosPricing>>;
  totals: ReturnType<typeof calcDoc>; vatMode: 'inc' | 'none'; priceChanges: PriceChange[];
}

async function shopVatMode(tx: Tx, ctx: Ctx): Promise<{ vatRegistered: boolean; vatMode: 'inc' | 'none' }> {
  const shop = (await tx.query<{ vat_registered: boolean }>(`select vat_registered from tenants where id = $1`, [ctx.tenantId])).rows[0]!;
  return { vatRegistered: shop.vat_registered, vatMode: shop.vat_registered ? 'inc' : 'none' };
}

/** Customer, priced lines (promo / price list / bundles), totals and the manual price changes of a POS cart. */
async function buildBill(tx: Tx, deps: Deps, req: PosPreviewReq, vatMode: 'inc' | 'none'): Promise<BuiltBill> {
  let customer: PosCustomer | null = null;
  if (req.customerId) {
    if (!isUuid(req.customerId)) throw E.validation('Unknown customer');
    customer = (await tx.query<PosCustomer>(`select id, name, code, phone, tax_id from customers where id = $1`, [req.customerId])).rows[0] ?? null;
    if (!customer) throw E.validation('Unknown customer');
  }
  const reqBundles = req.bundles ?? [];
  if (!req.lines.length && !reqBundles.length) throw E.validation('A bill needs at least one line');
  const products = await loadProducts(tx, req.lines.map((l) => l.productId));
  for (const [i, l] of req.lines.entries()) if (!d(l.qty).gt(0)) throw E.validation(`Line ${i + 1}: qty must be > 0`, { field: `lines.${i}.qty` });
  // Module C (M15 / BR-05): promo and price-list prices, bundle expansion. Without promos / lists every line
  // expects its retail price, exactly as before.
  const retail = await retailPosPricing(tx, deps, { customerId: customer?.id ?? null, lines: req.lines, bundles: reqBundles }, products, vatMode);
  const priceChanges: PriceChange[] = [];
  const lines: PosLine[] = req.lines.map((l, i) => {
    const p = products.get(l.productId)!;
    if (!p.active) throw E.validation(`Product ${p.sku} is inactive`);
    const u = unitOf(p, l.unitIdx);
    if (d(l.unitPrice).lt(0)) throw E.validation(`Line ${i + 1}: unit price must not be negative`, { field: `lines.${i}.unitPrice` });
    if (l.discount && (d(l.discount.value).lt(0) || (l.discount.kind === 'pct' && d(l.discount.value).gt(100)))) {
      throw E.validation(`Line ${i + 1}: discount must be 0..100% or a non-negative amount`, { field: `lines.${i}.discount` });
    }
    const rp = retail.lines[i]!;
    const atExpected = d(l.unitPrice).eq(rp.expected);
    // The expected (promo / list) price and the retail list price both sell without a price-change approval.
    if (!atExpected && !d(l.unitPrice).eq(rp.retail)) priceChanges.push({ productId: p.id, unitIdx: l.unitIdx, price: qty4(l.unitPrice) });
    const core: CoreLine & { baseQty: string } = { qty: l.qty, unitPrice: l.unitPrice, discount: l.discount ?? null, vat: p.vat, baseQty: qty4(d(l.qty).times(d(u.factor))) };
    return {
      p, u, qty: l.qty, unitPrice: l.unitPrice, core,
      retail: atExpected && rp.source !== 'retail' ? { listPrice: rp.retail, source: rp.source, promo: rp.promo } : null, bundle: null,
    };
  });
  // BR-17: one line per bundle component, net = its pro-rata share of the set revenue (qty 1 × amount keeps it exact).
  for (const b of retail.bundles) {
    for (const c of b.comps) {
      lines.push({
        p: c.p, u: c.p.units[0]!, qty: c.baseQty, unitPrice: d(c.baseQty).gt(0) ? qty4(d(c.amount).div(d(c.baseQty))) : '0',
        core: { qty: 1, unitPrice: c.amount, discount: null, vat: c.p.vat, baseQty: c.baseQty },
        retail: { listPrice: money(c.p.price), source: 'bundle', promo: { ...b.promo } },
        bundle: { no: b.no, sets: b.sets, qtyPerSet: c.qtyPerSet, setPrice: b.setPrice, amount: c.amount },
      });
    }
  }
  if (d(req.billDiscount).lt(0)) throw E.validation('Bill discount must not be negative', { field: 'billDiscount' });
  const totals = calcDoc(lines.map((l) => l.core), vatMode, req.billDiscount);
  return { customer, lines, reqLines: req.lines.length, retail, totals, vatMode, priceChanges };
}

/** What a line consumes from FIFO lots: base qty taken and its cost. */
type Consumed = { qty: string; cogs: string } | null;
interface BelowRow { productId: string; name: string; sell: string; cost: string }

/**
 * BR-16: net unit price ex VAT per base unit vs the FIFO cost of the lots each line consumes.
 * M15: bundle components are checked per bundle (set revenue vs Σ component FIFO cost), not per line; a promo the
 * owner confirmed below cost at creation (REQ-M15-03) is checked against its promo price instead of the cost.
 */
function evalBelowCost(bill: BuiltBill, consumed: Map<PosLine, Consumed>) {
  const { lines, vatMode, totals } = bill;
  const sell = netUnitPricesExVat(lines.map((l) => l.core), vatMode, totals.billDisc);
  const unitCosts = lines.map((l) => {
    const c = consumed.get(l);
    return c && d(c.qty).gt(0) ? qty4(d(c.cogs).div(d(c.qty))) : null;
  });
  const floorOf = (l: PosLine, cost: string | null): string | null => {
    if (cost == null || !l.retail?.promo?.belowCost || l.bundle) return cost;
    const promoExVat = priceExVat(d(l.unitPrice).div(d(l.u.factor)), vatMode, l.p.vat);
    return d(promoExVat).lt(d(cost)) ? promoExVat : cost;
  };
  const items = lines.map((l, i) => ({ netUnitExVat: sell[i] ?? '0', unitCost: l.bundle ? null : floorOf(l, unitCosts[i] ?? null) }));
  const lineIdx = new Set(checkBelowCost(items));
  const rows: BelowRow[] = [...lineIdx].map((i) => ({ productId: lines[i]!.p.id, name: lines[i]!.p.name, sell: sell[i]!, cost: items[i]!.unitCost! }));
  const bundleNos = new Set<number>();
  for (const b of bill.retail.bundles) {
    const idx = lines.flatMap((l, i) => (l.bundle?.no === b.no ? [i] : []));
    const sellSet = sum(idx.map((i) => d(sell[i] ?? '0').times(d(lines[i]!.core.baseQty)))).div(d(b.sets));
    const costSet = sum(idx.map((i) => consumed.get(lines[i]!)?.cogs ?? '0')).div(d(b.sets));
    const floor = b.promo.belowCost ? sum(idx.map((i) => priceExVat(lines[i]!.bundle!.amount, vatMode, lines[i]!.p.vat))).div(d(b.sets)) : null;
    const eff = floor && floor.lt(costSet) ? floor : costSet;
    if (checkBelowCost([{ netUnitExVat: sellSet, unitCost: eff }]).length) {
      bundleNos.add(b.no);
      rows.push({ productId: b.promo.id, name: `ชุดโปร ${b.promo.name}`, sell: qty4(sellSet), cost: qty4(eff) });
    }
  }
  return { sell, rows, lineIdx, bundleNos };
}

const LOT_PEEK = `select id::text as id, product_id as "productId", warehouse_id as "warehouseId",
  to_char(received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as "receivedAt", remaining::text as qty, unit_cost::text as "unitCost"
  from stock_lots where warehouse_id = $1 and product_id = any($2::uuid[]) and remaining > 0 order by product_id, received_at, id`;

/** FIFO estimate without locking (preview): each stock line takes what is left after the lines before it; a shortage takes what there is. */
async function peekConsumed(tx: Tx, warehouseId: string, lines: PosLine[]): Promise<Map<PosLine, Consumed>> {
  const stock = lines.filter((l) => l.p.kind === 'stock');
  const out = new Map<PosLine, Consumed>();
  if (!stock.length) return out;
  const r = await tx.query<{ id: string; productId: string; receivedAt: string; qty: string; unitCost: string }>(LOT_PEEK, [warehouseId, [...new Set(stock.map((l) => l.p.id))]]);
  const work = new Map<string, { id: string; receivedAt: string; qty: string; unitCost: string }[]>();
  for (const x of r.rows) work.set(x.productId, [...(work.get(x.productId) ?? []), { ...x }]);
  for (const l of stock) {
    const ls = work.get(l.p.id) ?? [];
    const have = sum(ls.map((x) => x.qty));
    const take = d(l.core.baseQty).gt(have) ? have : d(l.core.baseQty);
    if (!take.gt(0)) { out.set(l, null); continue; }
    const { takes, cogs } = takeLots(ls, take);
    for (const t of takes) {
      const lot = ls.find((x) => x.id === t.lotId)!;
      lot.qty = qty4(d(lot.qty).minus(d(t.qty)));
    }
    out.set(l, { qty: qty4(take), cogs });
  }
  return out;
}

/**
 * POST /api/sales/pos/preview (M07): while the cashier builds the cart, the below-cost flag per line / bundle for
 * everyone, and for data.cost users the FIFO cost, revenue ex VAT, margin and the bill profit. Nothing is locked or written.
 */
export async function posPreview(tx: Tx, deps: Deps, ctx: Ctx, req: PosPreviewReq): Promise<PosPreview> {
  requirePerm(ctx, 'pos.sell');
  const wh = await requireWarehouse(tx, req.warehouseId, { pos: true });
  const { vatMode } = await shopVatMode(tx, ctx);
  const bill = await buildBill(tx, deps, req, vatMode);
  const consumed = await peekConsumed(tx, wh.id, bill.lines);
  const below = evalBelowCost(bill, consumed);
  const showCost = can(ctx, 'data.cost') === 1;
  const lines = bill.lines;
  /** Revenue ex VAT after line and bill discounts, and FIFO cost (null = stock line with no lots left). */
  const revOf = (i: number) => money(d(below.sell[i] ?? '0').times(d(lines[i]!.core.baseQty)));
  const costOf = (l: PosLine): string | null => (l.p.kind === 'stock' ? (consumed.get(l) ? money(d(consumed.get(l)!.cogs).div(d(consumed.get(l)!.qty)).times(d(l.core.baseQty))) : null) : '0.00');
  const row = (rev: string, cost: string | null, flag: boolean) => {
    if (!showCost) return { belowCost: flag };
    const m = cost == null ? null : margin(rev, cost);
    return { belowCost: flag, revenue: rev, cost, margin: m?.amount ?? null, marginPct: m?.pct ?? null };
  };
  const lineRows = lines.slice(0, bill.reqLines).map((l, i) => row(revOf(i), costOf(l), below.lineIdx.has(i)));
  const bundleRows = bill.retail.bundles.map((b) => {
    const idx = lines.flatMap((l, i) => (l.bundle?.no === b.no ? [i] : []));
    const costs = idx.map((i) => costOf(lines[i]!));
    return row(money(sum(idx.map(revOf))), costs.some((c) => c == null) ? null : money(sum(costs as string[])), below.bundleNos.has(b.no));
  });
  const out: PosPreview = { showCost, lines: lineRows, bundles: bundleRows, belowCost: below.rows.length > 0 };
  if (showCost) {
    const rev = sum(lines.map((_, i) => revOf(i)));
    const cost = sum(lines.map((l) => costOf(l) ?? '0'));
    const m = margin(rev, cost);
    Object.assign(out, { revenue: money(rev), cost: money(cost), profit: m.amount, profitPct: m.pct });
  }
  return out;
}

const APPROVAL_TTL_MIN = 10;

/**
 * POST /api/sales/pos/approvals: manager override asked when the cashier enters a discount or a changed price over
 * their role cap. Verifies the approver PIN (no self-approval, lockout), checks the approver's own discount cap and
 * price permission, and stores a single-use approval bound to the tenant (RLS), the caller, their open shift and the
 * approver, valid for 10 minutes. The returned id is the token the sale carries.
 */
export async function posApprove(tx: Tx, deps: Deps, ctx: Ctx, req: PosApprovalReq): Promise<PosApproval> {
  requirePerm(ctx, 'pos.sell');
  const shift = await requireOwnOpenShift(tx, ctx, req.shiftId);
  const reason = req.reason ? discReasonText(req.reason) : null;
  const what = `ส่วนลด ฿${fmtTHB(req.maxAmount)} (${d(req.maxPct).toDecimalPlaces(2).toFixed()}%)${req.prices.length ? ` · แก้ราคา ${req.prices.length} รายการ` : ''}`;
  const a = await verifyApproval(tx, deps.pool, ctx, req.approval, approverRoles('pos.discCap'), what);
  if (!a.ok) throw E.forbidden('Discount approval rejected', { need: 'discountApproval', approvalError: a.reason });
  const apCap = perm(a.approver.role, 'pos.discCap');
  if (!approverCovers(typeof apCap === 'number' ? apCap : 0, req.maxPct)) {
    throw E.forbidden(`Discount ${req.maxPct}% is over the approver's cap of ${apCap}%`, { need: 'discountApproval', approvalError: 'APPROVER_CAP', cap: apCap });
  }
  if (req.prices.length && perm(a.approver.role, 'pos.price') !== 1) throw E.forbidden('The approver may not change prices', { need: 'discountApproval', approvalError: 'ROLE_NOT_ALLOWED' });
  if (req.prices.length) await loadProducts(tx, req.prices.map((p) => p.productId)); // unknown product → 400
  const prices = req.prices.map((p) => ({ productId: p.productId, unitIdx: p.unitIdx, price: qty4(p.price) }));
  const r = (await tx.query<{ id: string; expires_at: Date }>(
    `insert into pos_disc_approvals (tenant_id, user_id, shift_id, approver_id, max_amount, max_pct, prices, reason, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(mins => $9)) returning id, expires_at`,
    [ctx.tenantId, ctx.userId, shift.id, a.approver.id, money(req.maxAmount), round4(req.maxPct).toFixed(), JSON.stringify(prices), reason, APPROVAL_TTL_MIN],
  )).rows[0]!;
  await writeAudit(tx, ctx, [{ action: 'approve', object: 'discount', ref: shift.no, detail: `${what}${reason ? ` · เหตุผล: ${reason}` : ''} · อนุมัติโดย ${a.approver.name} (ก่อนชำระเงิน)` }]);
  return { token: r.id, approver: { id: a.approver.id, name: a.approver.name }, maxAmount: money(req.maxAmount), maxPct: round4(req.maxPct).toFixed(), prices, expiresAt: r.expires_at.toISOString() };
}

/** The caller's live, unused override for this shift, locked until COMMIT; null when missing, expired, used or not theirs. */
async function lockToken(tx: Tx, ctx: Ctx, shiftId: string, token: string) {
  if (!isUuid(token)) return null;
  const r = await tx.query<{ id: string; max_amount: string; max_pct: string; prices: PriceChange[]; approver_name: string; reason: string | null }>(
    `select a.id, a.max_amount::text, a.max_pct::text, a.prices, u.name approver_name, a.reason from pos_disc_approvals a join users u on u.id = a.approver_id
      where a.id = $1 and a.user_id = $2 and a.shift_id = $3 and a.used_doc_id is null and a.expires_at > now() for update of a`,
    [token, ctx.userId, shiftId],
  );
  return r.rows[0] ?? null;
}

export async function posSale(tx: Tx, deps: Deps, ctx: Ctx, req: PosSaleReq): Promise<SaleResult> {
  requirePerm(ctx, 'pos.sell');
  // Idempotency: a retried request returns the original bill, never a second one.
  const prior = await tx.query<{ no: string }>(`select no from docs where idempotency_key = $1`, [req.idempotencyKey]);
  if (prior.rows[0]) return { doc: await getDoc(tx, ctx, prior.rows[0].no), replay: true };

  const shift = await requireOwnOpenShift(tx, ctx, req.shiftId);
  const wh = await requireWarehouse(tx, req.warehouseId, { pos: true });
  const shop = await shopVatMode(tx, ctx);
  if (shop.vatRegistered === (req.docKind === 'receipt')) {
    throw E.validation(shop.vatRegistered ? 'VAT-registered shop issues abb or full tax invoices' : 'Non-VAT shop issues receipts only');
  }
  const type = req.docKind === 'abb' ? 'ABB' : req.docKind === 'full' ? 'INV' : 'RC';
  // Module C (REQ-M01-07): a machine without an approved POS ID issues full tax invoices only.
  if (type === 'ABB') await requireAbbDevice(tx, shift.device_id);
  const bill = await buildBill(tx, deps, req, shop.vatMode);
  const { customer, lines, retail, totals, vatMode } = bill;
  if (type === 'INV' && !customer?.tax_id) throw E.validation('A full tax invoice needs a customer with a tax ID', { field: 'customerId' });
  const audits: AuditInput[] = [];

  // Manager override: a discount over the role cap (cashier 0, OQ-10) or a changed unit price without pos.price.
  const discount = d(totals.lineDisc).plus(d(totals.billDisc));
  const cap = can(ctx, 'pos.discCap');
  const billDisc = { gross: totals.gross, discount: money(discount), prices: bill.priceChanges };
  const need = needsOverride(billDisc, typeof cap === 'number' ? cap : 0, can(ctx, 'pos.price') === 1);
  const pct = need.pct;
  let tokenId: string | null = null;
  if (need.discount || need.price) {
    const info = { pct, cap, priceChanged: need.price, need: 'discountApproval' };
    const msg = need.discount ? `Discount ${pct}% is over your cap of ${cap}%` : 'Changing the unit price needs approval';
    let by: string;
    if (req.discountToken) {
      const t = await lockToken(tx, ctx, shift.id, req.discountToken);
      if (!t) throw E.forbidden(`${msg}; the approval has expired or was used`, { ...info, tokenError: 'EXPIRED' });
      const cov = scopeCovers({ maxAmount: t.max_amount, maxPct: t.max_pct, prices: t.prices }, billDisc, { checkDiscount: need.discount, checkPrices: need.price });
      if (!cov.ok) throw E.forbidden(`${msg}; it is more than the manager approved`, { ...info, tokenError: 'EXCEEDS_APPROVAL', why: cov.why });
      tokenId = t.id;
      by = t.approver_name;
    } else if (req.discountApproval) {
      const a = await verifyApproval(tx, deps.pool, ctx, req.discountApproval, approverRoles('pos.discCap'), `ส่วนลด ${pct}%`);
      if (!a.ok) throw E.forbidden('Discount approval rejected', { ...info, approvalError: a.reason });
      const apCap = perm(a.approver.role, 'pos.discCap');
      if (!approverCovers(typeof apCap === 'number' ? apCap : 0, pct)) throw E.forbidden(`Discount ${pct}% is over the approver's cap of ${apCap}%`, { ...info, approvalError: 'APPROVER_CAP' });
      by = a.approver.name;
    } else {
      throw E.forbidden(msg, info);
    }
    audits.push({ action: 'approve', object: 'discount', detail: `ส่วนลด ${pct}% (สิทธิ์ ${cap}%)${need.price ? ' · เปลี่ยนราคา' : ''} · อนุมัติโดย ${by}` });
  }
  // A manual discount or a changed price always carries a reason (stored on the doc and in the audit row).
  const manual = discount.gt(0) || bill.priceChanges.length > 0;
  const reason = manual ? discReasonText(req.discountReason) : null;
  if (manual && !reason) throw E.validation('A discount or a changed price needs a reason', { field: 'discountReason' });

  const paid = sum(req.payments.map((p) => p.amount));
  if (!paid.eq(d(totals.total))) throw E.validation(`Payments ${money(paid)} must equal the bill total ${totals.total}`, { total: totals.total, paid: money(paid) });
  if (req.payments.some((p) => !d(p.amount).gt(0))) throw E.validation('Payment amounts must be > 0');
  const credit = await posCreditGate(tx, deps, ctx, req, customer, totals.total);
  if (credit?.audit) audits.push(credit.audit);

  // Number first: it is row-locked until COMMIT and rolled back with everything else on failure (BR-04).
  const date = deps.today();
  const no = await nextDocNo(tx, ctx.tenantId, type, date, shift.device_id);

  // BR-07: lock the lots, plan FIFO per line; shortage -> 409 before anything is written.
  const stockLines = lines.filter((l) => l.p.kind === 'stock');
  const lots = await lockLots(tx, wh.id, stockLines.map((l) => l.p.id));
  const plans = planTakes(lots, wh.id, stockLines.map((l) => ({ productId: l.p.id, qty: l.core.baseQty })));
  const planOf = new Map(stockLines.map((l, i) => [l, plans[i]!]));

  const belowRows = evalBelowCost(bill, planOf).rows;
  if (belowRows.length) {
    const below = belowRows;
    const seeCost = can(ctx, 'data.cost') === 1;
    const detail = below.map((b) => ({ productId: b.productId, name: b.name, ...(seeCost ? { sell: money(b.sell), cost: money(b.cost) } : {}) }));
    const text = below.map((b) => `${b.name} (ขาย ${money(b.sell)} < ทุน ${money(b.cost)})`).join(', ');
    if (ctx.role === 'owner') {
      audits.push({ action: 'approve', object: 'below-cost', detail: `ขายต่ำกว่าทุน ${below.length} รายการ: ${text} · เจ้าของร้าน (ยืนยันเอง)` });
    } else if (req.belowCostApproval) {
      const a = await verifyApproval(tx, deps.pool, ctx, req.belowCostApproval, approverRoles('sales.belowCost'), 'ขายต่ำกว่าทุน');
      if (!a.ok) throw E.belowCost('Below-cost sale needs the owner\'s PIN', { lines: detail, approvalError: a.reason });
      audits.push({ action: 'approve', object: 'below-cost', detail: `ขายต่ำกว่าทุน ${below.length} รายการ: ${text} · อนุมัติโดย ${a.approver.name}` });
    } else {
      throw E.belowCost(`${below.length} line(s) below cost`, { lines: detail });
    }
  }

  const note = (req.note ?? '').trim();
  const docId = (await tx.query<{ id: string }>(
    `insert into docs (tenant_id, no, type, date, customer_id, customer_name, customer_phone, vat_mode, warehouse_id, shift_id, device_id,
       gross, line_disc, bill_disc, base7, exempt, vat, total, payments, created_by, idempotency_key, search_text, note, disc_reason, ar_balance)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) returning id`,
    [ctx.tenantId, no, type, date, customer?.id ?? null, customer?.name ?? 'ลูกค้าทั่วไป', customer?.phone ?? null, vatMode, wh.id, shift.id, shift.device_id,
      totals.gross, totals.lineDisc, totals.billDisc, totals.base7, totals.exempt, totals.vat, totals.total,
      JSON.stringify(req.payments.map((p) => ({ method: p.method, amount: money(p.amount) }))), ctx.userId, req.idempotencyKey,
      searchText({ no, customer: customer && { name: customer.name, code: customer.code, phone: customer.phone, taxId: customer.tax_id }, products: lines.map((l) => l.p), total: totals.total }),
      note, reason, credit ? credit.amount : '0'],
  )).rows[0]!.id;
  if (tokenId) await tx.query(`update pos_disc_approvals set used_doc_id = $2 where id = $1`, [tokenId, docId]);
  // Credit sale: a receivable like a B2B credit invoice (AR list, billing note, receipt, statement, credit limit).
  if (credit) {
    await tx.query(
      `insert into sales_invoices (doc_id, tenant_id, kind, source, term, due_date) values ($1,$2,'credit','pos',$3,$4)`,
      [docId, ctx.tenantId, JSON.stringify(credit.term), dueDate(date, credit.term)],
    );
  }

  for (const [i, l] of lines.entries()) {
    const pl = planOf.get(l);
    const lineId = (await tx.query<{ id: string }>(
      `insert into doc_lines (tenant_id, doc_id, line_no, product_id, name, unit_name, unit_factor, qty, base_qty, unit_price, discount, net, net_after_bill, vat, cogs,
         retail_promo_id, retail_promo_name, retail_list_price, retail_price_source, retail_bundle_no, retail_bundle_sets, retail_bundle_qty, retail_bundle_price)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) returning id`,
      [ctx.tenantId, docId, i + 1, l.p.id, l.p.name, l.u.name, l.u.factor, l.qty, l.core.baseQty, l.unitPrice,
        money(lineDiscount(l.core)),
        totals.lines[i]!.net, totals.lines[i]!.after, l.p.vat, pl ? pl.cogs : null,
        l.retail?.promo?.id ?? null, l.retail?.promo?.name ?? null, l.retail?.listPrice ?? null, l.retail?.source ?? null,
        l.bundle?.no ?? null, l.bundle?.sets ?? null, l.bundle?.qtyPerSet ?? null, l.bundle?.setPrice ?? null],
    )).rows[0]!.id;
    const moveNote = l.bundle ? `ขายชุดโปร · ${l.retail!.promo!.name}` : l.retail?.promo ? `ขายหน้าร้าน · โปร ${l.retail.promo.name}` : 'ขายหน้าร้าน';
    if (pl) await applyOut(tx, ctx, wh.id, pl, { docType: type, docNo: no, docId, docLineId: lineId, note: moveNote });
  }

  await deps.hooks.beforeCommit?.('posSale', tx);
  const promoNames = [...new Set(lines.flatMap((l) => (l.retail?.promo ? [l.retail.promo.name] : [])))];
  const methodTh = (m: string) => (m === 'credit' ? 'เงินเชื่อ' : m);
  audits.push({
    action: 'create', object: type, ref: no,
    detail: `฿${fmtTHB(totals.total)} · ${req.lines.length + retail.bundles.length} รายการ · ${req.payments.map((p) => methodTh(p.method)).join(' + ')} · กะ ${shift.no}`
      + `${promoNames.length ? ` · โปร ${promoNames.join(', ')}` : ''}${reason ? ` · ส่วนลด ฿${fmtTHB(discount)}${bill.priceChanges.length ? ` / แก้ราคา ${bill.priceChanges.length} รายการ` : ''} เหตุผล: ${reason}` : ''}`
      + `${note ? ` · หมายเหตุ: ${note}` : ''}`,
  });
  await writeAudit(tx, ctx, audits);
  return { doc: await getDoc(tx, ctx, no), replay: false };
}

/**
 * POS credit sale (เงินเชื่อ): the whole bill on credit (one payment line), a named customer whose term is not cash.
 * BR-08: over the credit limit (outstanding AR + this bill) or with overdue bills needs approval: owner / manager
 * (sales.creditApv = 1) approve themselves and it is logged; anyone else needs an owner / manager PIN.
 */
async function posCreditGate(tx: Tx, deps: Deps, ctx: Ctx, req: PosSaleReq, customer: PosCustomer | null, total: string) {
  const creditPays = req.payments.filter((p) => p.method === 'credit');
  if (!creditPays.length) return null;
  if (req.payments.length !== 1) throw E.validation('A credit sale is put fully on credit (no split payment)', { field: 'payments' });
  if (!customer) throw E.validation('A credit sale needs a named customer', { field: 'customerId' });
  const c = await loadCustomer(tx, customer.id);
  if (c.term.t === 'cash') throw E.validation(`${c.name} buys on cash terms; set a credit term in the customer master first`, { field: 'customerId', reason: 'CASH_TERM' });
  const info = await creditInfo(tx, deps, c);
  const after = d(info.balance).plus(d(total));
  const over = d(info.limit).gt(0) && after.gt(d(info.limit));
  const base = { amount: money(total), term: c.term as PaymentTerm, audit: null as AuditInput | null };
  if (!over && !info.overdue.length) return base;
  const why = [over ? `เกินวงเงิน ${fmtTHB(info.limit)} (ค้าง ${fmtTHB(info.balance)} + บิลนี้ ${fmtTHB(total)} = ${fmtTHB(after)})` : '', info.overdue.length ? `มีบิลเกินกำหนด ${info.overdue.length} ใบ` : '']
    .filter(Boolean).join(' · ');
  const need = { need: 'creditApproval', limit: info.limit, balance: info.balance, amount: money(total), after: money(after), over, overdue: info.overdue.length };
  let by: string;
  if (can(ctx, 'sales.creditApv') === 1) by = `${ctx.name} (ผู้มีสิทธิ์อนุมัติ)`;
  else if (req.creditApproval) {
    const a = await verifyApproval(tx, deps.pool, ctx, req.creditApproval, approverRoles('sales.creditApv'), `ขายเชื่อเกินวงเงิน ${c.name}`);
    if (!a.ok) throw E.forbidden('Credit approval rejected', { ...need, approvalError: a.reason });
    by = a.approver.name;
  } else throw E.forbidden(`Credit sale needs approval: ${why}`, need);
  return { ...base, audit: { action: 'approve', object: 'credit-limit', detail: `ขายเชื่อหน้าร้าน ${c.name} · ${why} · อนุมัติโดย ${by}` } };
}


export interface DocFilters { type?: string; from?: string; to?: string; productId?: string; customerId?: string; createdBy?: string; category?: string }

export async function listDocs(tx: Tx, q: PageQuery & DocFilters) {
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.type) {
    params.push(q.type);
    where.push(`d.type = $${params.length}`);
  }
  // report drill-down filters (REQ-M11): the sales report row opens the documents behind it
  if (q.from) { params.push(q.from); where.push(`d.date >= $${params.length}::date`); }
  if (q.to) { params.push(q.to); where.push(`d.date <= $${params.length}::date`); }
  if (q.customerId === '-') where.push(`d.customer_id is null`);
  else if (q.customerId) { params.push(q.customerId); where.push(`d.customer_id = $${params.length}::uuid`); }
  if (q.createdBy) { params.push(q.createdBy); where.push(`d.created_by = $${params.length}::uuid`); }
  if (q.productId) { params.push(q.productId); where.push(`exists (select 1 from doc_lines x where x.doc_id = d.id and x.product_id = $${params.length}::uuid)`); }
  if (q.category) {
    params.push(q.category === '-' ? '' : q.category);
    where.push(`exists (select 1 from doc_lines x join products p on p.id = x.product_id where x.doc_id = d.id and coalesce(p.category,'') = $${params.length})`);
  }
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(d.search_text like $${params.length} or lower(d.no) like $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(d.created_at, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  return summaries(tx, `${where.length ? 'where ' + where.join(' and ') : ''}`, params, q.limit);
}

/** DocSummary page; `where` may reference docs as d. Ordered newest first. */
export async function summaries(tx: Tx, where: string, params: unknown[], limit: number) {
  const r = await tx.query<{ id: string; no: string; type: DocSummary['type']; date: string; customer_id: string | null; customer_name: string; customer_phone: string | null; status: DocSummary['status']; total: string; created_at: Date; preview: string | null }>(
    `select d.id, d.no, d.type, d.date, d.customer_id, d.customer_name, d.customer_phone, d.status, d.total::text, d.created_at,
            (select string_agg(split_part(l.name, ' ', 1) || ' ×' || trim(trailing '.' from trim(trailing '0' from l.qty::text)), ', ' order by l.line_no)
               from (select * from doc_lines x where x.doc_id = d.id order by x.line_no limit 3) l) as preview
       from docs d ${where} order by d.created_at desc, d.id desc limit $${params.length}`,
    params,
  );
  return pageOf(r.rows, limit, (x) => [x.created_at.toISOString(), x.id], (x): DocSummary => ({
    id: x.id, no: x.no, type: x.type, date: x.date, customer: { id: x.customer_id, name: x.customer_name, phone: x.customer_phone },
    status: x.status, total: x.total, itemsPreview: x.preview ?? '',
  }));
}

/**
 * Extra BR-22 downstream checks registered by module groups: return the numbers of active documents that still
 * depend on `doc` (e.g. AR receipts or billing notes on a B2B invoice). Registered once per process.
 */
export type VoidGuard = (tx: Tx, doc: { id: string; no: string; type: string }) => Promise<string[]>;
export const voidGuards: VoidGuard[] = [];
export function registerVoidGuard(g: VoidGuard): void {
  if (!voidGuards.includes(g)) voidGuards.push(g);
}

/** BR-03/BR-22: void = status flag + stock back into the original lots; the number is kept. */
export async function voidDoc(tx: Tx, deps: Deps, ctx: Ctx, no: string, body: { reason: string; approverUserId?: string; pin?: string }): Promise<SalesDoc> {
  const p = can(ctx, 'sales.voidDoc');
  let approvedBy = '';
  if (p === 'apv') {
    if (!body.approverUserId || !body.pin) throw E.forbidden('Voiding needs a manager or owner PIN', { need: 'approval' });
    const a = await verifyApproval(tx, deps.pool, ctx, { approverUserId: body.approverUserId, pin: body.pin }, approverRoles('sales.voidDoc'), `ยกเลิก ${no}`);
    if (!a.ok) throw E.forbidden('Void approval rejected', { approvalError: a.reason });
    approvedBy = ` · อนุมัติโดย ${a.approver.name}`;
  } else if (p !== 1) {
    throw E.forbidden('Permission sales.voidDoc is required');
  }
  const doc = await getDocRow(tx, no, { forUpdate: true });
  if (doc.status === 'void') throw E.conflict(`${no} is already void`);
  if (doc.type === 'CN') throw E.conflict('Credit notes cannot be voided');
  const downstream = await tx.query<{ no: string }>(`select no from docs where ref_doc_id = $1 and status = 'active' order by created_at`, [doc.id]);
  const returned = await tx.query(`select 1 from doc_lines where doc_id = $1 and returned_qty > 0 limit 1`, [doc.id]);
  const guarded: string[] = [];
  for (const g of voidGuards) guarded.push(...(await g(tx, doc)));
  if (downstream.rowCount || returned.rowCount || guarded.length) {
    throw E.downstreamFirst(`${no} has downstream documents; handle them first`, { docs: [...downstream.rows.map((r) => r.no), ...guarded] });
  }
  await reverseOuts(tx, ctx, doc.id, { docType: doc.type, docNo: doc.no, docId: doc.id, note: `คืนสต็อก · ยกเลิก ${doc.no}` });
  await tx.query(`update docs set status = 'void', void_by = $2, void_at = now(), void_reason = $3 where id = $1`, [doc.id, ctx.userId, body.reason]);
  await deps.hooks.beforeCommit?.('voidDoc', tx);
  await writeAudit(tx, ctx, [{ action: 'void', object: doc.type, ref: doc.no, detail: `${body.reason} · ฿${fmtTHB(doc.total)}${approvedBy}` }]);
  return getDoc(tx, ctx, no);
}

/** BR-22: a POS credit bill (ABB / RC) with an active AR receipt or billing note is voided only after them (INV is guarded by module A). */
registerVoidGuard(async (tx, doc) => {
  if (doc.type !== 'ABB' && doc.type !== 'RC') return [];
  const r = await tx.query<{ no: string }>(
    `select r.no from ar_receipt_lines l join ar_receipts r on r.id = l.receipt_id where l.invoice_doc_id = $1 and r.status = 'active'
     union select b.no from ar_billing_note_lines l join ar_billing_notes b on b.id = l.bn_id where l.invoice_doc_id = $1 and b.status = 'active'`,
    [doc.id],
  );
  return r.rows.map((x) => x.no);
});
