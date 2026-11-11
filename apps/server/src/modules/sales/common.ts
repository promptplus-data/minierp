/** Shared helpers of the sales module: parties, vat mode, line building, totals, BR-08 credit and BR-16 below-cost gates, void auth. */
import { searchTokens } from '@erp/core';
import type { Tx } from '@erp/db';
import type { SalesLine, SalesLineIn, SalesParty, SalesTerm, SalesTotals } from '@erp/contracts';
import {
  approverRoles, calcDoc, checkBelowCost, d, daysOverdue, discountPct, exceedsCap, fmtTHB, lineDiscount, money, netUnitPricesExVat, qty4, sum, takeLots,
  type DocLine as CoreLine, type LineDiscount, type VatMode,
} from '@erp/core';
import { verifyApproval, type Approval } from '../../lib/approval';
import type { AuditInput } from '../../lib/audit';
import { can, type Ctx, type Deps } from '../../lib/context';
import { E, isUuid } from '../../lib/errors';
import { decodeCursor, likeEscape, pageOf } from '../../lib/paging';
import type { Planned } from '../../lib/stock';
import { loadProducts, unitOf, type ProductRow } from '../../services/master';

// ---------- customers / users ----------
export interface CustomerRow { id: string; code: string; name: string; tax_id: string | null; branch: string | null; phone: string | null; credit_limit: string; term: SalesTerm }

export async function loadCustomer(tx: Tx, id: string | null | undefined): Promise<CustomerRow> {
  if (!isUuid(id)) throw E.validation('Unknown customer');
  const r = await tx.query<CustomerRow>(`select id, code, name, tax_id, branch, phone, credit_limit::text, term from customers where id = $1`, [id]);
  if (!r.rows[0]) throw E.validation('Unknown customer');
  return r.rows[0];
}

export const party = (c: Pick<CustomerRow, 'id' | 'code' | 'name' | 'tax_id' | 'branch' | 'phone'> | null, fallbackName = ''): SalesParty =>
  c ? { id: c.id, code: c.code, name: c.name, taxId: c.tax_id, branch: c.branch, phone: c.phone } : { id: null, code: null, name: fallbackName, taxId: null, branch: null, phone: null };

/** Party JSON from a joined row with c_* columns. */
export const partyCols = `c.id as c_id, c.code as c_code, c.name as c_name, c.tax_id as c_tax_id, c.branch as c_branch, c.phone as c_phone`;
export interface PartyCols { c_id: string | null; c_code: string | null; c_name: string | null; c_tax_id: string | null; c_branch: string | null; c_phone: string | null }
export const partyOf = (r: PartyCols, fallbackName = ''): SalesParty =>
  r.c_id ? { id: r.c_id, code: r.c_code, name: r.c_name ?? '', taxId: r.c_tax_id, branch: r.c_branch, phone: r.c_phone } : party(null, fallbackName);

export async function requireUser(tx: Tx, id: string | undefined): Promise<string | null> {
  if (!id) return null;
  if (!isUuid(id)) throw E.validation('Unknown salesperson');
  const r = await tx.query(`select 1 from users where id = $1 and status = 'active'`, [id]);
  if (!r.rowCount) throw E.validation('Unknown salesperson');
  return id;
}

export const userRef = (id: string | null, name: string | null, phone: string | null) => (id && name ? { id, name, phone } : null);

// ---------- shop / vat ----------
export interface ShopRow { name: string; tax_id: string; branch: string; address: string; phone: string; vat_registered: boolean; b2b_vat_mode: 'inc' | 'exc' }
export async function loadShop(tx: Tx, ctx: Ctx): Promise<ShopRow> {
  const r = await tx.query<ShopRow>(`select name, tax_id, branch, address, phone, vat_registered, b2b_vat_mode from tenants where id = $1`, [ctx.tenantId]);
  return r.rows[0]!;
}

