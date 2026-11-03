/**
 * BR-05 price resolution and the POS pricing extension (M15 promos, bundles; REQ-M03-07 price lists).
 *
 * Other modules (group A quotations / sales orders) call:
 *   priceFromLists(tx, customerId, productId, unitIdx, qty, date)   → the price-list step of BR-05 (or null)
 *   resolveSalePrice(tx, { ... quotationPrice })                     → the full BR-05 order incl. a valid quotation price
 */
import type { Tx } from '@erp/db';
import type { PosPricing } from '@erp/contracts';
import {
  bundleAlloc, bundleNormalPrice, bundleSetsAvailable, d, listPriceForDoc, money, pickRetailListPrice, promoUnitPrice, qty4, resolvePrice,
  type LineVat, type PriceListEntry, type PriceResolution, type VatMode,
} from '@erp/core';
import { can, type Ctx, type Deps } from '../../lib/context';
import { E, isUuid } from '../../lib/errors';
import { loadProducts, unitOf, type ProductRow } from '../../services/master';
import { onHand, posVatMode, posWarehouseId } from './common';
import { livePromos, type PromoRow } from './promos';

interface EntryRow { product_id: string; source: 'customer' | 'group'; unit_idx: number; min_qty: string; price: string; vat_included: boolean; list_id: string; list_name: string }

/** Active, date-valid price-list rows of a customer (own lists + their group's lists) for some products (null = all). */
async function entryRows(tx: Tx, customerId: string, productIds: string[] | null, date: string): Promise<EntryRow[]> {
  if (!isUuid(customerId)) throw E.validation('Unknown customer');
  const r = await tx.query<EntryRow>(
    `select i.product_id, case when l.customer_id is not null then 'customer' else 'group' end source, i.unit_idx, i.min_qty::text, i.price::text,
            l.vat_included, l.id list_id, l.name list_name
       from retail_price_list_items i join retail_price_lists l on l.id = i.list_id
       join customers c on c.id = $1
      where i.active and l.active and (l.customer_id = c.id or l.customer_group = c.grp)
        and (l.valid_from is null or l.valid_from <= $2::date) and (l.valid_to is null or l.valid_to >= $2::date)
        and ($3::uuid[] is null or i.product_id = any($3::uuid[]))
      order by i.product_id, l.created_at`,
    [customerId, date, productIds],
  );
  return r.rows;
}

const toEntries = (rows: EntryRow[], docMode: VatMode, vatOf: (pid: string) => LineVat): (PriceListEntry & { productId: string; listName: string })[] =>
  rows.map((r) => ({ productId: r.product_id, source: r.source, unitIdx: r.unit_idx, minQty: r.min_qty, price: listPriceForDoc(r.price, r.vat_included, docMode, vatOf(r.product_id)), listName: r.list_name }));

/**
 * BR-05 price-list step for ONE product line: the customer's own list, else their customer-group list with the largest
 * qty break ≤ qty, valid on `date`. Returns the price exactly as stored in the list plus whether it includes VAT;
 * convert it to your document's basis with core `listPriceForDoc(price, vatIncluded, docVatMode, product.vat)`.
 * null when no list applies (fall back to the retail price).
 */
export async function priceFromLists(tx: Tx, customerId: string, productId: string, unitIdx: number, qty: string, date: string):
  Promise<{ price: string; vatIncluded: boolean; source: 'customer' | 'group'; listId: string; listName: string } | null> {
  if (!isUuid(productId)) throw E.validation('Unknown product');
  const rows = await entryRows(tx, customerId, [productId], date);
  const pick = pickRetailListPrice(rows.map((r) => ({ source: r.source, unitIdx: r.unit_idx, minQty: r.min_qty, price: r.price })), unitIdx, qty);
  if (!pick) return null;
  const row = rows.filter((r) => r.source === pick.source && r.unit_idx === unitIdx && d(r.min_qty).lte(d(qty)))
    .sort((a, b) => d(b.min_qty).comparedTo(d(a.min_qty)))[0]!;
  return { price: pick.price, vatIncluded: row.vat_included, source: pick.source, listId: row.list_id, listName: row.list_name };
}

/** Unit list (retail) price exactly as POS computes it: the unit's own price, else base price × factor. */
export const unitRetailPrice = (p: ProductRow, unitIdx: number): string => {
  const u = unitOf(p, unitIdx);
  return money(u.price != null ? d(u.price) : d(p.price).times(d(u.factor)));
};

/** Live discount promo per product (one by the clash rule; the cheapest if data predates it). */
function discByProduct(promos: PromoRow[], p: ProductRow, unitIdx: number): { promo: PromoRow; price: string } | null {
  let best: { promo: PromoRow; price: string } | null = null;
  for (const pr of promos) {
    if (pr.kind !== 'disc' || !pr.items.some((i) => i.productId === p.id)) continue;
    const price = promoUnitPrice(pr.mode!, pr.value!, unitRetailPrice(p, unitIdx), unitOf(p, unitIdx).factor);
    if (!best || d(price).lt(d(best.price))) best = { promo: pr, price };
  }
  return best;
}

