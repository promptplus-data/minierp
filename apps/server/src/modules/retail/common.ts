/** Helpers shared by the retail module's services. */
import type { Tx } from '@erp/db';
import { d, qty4, takeLots, type VatMode } from '@erp/core';
import { E, isUuid } from '../../lib/errors';

/** The shop's POS price basis: VAT-registered shops sell VAT-inclusive, non-VAT shops without VAT. */
export async function posVatMode(tx: Tx, tenantId: string): Promise<VatMode> {
  const r = await tx.query<{ vat_registered: boolean }>(`select vat_registered from tenants where id = $1`, [tenantId]);
  return r.rows[0]?.vat_registered === false ? 'none' : 'inc';
}

/** The POS warehouse (or the given one when valid). */
export async function posWarehouseId(tx: Tx, id?: string): Promise<string | null> {
  if (id) {
    if (!isUuid(id)) throw E.validation('Unknown warehouse');
    const r = await tx.query<{ id: string }>(`select id from warehouses where id = $1 and active and kind = 'normal'`, [id]);
    if (!r.rows[0]) throw E.validation('Unknown warehouse');
    return r.rows[0].id;
  }
  const r = await tx.query<{ id: string }>(`select id from warehouses where active and kind = 'normal' order by is_pos desc, code limit 1`);
  return r.rows[0]?.id ?? null;
}

/**
 * FIFO unit cost the next issue of `qty` would take (no locks; for previews and promo checks, like the mockup
 * `saleCost`). Quantity beyond the lots is priced at the product's last known cost. null when there is no cost.
 */
export async function peekCosts(tx: Tx, warehouseId: string | null, needs: { productId: string; qty: string }[]): Promise<(string | null)[]> {
  if (!needs.length) return [];
  const ids = [...new Set(needs.map((n) => n.productId))];
  const lots = warehouseId
    ? (await tx.query<{ id: string; product_id: string; received_at: string; qty: string; unit_cost: string }>(
      `select id::text, product_id, to_char(received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') received_at, remaining::text qty, unit_cost::text
         from stock_lots where warehouse_id = $1 and product_id = any($2::uuid[]) and remaining > 0 order by product_id, received_at, id`,
      [warehouseId, ids],
    )).rows
    : [];
  const fallback = new Map((await tx.query<{ id: string; cost: string }>(`select id, cost::text from products where id = any($1::uuid[])`, [ids])).rows.map((r) => [r.id, r.cost]));
  return needs.map((n) => {
    const q = d(n.qty);
    const own = lots.filter((l) => l.product_id === n.productId).map((l) => ({ id: l.id, receivedAt: l.received_at, qty: l.qty, unitCost: l.unit_cost }));
    const have = own.reduce((a, l) => a.plus(d(l.qty)), d(0));
    const take = q.gt(have) ? have : q;
    const fb = d(fallback.get(n.productId) ?? 0);
    const last = own.length ? d(own[own.length - 1]!.unitCost) : fb;
    const { cogs } = takeLots(own, take);
    const value = d(cogs).plus(q.minus(take).times(last.gt(0) ? last : fb));
    if (!q.gt(0)) return own[0] ? qty4(own[0].unitCost) : fb.gt(0) ? qty4(fb) : null;
    const unit = value.div(q);
    return unit.gt(0) ? qty4(unit) : null;
  });
}

/** Stock on hand per product in one warehouse (base units). */
export async function onHand(tx: Tx, warehouseId: string | null, productIds: string[]): Promise<Map<string, string>> {
  if (!warehouseId || !productIds.length) return new Map();
  const r = await tx.query<{ product_id: string; q: string }>(
    `select product_id, sum(remaining)::text q from stock_lots where warehouse_id = $1 and product_id = any($2::uuid[]) group by product_id`,
    [warehouseId, [...new Set(productIds)]],
  );
  return new Map(r.rows.map((x) => [x.product_id, x.q]));
}

export const iso = (t: Date | null | undefined): string | null => (t ? t.toISOString() : null);

export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