/** Document VAT mode: a non-VAT shop is always 'none'; a VAT shop uses the request or its B2B default (inc / exc). */
export async function resolveVatMode(tx: Tx, ctx: Ctx, requested?: VatMode): Promise<VatMode> {
  const s = await loadShop(tx, ctx);
  if (!s.vat_registered) return 'none';
  if (requested === 'none') throw E.validation('A VAT-registered shop prices B2B documents including or excluding VAT');
  return requested ?? s.b2b_vat_mode;
}
/** Lump-sum documents (deposits, installments): VAT-inclusive for a VAT shop. */
export async function lumpVatMode(tx: Tx, ctx: Ctx): Promise<'inc' | 'none'> {
  return (await loadShop(tx, ctx)).vat_registered ? 'inc' : 'none';
}

// ---------- lines ----------
export interface BuiltLine {
  product: ProductRow | null; unitIdx: number | null; name: string; unitName: string; unitFactor: string;
  qty: string; baseQty: string; unitPrice: string; discount: LineDiscount | null; vat: 'v7' | 'exempt';
  /** BR-05 price for this line (document VAT basis) and its source; set by priceLines. Null for free-text lines. */
  listPrice?: string | null; priceSource?: string | null; priceRef?: string | null;
}

/** Validates and resolves request lines. Free-text lines (no productId) only when allowFree (quotations). */
export async function buildLines(tx: Tx, lines: SalesLineIn[], opts: { allowFree: boolean }): Promise<BuiltLine[]> {
  const ids = lines.flatMap((l) => (l.productId ? [l.productId] : []));
  const products = ids.length ? await loadProducts(tx, ids) : new Map<string, ProductRow>();
  return lines.map((l, i) => {
    if (!d(l.qty).gt(0)) throw E.validation(`Line ${i + 1}: qty must be > 0`);
    const discount = l.discount ? { kind: l.discount.kind, value: l.discount.value } : null;
    if (!l.productId) {
      if (!opts.allowFree) throw E.validation(`Line ${i + 1}: map the free-text item to a product first (REQ-M08-09)`, { line: i + 1, need: 'mapping' });
      const name = (l.name ?? '').trim();
      if (!name) throw E.validation(`Line ${i + 1}: a free-text line needs a name`);
      return { product: null, unitIdx: null, name, unitName: (l.unitName ?? '').trim() || 'รายการ', unitFactor: '1', qty: qty4(l.qty), baseQty: qty4(l.qty), unitPrice: qty4(l.unitPrice), discount, vat: l.vat ?? 'v7' };
    }
    const p = products.get(l.productId)!;
    if (!p.active) throw E.validation(`Product ${p.sku} is inactive`);
    const u = unitOf(p, l.unitIdx);
    return {
      product: p, unitIdx: l.unitIdx, name: p.name, unitName: u.name, unitFactor: qty4(u.factor), qty: qty4(l.qty),
      baseQty: qty4(d(l.qty).times(d(u.factor))), unitPrice: qty4(l.unitPrice), discount, vat: p.vat,
    };
  });
}

export const coreLine = (l: Pick<BuiltLine, 'qty' | 'unitPrice' | 'discount' | 'vat'>): CoreLine => ({ qty: l.qty, unitPrice: l.unitPrice, discount: l.discount, vat: l.vat });
export const discAmt = (l: BuiltLine) => money(lineDiscount(coreLine(l)));

/** coupon: member coupon value (cloud only), applied before the bill discount by calcDoc. */
export function totalsOf(lines: BuiltLine[], vatMode: VatMode, billDiscount: string, coupon = '0') {
  if (d(billDiscount).lt(0)) throw E.validation('Bill discount must not be negative');
  return calcDoc(lines.map(coreLine), vatMode, billDiscount, coupon);
}

export const totalsJson = (r: { gross: string; line_disc: string; bill_disc: string; base7: string; exempt: string; vat: string; total: string }): SalesTotals => ({
  gross: r.gross, lineDisc: r.line_disc, billDisc: r.bill_disc, base7: r.base7, exempt: r.exempt, vat: r.vat, total: r.total,
});
export const TOTAL_COLS = (a: string) => `${a}.gross::text, ${a}.line_disc::text, ${a}.bill_disc::text, ${a}.base7::text, ${a}.exempt::text, ${a}.vat::text, ${a}.total::text`;