/**
 * Full BR-05 order for one line: valid quotation price (passed in by the caller, group A owns quotations) →
 * customer list → customer-group list → retail, with a live promo of the channel applied when it is lower.
 */
export async function resolveSalePrice(tx: Tx, a: {
  customerId?: string | null; productId: string; unitIdx: number; qty: string; date: string; vatMode: VatMode; channel?: 'pos' | 'b2b'; quotationPrice?: string | null;
}): Promise<PriceResolution> {
  const p = (await loadProducts(tx, [a.productId])).get(a.productId)!;
  const retail = unitRetailPrice(p, a.unitIdx);
  let list: { price: string; source: 'customer' | 'group' } | null = null;
  if (a.customerId) {
    const l = await priceFromLists(tx, a.customerId, a.productId, a.unitIdx, a.qty, a.date);
    if (l) list = { price: listPriceForDoc(l.price, l.vatIncluded, a.vatMode, p.vat), source: l.source };
  }
  const promo = discByProduct(await livePromos(tx, a.date, a.channel ?? 'pos'), p, a.unitIdx);
  // A retail price list is VAT-inclusive at POS; for an ex-VAT document convert the retail / promo prices too.
  const conv = (x: string) => (a.vatMode === 'exc' ? listPriceForDoc(x, true, 'exc', p.vat) : x);
  return resolvePrice({ retail: conv(retail), quotation: a.quotationPrice ?? null, list, promo: promo ? { id: promo.promo.id, price: conv(promo.price) } : null });
}

// ---------- GET /api/pos/pricing ----------

export async function posPricing(tx: Tx, deps: Deps, ctx: Ctx, q: { warehouseId?: string; customerId?: string }): Promise<PosPricing> {
  if (![can(ctx, 'pos.sell'), can(ctx, 'promo.manage'), can(ctx, 'sales.doc')].some((v) => v === 1 || v === 'ro')) throw E.forbidden('Permission pos.sell is required');
  const today = deps.today();
  const wh = await posWarehouseId(tx, q.warehouseId);
  const promos = await livePromos(tx, today, 'pos');
  const bundleRows = promos.filter((p) => p.kind === 'bundle');
  const compIds = bundleRows.flatMap((b) => b.items.map((i) => i.productId));
  const products = compIds.length ? await loadProducts(tx, compIds) : new Map<string, ProductRow>();
  const have = await onHand(tx, wh, compIds);
  let customer: PosPricing['customer'] = null;
  let prices: PosPricing['prices'] = [];
  if (q.customerId) {
    const c = isUuid(q.customerId) ? (await tx.query<{ id: string; name: string; grp: string }>(`select id, name, grp from customers where id = $1`, [q.customerId])).rows[0] : undefined;
    if (!c) throw E.validation('Unknown customer');
    customer = { id: c.id, name: c.name, group: c.grp };
    const rows = await entryRows(tx, c.id, null, today);
    const vatOf = new Map((await tx.query<{ id: string; vat: LineVat }>(`select id, vat from products where id = any($1::uuid[])`, [[...new Set(rows.map((r) => r.product_id))]])).rows.map((r) => [r.id, r.vat]));
    const mode = await posVatMode(tx, ctx.tenantId);
    prices = toEntries(rows, mode, (pid) => vatOf.get(pid) ?? 'v7').map((e) => ({ productId: e.productId, source: e.source, unitIdx: e.unitIdx, minQty: qty4(e.minQty), price: money(e.price), listName: e.listName }));
  }
  const img = await tx.query<{ product_id: string; version: number }>(`select product_id, version from retail_product_images where data is not null`);
  return {
    today,
    promos: promos.filter((p) => p.kind === 'disc').map((p) => ({ id: p.id, code: p.code, name: p.name, mode: p.mode!, value: qty4(p.value!), productIds: p.items.map((i) => i.productId) })),
    bundles: bundleRows.map((b) => ({
      id: b.id, code: b.code, name: b.name, sku: b.sku, setPrice: money(b.set_price!),
      normalSetPrice: bundleNormalPrice(b.items.map((i) => ({ qtyPerSet: i.qtyPerSet ?? '0', normalPrice: products.get(i.productId)?.price ?? '0' }))),
      components: b.items.map((i) => {
        const p = products.get(i.productId)!;
        return { productId: p.id, name: p.name, unitName: p.units[0]!.name, qtyPerSet: qty4(i.qtyPerSet ?? '0'), normalPrice: money(p.price) };
      }),
      setsAvailable: bundleSetsAvailable(b.items.map((i) => ({ qtyPerSet: i.qtyPerSet ?? '0', have: products.get(i.productId)?.kind === 'stock' ? have.get(i.productId) ?? '0' : '1e9' }))),
    })),
    customer, prices,
    images: Object.fromEntries(img.rows.map((r) => [r.product_id, r.version])),
  };
}

