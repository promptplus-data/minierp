/**
 * BR-05 price resolution for B2B documents, the same order as POS (modules/retail/pricing.ts):
 *   0. sales orders only: price on a quotation of this customer that is still valid (sent / accepted, not expired),
 *   1. the customer's own price list (sales price lists, then retail price lists),
 *   2. the customer group's price list, by quantity break,
 *   3. a live B2B promotion when it is lower than the list / retail price (core resolvePrice),
 *   4. retail price of the product / unit.
 * Retail and promo prices are VAT-inclusive (they are the POS prices); every price is returned in the document's
 * VAT basis. Price lists are master data: maintained with data.master, read with sales.doc.
 */
import type { Tx } from '@erp/db';
import type { SalesPageQuery, SalesPriceList, SalesPriceListReq, SalesPriceListSummary, SalesPriceSource } from '@erp/contracts';
import { d, listValidOn, money, pickListPrice, promoUnitPrice, qty4, resolvePrice as coreResolve, type PriceListItem, type VatMode } from '@erp/core';
import { writeAudit } from '../../lib/audit';
import { requirePerm, type Ctx } from '../../lib/context';
import { E, isUuid } from '../../lib/errors';
import { loadProducts, unitOf, type ProductRow } from '../../services/master';
import { priceFromLists, unitRetailPrice } from '../retail/pricing';
import { livePromos, type PromoRow } from '../retail/promos';
import { pageNewest } from './common';

export interface B2bPrice {
  /** Price per unit of `unitIdx` in the document's VAT basis. */
  unitPrice: string;
  source: SalesPriceSource;
  /** Quotation no / price list code / promo code, if any. */
  ref: string | null;
  /** Retail price of the unit in the document's VAT basis. */
  retailPrice: string;
}

interface ListRow {
  id: string; code: string; name: string; kind: 'customer' | 'group'; customer_id: string | null; c_name: string | null; grp: 'retail' | 'whole' | 'contr' | null;
  vat_included: boolean; valid_from: string | null; valid_to: string | null; active: boolean; items: PriceListItem[]; updated_at: Date; created_at: Date;
}
const LIST_COLS = `x.id, x.code, x.name, x.kind, x.customer_id, c.name c_name, x.grp, x.vat_included, x.valid_from::text, x.valid_to::text, x.active, x.items, x.updated_at, x.created_at`;
const LIST_FROM = `sales_price_lists x left join customers c on c.id = x.customer_id`;

/** A price stored with or without VAT expressed in a document's VAT mode (mockup docUnitPrice). */
export function docUnitPrice(r: { price: string; vatIncluded: boolean }, mode: VatMode, lineVat: 'v7' | 'exempt'): string {
  if (lineVat !== 'v7' || mode === 'none') return money(r.price);
  if (mode === 'exc' && r.vatIncluded) return money(d(r.price).div('1.07'));
  if (mode === 'inc' && !r.vatIncluded) return money(d(r.price).times('1.07'));
  return money(r.price);
}

export interface PricerOpts { customerId: string | null | undefined; date: string; vatMode: VatMode; doc: 'quote' | 'order' }

/**
 * Prices many lines of one document: promos and the customer's sales price lists are read once.
 * `price(product, unitIdx, qty)` follows the BR-05 order above.
 */
