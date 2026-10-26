/** Master data (M03): products, customers, vendors, warehouses. */
import type { Tx } from '@erp/db';
import type { Customer, PageQuery, Product, Vendor, Warehouse } from '@erp/contracts';
import { money, qty4 } from '@erp/core';
import { can, type Ctx } from '../lib/context';
import { E, isUuid } from '../lib/errors';
import { decodeCursor, likeEscape, pageOf } from '../lib/paging';

export interface ProductUnitRow { name: string; factor: string; price?: string }
export interface ProductRow {
  id: string; sku: string; name: string; barcode: string | null; category: string; is_scg: boolean; kind: 'stock' | 'service';
  vat: 'v7' | 'exempt'; price: string; cost: string; units: ProductUnitRow[]; reorder_point: string; active: boolean;
}

export const PRODUCT_COLS = `id, sku, name, barcode, category, is_scg, kind, vat, price::text, cost::text, units, reorder_point::text, active`;

export function toProduct(r: ProductRow, ctx: Ctx): Product {
  return {
    id: r.id, sku: r.sku, name: r.name, barcode: r.barcode, category: r.category, isScg: r.is_scg, kind: r.kind, vat: r.vat,
    price: money(r.price),
    cost: can(ctx, 'data.cost') === 1 ? qty4(r.cost) : null, // hidden without data.cost
    units: r.units.map((u) => ({ name: u.name, factor: qty4(u.factor), ...(u.price != null ? { price: money(u.price) } : {}) })),
    reorderPoint: qty4(r.reorder_point), active: r.active,
  };
}

export async function loadProducts(tx: Tx, ids: string[]): Promise<Map<string, ProductRow>> {
  const bad = ids.find((i) => !isUuid(i));
  if (bad) throw E.validation(`Unknown product ${bad}`);
  const r = await tx.query<ProductRow>(`select ${PRODUCT_COLS} from products where id = any($1::uuid[])`, [[...new Set(ids)]]);
  const m = new Map(r.rows.map((p) => [p.id, p]));
  const missing = ids.find((i) => !m.has(i));
  if (missing) throw E.validation(`Unknown product ${missing}`);
  return m;
}

/** Unit at unitIdx of a product, or VALIDATION. */
export function unitOf(p: ProductRow, unitIdx: number): ProductUnitRow {
  const u = p.units[unitIdx];
  if (!u) throw E.validation(`Product ${p.sku} has no unit #${unitIdx}`);
  return u;
}