export interface LineRowBase {
  id: string; line_no: number; product_id: string | null; unit_idx: number | null; sku: string | null; name: string; unit_name: string; qty: string;
  unit_price: string; discount: LineDiscount | null; disc_amt: string; net: string; vat: 'v7' | 'exempt';
  list_price?: string | null; price_source?: string | null; price_ref?: string | null;
}
export const lineJson = (l: LineRowBase): SalesLine => ({
  id: l.id, lineNo: l.line_no, productId: l.product_id, unitIdx: l.unit_idx, sku: l.sku, name: l.name, unitName: l.unit_name, qty: qty4(l.qty),
  unitPrice: qty4(l.unit_price), discount: l.discount ? { kind: l.discount.kind, value: String(l.discount.value) } : null, discAmt: money(l.disc_amt),
  net: money(l.net), vat: l.vat, free: !l.product_id,
  listPrice: l.list_price != null ? money(l.list_price) : null, priceSource: l.price_source ?? null, priceRef: l.price_ref ?? null, unitCost: null, profit: null,
});

/** Lower-cased search haystack: number, customer, products, amount. */
export function haystack(no: string, c: { name: string; code?: string | null; phone?: string | null; tax_id?: string | null } | null, names: string[], total: string, extra: string[] = []): string {
  const t = d(total);
  return [no, c?.name, c?.code, c?.phone, c?.phone?.replace(/\D/g, ''), c?.tax_id, ...names, money(t), fmtTHB(t), ...extra].filter(Boolean).join(' ').toLowerCase();
}

// ---------- paging ----------
/**
 * Newest-first keyset page over `from` (must expose alias x with created_at, id, search_text).
 * `where` and `params` are extra filters; q words are ANDed over search_text.
 */
export async function pageNewest<R extends { created_at: Date; id: string }, T>(
  tx: Tx, select: string, from: string, where: string[], params: unknown[], q: { q?: string; limit: number; cursor?: string }, map: (r: R) => T,
) {
  const cur = decodeCursor(q.cursor, 2);
  const w = [...where];
  const p = [...params];
  for (const word of searchTokens(q.q)) {
    p.push(`%${likeEscape(word)}%`);
    w.push(`x.search_text like $${p.length}`);
  }
  if (cur) {
    p.push(cur[0], cur[1]);
    w.push(`(x.created_at, x.id) < ($${p.length - 1}::timestamptz, $${p.length}::uuid)`);
  }
  p.push(q.limit + 1);
  const r = await tx.query<R>(`select ${select} from ${from} ${w.length ? 'where ' + w.join(' and ') : ''} order by x.created_at desc, x.id desc limit $${p.length}`, p);
  return pageOf(r.rows, q.limit, (x) => [x.created_at.toISOString(), x.id], map);
}

// ---------- BR-08 credit limit / overdue ----------
export interface CreditInfo { limit: string; balance: string; available: string | null; overdue: { no: string; dueDate: string; balance: string; days: number }[] }

export async function creditInfo(tx: Tx, deps: Deps, customer: CustomerRow): Promise<CreditInfo> {
  const r = await tx.query<{ no: string; due_date: string; ar_balance: string }>(
    `select d.no, si.due_date::text, d.ar_balance::text from docs d join sales_invoices si on si.doc_id = d.id
      where d.customer_id = $1 and d.status = 'active' and si.kind = 'credit' and d.ar_balance > 0 order by si.due_date, d.no`,
    [customer.id],
  );
  const today = deps.today();
  const balance = money(sum(r.rows.map((x) => x.ar_balance)));
  // REQ-M10-06: a customer without its own limit gets the shop default (50,000 unless changed in the sales settings).
  const dflt = (await tx.query<{ v: string }>(`select default_credit_limit::text v from sales_settings`)).rows[0]?.v ?? '50000';
  const limit = money(d(customer.credit_limit).gt(0) ? customer.credit_limit : dflt);
  return {
    limit, balance, available: d(limit).gt(0) ? money(d(limit).minus(d(balance))) : null,
    overdue: r.rows.filter((x) => x.due_date < today).map((x) => ({ no: x.no, dueDate: x.due_date, balance: money(x.ar_balance), days: daysOverdue(x.due_date, today) })),
  };
}