export async function makePricer(tx: Tx, o: PricerOpts) {
  if (o.customerId && !isUuid(o.customerId)) throw E.validation('Unknown customer');
  const promos = await livePromos(tx, o.date, 'b2b');
  const lists = o.customerId
    ? (await tx.query<ListRow>(
      `select ${LIST_COLS} from ${LIST_FROM}
        where x.active and ((x.kind = 'customer' and x.customer_id = $1) or (x.kind = 'group' and x.grp = (select grp from customers where id = $1)))
        order by case x.kind when 'customer' then 0 else 1 end, x.updated_at desc`,
      [o.customerId],
    )).rows.filter((l) => listValidOn({ active: l.active, validFrom: l.valid_from, validTo: l.valid_to }, o.date))
    : [];

  const listHit = (kind: 'customer' | 'group', p: ProductRow, unitIdx: number, qty: string) => {
    for (const l of lists) {
      if (l.kind !== kind) continue;
      const it = pickListPrice(l.items, p.id, unitIdx, qty);
      if (it) return { price: docUnitPrice({ price: qty4(it.price), vatIncluded: l.vat_included }, o.vatMode, p.vat), ref: l.code };
    }
    return null;
  };
  const promoOf = (p: ProductRow, unitIdx: number) => {
    let best: { promo: PromoRow; price: string } | null = null;
    for (const pr of promos) {
      if (pr.kind !== 'disc' || !pr.items.some((i) => i.productId === p.id)) continue;
      const price = promoUnitPrice(pr.mode!, pr.value!, unitRetailPrice(p, unitIdx), unitOf(p, unitIdx).factor);
      if (!best || d(price).lt(d(best.price))) best = { promo: pr, price };
    }
    return best;
  };

  return async function price(p: ProductRow, unitIdx: number, qty: string): Promise<B2bPrice> {
    unitOf(p, unitIdx);
    const q = d(qty).gt(0) ? qty4(qty) : '1';
    const retailPrice = docUnitPrice({ price: unitRetailPrice(p, unitIdx), vatIncluded: true }, o.vatMode, p.vat);
    if (o.customerId && o.doc === 'order') {
      const hit = (await tx.query<{ no: string; unit_price: string; vat_mode: VatMode }>(
        `select q.no, l.unit_price::text, q.vat_mode from sales_quotes q
           join sales_quote_lines l on l.quote_id = q.id and l.revision = q.revision
          where q.customer_id = $1 and q.status in ('sent','accepted') and q.valid_until >= $2::date
            and l.product_id = $3 and l.unit_idx = $4
          order by q.date desc, q.created_at desc limit 1`,
        [o.customerId, o.date, p.id, unitIdx],
      )).rows[0];
      if (hit) return { unitPrice: docUnitPrice({ price: qty4(hit.unit_price), vatIncluded: hit.vat_mode !== 'exc' }, o.vatMode, p.vat), source: 'quote', ref: hit.no, retailPrice };
    }
    // customer list (sales lists, then retail lists), then group list (same order)
    let list: { price: string; source: 'customer' | 'group'; ref: string | null } | null = null;
    if (o.customerId) {
      const retailList = await priceFromLists(tx, o.customerId, p.id, unitIdx, q, o.date);
      const rl = retailList ? { price: docUnitPrice(retailList, o.vatMode, p.vat), ref: retailList.listName } : null;
      const c = listHit('customer', p, unitIdx, q) ?? (retailList?.source === 'customer' ? rl : null);
      const g = c ? null : listHit('group', p, unitIdx, q) ?? (retailList?.source === 'group' ? rl : null);
      if (c) list = { ...c, source: 'customer' };
      else if (g) list = { ...g, source: 'group' };
    }
    const promo = promoOf(p, unitIdx);
    const r = coreResolve({
      retail: retailPrice, list,
      promo: promo ? { id: promo.promo.id, price: docUnitPrice({ price: promo.price, vatIncluded: true }, o.vatMode, p.vat) } : null,
    });
    if (r.source === 'promo') return { unitPrice: r.unitPrice, source: 'promo', ref: promo!.promo.code, retailPrice };
    if (r.source === 'customer' || r.source === 'group') return { unitPrice: r.unitPrice, source: r.source === 'customer' ? 'customerList' : 'groupList', ref: list!.ref, retailPrice };
    return { unitPrice: r.unitPrice, source: 'retail', ref: null, retailPrice };
  };
}

/** One price (GET /api/sales/price). */
export async function resolveB2bPrice(tx: Tx, o: PricerOpts & { productId: string; unitIdx: number; qty: string }): Promise<B2bPrice> {
  if (!isUuid(o.productId)) throw E.validation('Unknown product');
  if (!d(o.qty).gt(0)) throw E.validation('qty must be > 0');
  const p = (await loadProducts(tx, [o.productId])).get(o.productId)!;
  return (await makePricer(tx, o))(p, o.unitIdx, o.qty);
}

// ---------- price list maintenance ----------
const GROUP_TH = { retail: 'ขายปลีก', whole: 'ขายส่ง', contr: 'ผู้รับเหมา' } as const;

async function listJson(tx: Tx, l: ListRow): Promise<SalesPriceList> {
  const ids = [...new Set(l.items.map((i) => i.productId))];
  const products = ids.length ? await loadProducts(tx, ids) : new Map();
  return {
    id: l.id, code: l.code, name: l.name, kind: l.kind, customer: l.customer_id ? { id: l.customer_id, name: l.c_name ?? '' } : null, group: l.grp,
    vatIncluded: l.vat_included, validFrom: l.valid_from, validTo: l.valid_to, active: l.active, updatedAt: l.updated_at.toISOString(),
    items: l.items.map((i) => {
      const p = products.get(i.productId);
      return { productId: i.productId, unitIdx: i.unitIdx, minQty: qty4(i.minQty), price: qty4(i.price), sku: p?.sku ?? '', name: p?.name ?? '', unitName: p?.units[i.unitIdx]?.name ?? '' };
    }),
  };
}

async function listRow(tx: Tx, id: string, forUpdate = false): Promise<ListRow> {
  if (!isUuid(id)) throw E.notFound('Price list not found');
  if (forUpdate) await tx.query(`select id from sales_price_lists where id = $1 for update`, [id]);
  const r = await tx.query<ListRow>(`select ${LIST_COLS} from ${LIST_FROM} where x.id = $1`, [id]);
  if (!r.rows[0]) throw E.notFound('Price list not found');
  return r.rows[0];
}

export async function getPriceList(tx: Tx, id: string): Promise<SalesPriceList> {
  return listJson(tx, await listRow(tx, id));
}