// ---------- POS sale extension (called by services/sales.ts posSale) ----------

export interface RetailLinePrice {
  /** Price the line may carry without a price-change approval (promo / price list / retail). */
  expected: string;
  /** Retail unit price (also accepted without approval). */
  retail: string;
  source: 'retail' | 'customer' | 'group' | 'promo';
  promo: { id: string; name: string; belowCost: boolean } | null;
}
export interface RetailBundle {
  no: number; promo: { id: string; name: string; belowCost: boolean }; sets: string; setPrice: string;
  comps: { p: ProductRow; qtyPerSet: string; baseQty: string; amount: string }[];
}

/**
 * Prices POS lines and expands bundle sets for posSale (inside its transaction):
 * - each line: the expected price by BR-05 + the live POS promo; a line's promoId that is no longer live → CONFLICT;
 * - each bundle: must be a live POS bundle, whole sets; revenue split per component by bundleAlloc (BR-17).
 */
export async function retailPosPricing(
  tx: Tx, deps: Deps,
  req: { customerId: string | null; lines: { productId: string; unitIdx: number; qty: string; promoId?: string }[]; bundles: { promoId: string; sets: string }[] },
  products: Map<string, ProductRow>, vatMode: VatMode,
): Promise<{ lines: RetailLinePrice[]; bundles: RetailBundle[] }> {
  const today = deps.today();
  const needPromos = req.bundles.length > 0 || req.lines.length > 0;
  const promos = needPromos ? await livePromos(tx, today, 'pos') : [];
  const rows = req.customerId && req.lines.length ? await entryRows(tx, req.customerId, [...new Set(req.lines.map((l) => l.productId))], today) : [];
  const entries = toEntries(rows, vatMode, (pid) => products.get(pid)?.vat ?? 'v7');

  const lines = req.lines.map((l, i): RetailLinePrice => {
    const p = products.get(l.productId)!;
    if (l.promoId && !promos.some((x) => x.id === l.promoId && x.kind === 'disc')) {
      throw E.conflict(`Line ${i + 1}: the promotion is no longer running; reload prices`, { promoId: l.promoId, reason: 'PROMO_ENDED' });
    }
    const retail = unitRetailPrice(p, l.unitIdx);
    const list = pickRetailListPrice(entries.filter((e) => e.productId === p.id), l.unitIdx, l.qty);
    const disc = discByProduct(promos, p, l.unitIdx);
    const r = resolvePrice({ retail, list, promo: disc ? { id: disc.promo.id, price: disc.price } : null });
    return {
      expected: r.unitPrice, retail, source: r.source === 'quotation' ? 'retail' : r.source,
      promo: r.promoId && disc ? { id: disc.promo.id, name: disc.promo.name, belowCost: disc.promo.below_cost } : null,
    };
  });

  const seen = new Set<string>();
  const bundles: RetailBundle[] = [];
  for (const [bi, b] of req.bundles.entries()) {
    if (seen.has(b.promoId)) throw E.validation('The same bundle appears twice; change its number of sets instead');
    seen.add(b.promoId);
    const pr = promos.find((x) => x.id === b.promoId && x.kind === 'bundle');
    if (!pr) throw E.conflict('The bundle promotion is no longer running; reload prices', { promoId: b.promoId, reason: 'PROMO_ENDED' });
    if (!d(b.sets).gt(0) || !d(b.sets).isInteger()) throw E.validation(`Bundle ${pr.name}: sets must be a whole number > 0`);
    const comp = await loadProducts(tx, pr.items.map((i) => i.productId));
    const alloc = bundleAlloc(pr.items.map((i) => ({ productId: i.productId, qtyPerSet: i.qtyPerSet ?? '0', normalPrice: comp.get(i.productId)!.price })), b.sets, pr.set_price!);
    bundles.push({
      no: bi + 1, promo: { id: pr.id, name: pr.name, belowCost: pr.below_cost }, sets: qty4(b.sets), setPrice: money(pr.set_price!),
      comps: pr.items.map((it, k) => {
        const p = comp.get(it.productId)!;
        if (!p.active) throw E.validation(`Product ${p.sku} in bundle ${pr.name} is inactive`);
        return { p, qtyPerSet: qty4(it.qtyPerSet ?? '0'), baseQty: qty4(alloc[k]!.qty), amount: alloc[k]!.amount };
      }),
    });
  }
  return { lines, bundles };
}