/**
 * BR-08 / REQ-M08-03: a credit sale over the limit (limit 0 = no limit, only when the shop default is 0) or with
 * overdue bills needs approval.
 * sales.creditApv = 1 (owner, manager) approves itself and is logged; 'apv' (sales) needs an owner / manager PIN.
 */
export async function creditGate(
  tx: Tx, deps: Deps, ctx: Ctx, customer: CustomerRow, term: SalesTerm, amount: string, approval: Approval | undefined, what: string,
): Promise<{ approval: Record<string, unknown> | null; audit: AuditInput | null }> {
  if (term.t === 'cash') return { approval: null, audit: null };
  const info = await creditInfo(tx, deps, customer);
  const after = d(info.balance).plus(d(amount));
  const over = d(info.limit).gt(0) && after.gt(d(info.limit));
  if (!over && !info.overdue.length) return { approval: null, audit: null };
  const reason = [over ? `เกินวงเงิน ${fmtTHB(info.limit)} (ค้าง ${fmtTHB(info.balance)} + ใหม่ ${fmtTHB(amount)} = ${fmtTHB(after)})` : '', info.overdue.length ? `มีบิลเกินกำหนด ${info.overdue.length} ใบ` : '']
    .filter(Boolean).join(' · ');
  const need = { need: 'creditApproval', limit: info.limit, balance: info.balance, amount: money(amount), after: money(after), over, overdue: info.overdue };
  const p = can(ctx, 'sales.creditApv');
  let by: { id: string; name: string };
  if (p === 1) by = { id: ctx.userId, name: ctx.name };
  else if (p === 'apv') {
    if (!approval) throw E.forbidden(`Credit sale needs approval: ${reason}`, need);
    const a = await verifyApproval(tx, deps.pool, ctx, approval, approverRoles('sales.creditApv'), `ขายเชื่อเกินวงเงิน ${what}`);
    if (!a.ok) throw E.forbidden('Credit approval rejected', { ...need, approvalError: a.reason });
    by = a.approver;
  } else throw E.forbidden('Permission sales.creditApv is required for this credit sale', need);
  const detail = `${reason} · อนุมัติโดย ${by.name}${by.id === ctx.userId ? ' (ผู้มีสิทธิ์อนุมัติ)' : ''}`;
  return {
    approval: { by: by.id, name: by.name, detail, limit: info.limit, balance: info.balance, amount: money(amount), overdue: info.overdue.length, at: new Date().toISOString() },
    audit: { action: 'approve', object: 'credit-limit', detail: `${what} · ${detail}` },
  };
}

// ---------- BR-16 below cost ----------
/** FIFO unit cost (per base unit) of what each line would consume, without locking (sales orders). */
export async function peekUnitCosts(tx: Tx, warehouseId: string | null, lines: BuiltLine[]): Promise<(string | null)[]> {
  const stock = lines.filter((l) => l.product?.kind === 'stock');
  if (!stock.length) return lines.map(() => null);
  const r = await tx.query<{ id: string; product_id: string; qty: string; unit_cost: string; received_at: string }>(
    `select id::text, product_id, remaining::text qty, unit_cost::text, to_char(received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') received_at from stock_lots
      where product_id = any($1::uuid[]) and remaining > 0 ${warehouseId ? 'and warehouse_id = $2' : ''} order by product_id, received_at, id`,
    warehouseId ? [stock.map((l) => l.product!.id), warehouseId] : [stock.map((l) => l.product!.id)],
  );
  const lots = new Map<string, { id: string; receivedAt: string; qty: string; unitCost: string }[]>();
  for (const x of r.rows) lots.set(x.product_id, [...(lots.get(x.product_id) ?? []), { id: x.id, receivedAt: x.received_at, qty: x.qty, unitCost: x.unit_cost }]);
  return lines.map((l) => {
    if (l.product?.kind !== 'stock') return null;
    const ls = (lots.get(l.product.id) ?? []).filter((x) => d(x.qty).gt(0));
    const have = sum(ls.map((x) => x.qty));
    const take = d(l.baseQty).gt(have) ? have : d(l.baseQty);
    let cogs = d(0);
    if (take.gt(0)) {
      const plan = takeLots(ls, qty4(take));
      cogs = d(plan.cogs);
      // consecutive lines of one product continue where the previous line stopped
      for (const t of plan.takes) {
        const lot = ls.find((x) => x.id === t.lotId)!;
        lot.qty = qty4(d(lot.qty).minus(d(t.qty)));
      }
    }
    const rest = d(l.baseQty).minus(take);
    if (rest.gt(0)) cogs = cogs.plus(rest.times(d(l.product.cost))); // not in stock yet: the product's standard cost
    return d(l.baseQty).gt(0) ? qty4(cogs.div(d(l.baseQty))) : null;
  });
}