/** Validates the request: target (customer / group), dates, products and units, no duplicate (product, unit, minQty). */
async function prepareList(tx: Tx, req: SalesPriceListReq) {
  let customerId: string | null = null;
  let customerName = '';
  if (req.kind === 'customer') {
    if (!isUuid(req.customerId)) throw E.validation('A customer price list needs a customer');
    const c = await tx.query<{ name: string }>(`select name from customers where id = $1`, [req.customerId]);
    if (!c.rows[0]) throw E.validation('Unknown customer');
    customerId = req.customerId;
    customerName = c.rows[0].name;
  } else if (!req.group) throw E.validation('A group price list needs a customer group');
  if (req.validFrom && req.validTo && req.validTo < req.validFrom) throw E.validation('validTo must not be before validFrom');
  const products = req.items.length ? await loadProducts(tx, [...new Set(req.items.map((i) => i.productId))]) : new Map();
  const seen = new Set<string>();
  const items: PriceListItem[] = req.items.map((i, n) => {
    const p = products.get(i.productId)!;
    unitOf(p, i.unitIdx);
    const minQty = req.kind === 'customer' ? '0' : qty4(i.minQty);
    const key = `${i.productId}|${i.unitIdx}|${d(minQty).toFixed()}`;
    if (seen.has(key)) throw E.validation(`Item ${n + 1}: ${p.name} appears twice for the same unit and quantity`);
    seen.add(key);
    return { productId: i.productId, unitIdx: i.unitIdx, minQty, price: qty4(i.price) };
  });
  const names = items.map((i) => `${products.get(i.productId)!.name} ${products.get(i.productId)!.sku}`);
  return { customerId, items, search: [req.name, customerName, req.group ? GROUP_TH[req.group] : '', ...names].join(' ').toLowerCase() };
}

export async function createPriceList(tx: Tx, ctx: Ctx, req: SalesPriceListReq): Promise<SalesPriceList> {
  requirePerm(ctx, 'data.master');
  const x = await prepareList(tx, req);
  let code = req.code?.trim();
  if (!code) {
    const n = (await tx.query<{ n: number }>(`select count(*)::int n from sales_price_lists`)).rows[0]!.n;
    code = `PL${String(n + 1).padStart(3, '0')}`;
  }
  if ((await tx.query(`select 1 from sales_price_lists where code = $1`, [code])).rowCount) throw E.conflict(`Price list code ${code} is already used`);
  const id = (await tx.query<{ id: string }>(
    `insert into sales_price_lists (tenant_id, code, name, kind, customer_id, grp, vat_included, valid_from, valid_to, active, items, created_by, search_text)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [ctx.tenantId, code, req.name, req.kind, x.customerId, req.kind === 'group' ? req.group : null, req.vatIncluded, req.validFrom ?? null, req.validTo ?? null,
      req.active, JSON.stringify(x.items), ctx.userId, `${code.toLowerCase()} ${x.search}`],
  )).rows[0]!.id;
  await writeAudit(tx, ctx, [{ action: 'create', object: 'price-list', ref: code, detail: `${req.name} · ${x.items.length} รายการ` }]);
  return getPriceList(tx, id);
}

export async function updatePriceList(tx: Tx, ctx: Ctx, id: string, req: SalesPriceListReq): Promise<SalesPriceList> {
  requirePerm(ctx, 'data.master');
  const old = await listRow(tx, id, true);
  if (req.kind !== old.kind) throw E.validation('The kind of a price list cannot change');
  const x = await prepareList(tx, req);
  await tx.query(
    `update sales_price_lists set name = $2, customer_id = $3, grp = $4, vat_included = $5, valid_from = $6, valid_to = $7, active = $8, items = $9,
       updated_at = now(), search_text = $10 where id = $1`,
    [id, req.name, x.customerId, req.kind === 'group' ? req.group : null, req.vatIncluded, req.validFrom ?? null, req.validTo ?? null, req.active,
      JSON.stringify(x.items), `${old.code.toLowerCase()} ${x.search}`],
  );
  await writeAudit(tx, ctx, [{ action: 'update', object: 'price-list', ref: old.code, detail: `${req.name} · ${old.items.length} → ${x.items.length} รายการ${old.active !== req.active ? (req.active ? ' · เปิดใช้' : ' · ปิดใช้') : ''}` }]);
  return getPriceList(tx, id);
}

export async function listPriceLists(tx: Tx, q: SalesPageQuery) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.customerId) {
    if (!isUuid(q.customerId)) throw E.validation('Unknown customer');
    params.push(q.customerId);
    where.push(`x.customer_id = $${params.length}`);
  }
  if (q.status === 'active') where.push('x.active');
  return pageNewest<ListRow, SalesPriceListSummary>(tx, LIST_COLS, LIST_FROM, where, params, q, (l) => ({
    id: l.id, code: l.code, name: l.name, kind: l.kind, customer: l.customer_id ? { id: l.customer_id, name: l.c_name ?? '' } : null, group: l.grp,
    vatIncluded: l.vat_included, validFrom: l.valid_from, validTo: l.valid_to, active: l.active, updatedAt: l.updated_at.toISOString(), itemCount: l.items.length,
  }));
}