export async function listProducts(tx: Tx, ctx: Ctx, q: PageQuery & { all?: boolean }) {
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  if (!q.all) where.push('active');
  for (const w of (q.q ?? '').trim().split(/\s+/).filter(Boolean)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(name ilike $${params.length} or sku ilike $${params.length} or coalesce(barcode,'') ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(sku, id) > ($${params.length - 1}, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<ProductRow>(
    `select ${PRODUCT_COLS} from products ${where.length ? 'where ' + where.join(' and ') : ''} order by sku, id limit $${params.length}`,
    params,
  );
  return pageOf(r.rows, q.limit, (p) => [p.sku, p.id], (p) => toProduct(p, ctx));
}

export type ProductInput = Omit<Product, 'id' | 'cost' | 'barcode' | 'active'> & { barcode?: string | null; active?: boolean };

function checkUnits(units: Product['units']): void {
  if (units[0] && Number(units[0].factor) !== 1) throw E.validation('units[0] must be the base unit (factor 1)');
  if (units.some((u) => !(Number(u.factor) > 0))) throw E.validation('unit factor must be > 0');
}

export async function createProduct(tx: Tx, ctx: Ctx, p: ProductInput): Promise<Product> {
  checkUnits(p.units);
  const r = await tx.query<ProductRow>(
    `insert into products (tenant_id, sku, name, barcode, category, is_scg, kind, vat, price, units, reorder_point, active)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning ${PRODUCT_COLS}`,
    [ctx.tenantId, p.sku, p.name, p.barcode ?? null, p.category, p.isScg, p.kind, p.vat, p.price, JSON.stringify(p.units), p.reorderPoint, p.active ?? true],
  );
  return toProduct(r.rows[0]!, ctx);
}

export async function updateProduct(tx: Tx, ctx: Ctx, id: string, p: Partial<ProductInput>): Promise<Product> {
  if (!isUuid(id)) throw E.notFound('Product not found');
  if (p.units) checkUnits(p.units);
  if (p.kind) {
    // Flipping stock <-> service while lots remain would let sales bypass stock (BR-07) or strand the lots.
    const cur = await tx.query<{ kind: string; left: string | null }>(
      `select kind, (select sum(remaining) from stock_lots l where l.product_id = p.id)::text "left" from products p where id = $1`, [id]);
    const row = cur.rows[0];
    if (!row) throw E.notFound('Product not found');
    if (row.kind !== p.kind && row.left && Number(row.left) > 0) {
      throw E.conflict(`Cannot change ${row.kind} to ${p.kind} while ${row.left} units are in stock; issue or adjust them out first`, { remaining: row.left });
    }
  }
  const cols: Record<string, unknown> = {
    sku: p.sku, name: p.name, barcode: p.barcode, category: p.category, is_scg: p.isScg, kind: p.kind, vat: p.vat, price: p.price,
    units: p.units ? JSON.stringify(p.units) : undefined, reorder_point: p.reorderPoint, active: p.active,
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(cols)) {
    if (v === undefined) continue;
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  if (!sets.length) throw E.validation('Nothing to update');
  params.push(id);
  const r = await tx.query<ProductRow>(`update products set ${sets.join(', ')} where id = $${params.length} returning ${PRODUCT_COLS}`, params);
  if (!r.rows[0]) throw E.notFound('Product not found');
  return toProduct(r.rows[0], ctx);
}

interface CustomerRow { id: string; code: string; name: string; tax_id: string | null; branch: string | null; phone: string | null; grp: Customer['group']; credit_limit: string; term: Customer['term'] }
const toCustomer = (r: CustomerRow): Customer => ({
  id: r.id, code: r.code, name: r.name, taxId: r.tax_id, branch: r.branch, phone: r.phone, group: r.grp, creditLimit: money(r.credit_limit), term: r.term,
});
const CUSTOMER_COLS = `id, code, name, tax_id, branch, phone, grp, credit_limit::text, term`;

export async function listCustomers(tx: Tx, q: PageQuery) {
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  for (const w of (q.q ?? '').trim().split(/\s+/).filter(Boolean)) {
    params.push(`%${likeEscape(w)}%`);
    const i = params.length;
    where.push(`(name ilike $${i} or code ilike $${i} or coalesce(phone,'') ilike $${i} or coalesce(tax_id,'') ilike $${i})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(code, id) > ($${params.length - 1}, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<CustomerRow>(
    `select ${CUSTOMER_COLS} from customers ${where.length ? 'where ' + where.join(' and ') : ''} order by code, id limit $${params.length}`,
    params,
  );
  return pageOf(r.rows, q.limit, (c) => [c.code, c.id], toCustomer);
}

export async function createCustomer(tx: Tx, ctx: Ctx, c: Omit<Customer, 'id' | 'code' | 'taxId' | 'branch' | 'phone' | 'group' | 'creditLimit' | 'term'> & Partial<Customer>): Promise<Customer> {
  let code = c.code;
  if (!code) {
    // C + 5 digits, next after the highest numeric code. Unique index catches the rare race (409).
    const r = await tx.query<{ n: number | null }>(`select max(substring(code from 2)::int) n from customers where code ~ '^C[0-9]{5}$'`);
    code = 'C' + String((r.rows[0]?.n ?? 0) + 1).padStart(5, '0');
  }
  const r = await tx.query<CustomerRow>(
    `insert into customers (tenant_id, code, name, tax_id, branch, phone, grp, credit_limit, term) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning ${CUSTOMER_COLS}`,
    [ctx.tenantId, code, c.name, c.taxId ?? null, c.branch ?? null, c.phone ?? null, c.group ?? 'retail', c.creditLimit ?? '0', JSON.stringify(c.term ?? { t: 'cash' })],
  );
  return toCustomer(r.rows[0]!);
}

export async function listVendors(tx: Tx, q: PageQuery) {
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.q) {
    params.push(`%${likeEscape(q.q.trim())}%`);
    where.push(`(name ilike $1 or code ilike $1)`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(code, id) > ($${params.length - 1}, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<{ id: string; code: string; name: string; tax_id: string | null; branch: string | null; phone: string | null }>(
    `select id, code, name, tax_id, branch, phone from vendors ${where.length ? 'where ' + where.join(' and ') : ''} order by code, id limit $${params.length}`,
    params,
  );
  return pageOf(r.rows, q.limit, (v) => [v.code, v.id], (v): Vendor => ({ id: v.id, code: v.code, name: v.name, taxId: v.tax_id, branch: v.branch, phone: v.phone }));
}

export async function listWarehouses(tx: Tx, q: PageQuery) {
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  let where = '';
  if (cur) {
    params.push(cur[0], cur[1]);
    where = `where (code, id) > ($1, $2::uuid)`;
  }
  params.push(q.limit + 1);
  const r = await tx.query<{ id: string; code: string; name: string; is_pos: boolean; active: boolean }>(
    `select id, code, name, is_pos, active from warehouses ${where} order by code, id limit $${params.length}`,
    params,
  );
  return pageOf(r.rows, q.limit, (w) => [w.code, w.id], (w): Warehouse => ({ id: w.id, name: w.name, isPos: w.is_pos, active: w.active }));
}

export async function requireWarehouse(tx: Tx, id: string | undefined, opts: { pos?: boolean } = {}): Promise<{ id: string; code: string; name: string; is_pos: boolean }> {
  if (!isUuid(id)) throw E.validation(`Unknown warehouse ${id ?? ''}`);
  const r = await tx.query<{ id: string; code: string; name: string; is_pos: boolean; active: boolean }>(`select id, code, name, is_pos, active from warehouses where id = $1`, [id]);
  const w = r.rows[0];
  if (!w || !w.active) throw E.validation(`Unknown warehouse ${id}`);
  if (opts.pos && !w.is_pos) throw E.validation(`Warehouse ${w.name} is not a POS warehouse`);
  return w;
}