/** Unit costs from real FIFO plans (direct invoices that cut stock now). */
export const planUnitCosts = (lines: BuiltLine[], plans: Map<BuiltLine, Planned>): (string | null)[] =>
  lines.map((l) => {
    const p = plans.get(l);
    return p && d(p.qty).gt(0) ? qty4(d(p.cogs).div(d(p.qty))) : null;
  });

/** BR-16: owner sells below cost himself (logged) or another user needs the owner's PIN. Quotations are never checked. */
export async function belowCostGate(
  tx: Tx, deps: Deps, ctx: Ctx, lines: BuiltLine[], vatMode: VatMode, billDisc: string, unitCosts: (string | null)[], approval: Approval | undefined, what: string,
  /** Lines already approved below cost upstream (quotation lines carried unchanged into the order). */
  preApproved?: { lines: Set<number>; by: string },
): Promise<{ approval: Record<string, unknown> | null; audit: AuditInput | null }> {
  const sell = netUnitPricesExVat(lines.map((l) => ({ ...coreLine(l), baseQty: l.baseQty })), vatMode, billDisc);
  const all = checkBelowCost(lines.map((_, i) => ({ netUnitExVat: sell[i] ?? '0', unitCost: unitCosts[i] })));
  const below = all.filter((i) => !preApproved?.lines.has(i));
  if (!below.length) {
    if (!all.length) return { approval: null, audit: null };
    const msg = `ขายต่ำกว่าทุน ${all.length} รายการ (อนุมัติแล้วในใบเสนอราคา) · อนุมัติโดย ${preApproved!.by}`;
    return { approval: { by: preApproved!.by, detail: msg, at: new Date().toISOString() }, audit: { action: 'approve', object: 'below-cost', detail: `${what} · ${msg}` } };
  }
  const seeCost = can(ctx, 'data.cost') === 1;
  const detail = below.map((i) => ({ productId: lines[i]!.product?.id, name: lines[i]!.name, ...(seeCost ? { sell: money(sell[i]!), cost: money(unitCosts[i]!) } : {}) }));
  const text = below.map((i) => `${lines[i]!.name} (ขาย ${money(sell[i]!)} < ทุน ${money(unitCosts[i]!)})`).join(', ');
  let by: string;
  if (ctx.role === 'owner') by = 'เจ้าของร้าน (ยืนยันเอง)';
  else if (approval) {
    const a = await verifyApproval(tx, deps.pool, ctx, approval, approverRoles('sales.belowCost'), `ขายต่ำกว่าทุน ${what}`);
    if (!a.ok) throw E.belowCost('Below-cost sale needs the owner\'s PIN', { lines: detail, approvalError: a.reason });
    by = a.approver.name;
  } else throw E.belowCost(`${below.length} line(s) below cost`, { lines: detail });
  const msg = `ขายต่ำกว่าทุน ${below.length} รายการ: ${text} · อนุมัติโดย ${by}`;
  return { approval: { by, detail: msg, at: new Date().toISOString() }, audit: { action: 'approve', object: 'below-cost', detail: `${what} · ${msg}` } };
}

// ---------- price below BR-05 / discount over the role cap ----------
export interface PriceApprovalIn extends Approval { reason: string }

/**
 * A unit price below the BR-05 price (list / promo / quotation) needs pos.price = 1 or a manager / owner PIN; a
 * discount (line + bill) over the role cap pos.discCap needs the PIN too (same rule as POS). The approver gives a
 * reason; both are recorded on the document and in the audit log. Raising a price above the list is free.
 */
export async function priceGate(
  tx: Tx, deps: Deps, ctx: Ctx, lines: BuiltLine[], totals: { gross: string; lineDisc: string; billDisc: string }, approval: PriceApprovalIn | undefined, what: string,
): Promise<{ approval: Record<string, unknown> | null; audit: AuditInput[] }> {
  const lowered = lines.flatMap((l, i) => (l.product && l.listPrice != null && d(l.unitPrice).lt(d(l.listPrice)) ? [i] : []));
  const cap = can(ctx, 'pos.discCap');
  const capPct = typeof cap === 'number' ? cap : 0;
  const pct = discountPct(totals.gross, d(totals.lineDisc).plus(d(totals.billDisc)));
  const overCap = exceedsCap(pct, capPct);
  const priceNeeds = lowered.length > 0 && can(ctx, 'pos.price') !== 1;
  const text = lowered.map((i) => `${lines[i]!.name} ${money(lines[i]!.unitPrice)} (ราคาตามระบบ ${money(lines[i]!.listPrice!)})`).join(', ');
  if (!overCap && !priceNeeds) {
    // allowed to change prices: logged, no PIN
    return { approval: null, audit: lowered.length ? [{ action: 'update', object: 'price-change', detail: `${what} · ลดราคาจากราคาตามระบบ: ${text}` }] : [] };
  }
  const need = {
    need: 'priceApproval', pct, cap: capPct, overCap, priceChanged: priceNeeds,
    lines: lowered.map((i) => ({ line: i + 1, name: lines[i]!.name, unitPrice: money(lines[i]!.unitPrice), listPrice: money(lines[i]!.listPrice!) })),
  };
  if (!approval) throw E.forbidden(overCap ? `Discount ${pct}% is over your cap of ${capPct}%` : 'A price below the list price needs approval', need);
  if (!approval.reason?.trim()) throw E.validation('The approval needs a reason', { ...need, approvalError: 'REASON' });
  const a = await verifyApproval(tx, deps.pool, ctx, approval, approverRoles('pos.discCap'), `${what} · ส่วนลด ${pct}%`);
  if (!a.ok) throw E.forbidden('Price approval rejected', { ...need, approvalError: a.reason });
  const parts = [overCap ? `ส่วนลด ${pct}% (สิทธิ์ ${capPct}%)` : '', priceNeeds ? `เปลี่ยนราคา: ${text}` : ''].filter(Boolean).join(' · ');
  const detail = `${parts} · เหตุผล: ${approval.reason.trim()} · อนุมัติโดย ${a.approver.name}`;
  return {
    approval: { by: a.approver.id, name: a.approver.name, reason: approval.reason.trim(), detail, at: new Date().toISOString() },
    audit: [{ action: 'approve', object: 'discount', detail: `${what} · ${detail}` }],
  };
}

// ---------- cost / profit (data.cost only) ----------
/** Per line: FIFO unit cost per line unit, profit before VAT; and the document total. Null cost = no cost (service / free text). */
export function profitOf(lines: Pick<BuiltLine, 'qty' | 'unitPrice' | 'discount' | 'vat' | 'baseQty' | 'unitFactor'>[], vatMode: VatMode, billDisc: string, unitCosts: (string | null)[]) {
  const sell = netUnitPricesExVat(lines.map((l) => ({ ...coreLine(l), baseQty: l.baseQty })), vatMode, billDisc);
  let cost = d(0);
  let revenue = d(0);
  const rows = lines.map((l, i) => {
    const rev = d(sell[i] ?? 0).times(d(l.baseQty));
    revenue = revenue.plus(rev);
    const uc = unitCosts[i];
    if (uc == null) return { unitCost: null, profit: null };
    const c = d(uc).times(d(l.baseQty));
    cost = cost.plus(c);
    return { unitCost: money(d(uc).times(d(l.unitFactor))), profit: money(rev.minus(c)) };
  });
  const profit = revenue.minus(cost);
  return {
    lines: rows,
    total: { cost: money(cost), revenue: money(revenue), profit: money(profit), marginPct: revenue.gt(0) ? profit.div(revenue).times(100).toFixed(2) : '0.00' },
  };
}

/** Rebuilds minimal BuiltLines from stored line rows (product, unit factor) to price their cost. */
export async function storedLines(tx: Tx, rows: { product_id: string | null; unit_factor: string; qty: string; unit_price: string; discount: LineDiscount | null; vat: 'v7' | 'exempt'; name: string; unit_name: string; unit_idx: number | null }[]): Promise<BuiltLine[]> {
  const ids = [...new Set(rows.flatMap((r) => (r.product_id ? [r.product_id] : [])))];
  const products = ids.length ? await loadProducts(tx, ids) : new Map<string, ProductRow>();
  return rows.map((r) => ({
    product: r.product_id ? products.get(r.product_id) ?? null : null, unitIdx: r.unit_idx, name: r.name, unitName: r.unit_name, unitFactor: qty4(r.unit_factor),
    qty: qty4(r.qty), baseQty: qty4(d(r.qty).times(d(r.unit_factor))), unitPrice: qty4(r.unit_price), discount: r.discount, vat: r.vat,
  }));
}

// ---------- voids ----------
export interface VoidBody { reason: string; approverUserId?: string; pin?: string }

/** sales.voidDoc: 1 = allowed; 'apv' = another user's owner / manager PIN; 0 = forbidden. Returns the audit suffix. */
export async function authorizeVoid(tx: Tx, deps: Deps, ctx: Ctx, body: VoidBody, what: string): Promise<string> {
  const p = can(ctx, 'sales.voidDoc');
  if (p === 1) return '';
  if (p === 'apv') {
    if (!body.approverUserId || !body.pin) throw E.forbidden('Voiding needs a manager or owner PIN', { need: 'approval' });
    const a = await verifyApproval(tx, deps.pool, ctx, { approverUserId: body.approverUserId, pin: body.pin }, approverRoles('sales.voidDoc'), `ยกเลิก ${what}`);
    if (!a.ok) throw E.forbidden('Void approval rejected', { approvalError: a.reason });
    return ` · อนุมัติโดย ${a.approver.name}`;
  }
  throw E.forbidden('Permission sales.voidDoc is required');
}

/** Owner only (REQ-M09-06): the owner himself or the owner's PIN. */
export async function requireOwner(tx: Tx, deps: Deps, ctx: Ctx, approval: Approval | undefined, what: string): Promise<string> {
  if (ctx.role === 'owner') return ctx.name;
  if (!approval) throw E.forbidden(`${what} needs the owner's approval`, { need: 'ownerApproval' });
  const a = await verifyApproval(tx, deps.pool, ctx, approval, ['owner'], what);
  if (!a.ok) throw E.forbidden('Owner approval rejected', { approvalError: a.reason });
  return a.approver.name;
}

export const voidedJson = (r: { status: string; void_by_name?: string | null; void_at: Date | null; void_reason: string | null }) =>
  r.status === 'void' && r.void_at ? { by: r.void_by_name ?? '', at: r.void_at.toISOString(), reason: r.void_reason ?? '' } : null;

/** Value share of a source line for `qty` of `lineQty`, the last share taking the exact remainder. */
export function share(total: string, qty: string, lineQty: string, alreadyQty: string, alreadyValue: string): string {
  if (d(alreadyQty).plus(d(qty)).gte(d(lineQty))) return money(d(total).minus(d(alreadyValue)));
  return money(d(total).times(d(qty)).div(d(lineQty)));
}

/** Runs queries one after another on the same transaction client (pg does not allow concurrent queries on one client). */
export async function inSeq<T extends (() => Promise<unknown>)[]>(fns: [...T]): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const out: unknown[] = [];
  for (const f of fns) out.push(await f());
  return out as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}
