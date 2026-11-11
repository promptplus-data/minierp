/** Master data (M03): products, customers, vendors, warehouses. */
import type { Tx } from '@erp/db';
import type { Customer, PageQuery, Product, Vendor, Warehouse, WarehouseUpsert } from '@erp/contracts';
import { money, qty4 , searchTokens } from '@erp/core';
import { can, requirePerm, type Ctx } from '../lib/context';
import { writeAudit } from '../lib/audit';
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
  for (const w of searchTokens(q.q)) {
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

interface CustomerRow { id: string; code: string; name: string; tax_id: string | null; branch: string | null; phone: string | null; grp: Customer['group']; credit_limit: string; term: Customer['term']; address: string; note: string }
const toCustomer = (r: CustomerRow): Customer => ({
  id: r.id, code: r.code, name: r.name, taxId: r.tax_id, branch: r.branch, phone: r.phone, group: r.grp, creditLimit: money(r.credit_limit), term: r.term, address: r.address, note: r.note,
});
const CUSTOMER_COLS = `id, code, name, tax_id, branch, phone, grp, credit_limit::text, term, address, note`;

export async function listCustomers(tx: Tx, q: PageQuery) {
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    const i = params.length;
    where.push(`(name ilike $${i} or code ilike $${i} or coalesce(phone,'') ilike $${i} or regexp_replace(coalesce(phone,''),'[^0-9]','','g') ilike $${i} or coalesce(tax_id,'') ilike $${i} or address ilike $${i})`);
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

export async function getCustomer(tx: Tx, id: string): Promise<Customer> {
  if (!isUuid(id)) throw E.notFound('Customer not found');
  const r = await tx.query<CustomerRow>(`select ${CUSTOMER_COLS} from customers where id = $1`, [id]);
  if (!r.rows[0]) throw E.notFound('Customer not found');
  return toCustomer(r.rows[0]);
}

export async function createCustomer(tx: Tx, ctx: Ctx, c: Pick<Customer, 'name'> & Partial<Customer>): Promise<Customer> {
  let code = c.code;
  if (!code) {
    // C + 5 digits, next after the highest numeric code. Unique index catches the rare race (409).
    const r = await tx.query<{ n: number | null }>(`select max(substring(code from 2)::int) n from customers where code ~ '^C[0-9]{5}$'`);
    code = 'C' + String((r.rows[0]?.n ?? 0) + 1).padStart(5, '0');
  }
  const r = await tx.query<CustomerRow>(
    `insert into customers (tenant_id, code, name, tax_id, branch, phone, grp, credit_limit, term, address, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning ${CUSTOMER_COLS}`,
    [ctx.tenantId, code, c.name.trim(), c.taxId || null, c.branch || null, c.phone || null, c.group ?? 'retail', c.creditLimit ?? '0', JSON.stringify(c.term ?? { t: 'cash' }), c.address ?? '', c.note ?? ''],
  );
  return toCustomer(r.rows[0]!);
}

export async function listVendors(tx: Tx, q: PageQuery) {
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(name ilike $${params.length} or code ilike $${params.length} or coalesce(phone,'') ilike $${params.length} or coalesce(tax_id,'') ilike $${params.length})`);
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

/** Quick-create from the vendor picker. Code = V + 5 digits after the highest numeric code unless given (unique index → 409). */
export async function createVendor(tx: Tx, ctx: Ctx, v: { name: string; code?: string; taxId?: string | null; branch?: string | null; phone?: string | null; term?: { t: 'cash' } | { t: 'days'; x: number } }): Promise<Vendor> {
  let code = v.code?.trim();
  if (!code) {
    const r = await tx.query<{ n: number | null }>(`select max(substring(code from 2)::int) n from vendors where code ~ '^V[0-9]{5}$'`);
    code = 'V' + String((r.rows[0]?.n ?? 0) + 1).padStart(5, '0');
  }
  const r = await tx.query<{ id: string; code: string; name: string; tax_id: string | null; branch: string | null; phone: string | null }>(
    `insert into vendors (tenant_id, code, name, tax_id, branch, phone, term) values ($1,$2,$3,$4,$5,$6,$7) returning id, code, name, tax_id, branch, phone`,
    [ctx.tenantId, code, v.name.trim(), v.taxId || null, v.taxId ? v.branch?.trim() || 'สำนักงานใหญ่' : null, v.phone?.trim() || null, JSON.stringify(v.term ?? { t: 'cash' })],
  );
  const x = r.rows[0]!;
  return { id: x.id, code: x.code, name: x.name, taxId: x.tax_id, branch: x.branch, phone: x.phone };
}

interface WhRow { id: string; code: string; name: string; is_pos: boolean; active: boolean; kind: 'normal' | 'damaged'; is_system: boolean }
const WH_COLS = `id, code, name, is_pos, active, kind, is_system`;
const toWarehouse = (w: WhRow): Warehouse => ({ id: w.id, code: w.code, name: w.name, isPos: w.is_pos, active: w.active, kind: w.kind, system: w.is_system });

export async function listWarehouses(tx: Tx, q: PageQuery & { kind?: 'normal' | 'damaged' }) {
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.kind) {
    params.push(q.kind);
    where.push(`kind = $${params.length}`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(code, id) > ($${params.length - 1}, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<WhRow>(
    `select ${WH_COLS} from warehouses ${where.length ? 'where ' + where.join(' and ') : ''} order by code, id limit $${params.length}`,
    params,
  );
  return pageOf(r.rows, q.limit, (w) => [w.code, w.id], toWarehouse);
}

/**
 * An active warehouse. Damaged-goods warehouses (kind 'damaged') are refused unless `damaged: true`: only stock
 * moves that make sense for defective goods (transfer, issue / write-off, adjustment, count) opt in, so every
 * sale, delivery, invoice, receipt and production run can never draw from or put sellable goods into it.
 */
export async function requireWarehouse(tx: Tx, id: string | undefined, opts: { pos?: boolean; damaged?: boolean } = {}): Promise<WhRow> {
  if (!isUuid(id)) throw E.validation(`Unknown warehouse ${id ?? ''}`);
  const r = await tx.query<WhRow>(`select ${WH_COLS} from warehouses where id = $1`, [id]);
  const w = r.rows[0];
  if (!w || !w.active) throw E.validation(`Unknown warehouse ${id}`);
  if (opts.pos && !w.is_pos) throw E.validation(`Warehouse ${w.name} is not a POS warehouse`);
  if (w.kind === 'damaged' && !opts.damaged) throw E.validation(`${w.name} เป็นคลังสินค้าชำรุด ใช้ขายหรือรับสินค้าดีเข้าไม่ได้`, { reason: 'DAMAGED_WAREHOUSE' });
  return w;
}

const writeAuditFor = (tx: Tx, ctx: Ctx, action: string, object: string, ref: string, detail = '') => writeAudit(tx, ctx, [{ action, object, ref, detail }]);

const whStock = async (tx: Tx, id: string) =>
  (await tx.query<{ q: string }>(`select coalesce(sum(remaining), 0)::text q from stock_lots where warehouse_id = $1`, [id])).rows[0]!.q;

/** Rules shared by create and edit: a damaged-goods warehouse is never POS; the shop keeps an active sellable and an active POS warehouse. */
async function checkWarehouse(tx: Tx, next: WarehouseUpsert, id: string | null) {
  if (next.kind === 'damaged' && next.isPos) throw E.validation('คลังสินค้าชำรุดตั้งเป็นคลังหน้าร้าน (POS) ไม่ได้', { field: 'isPos' });
  const others = await tx.query<{ normal: number; pos: number }>(
    `select count(*) filter (where kind = 'normal')::int normal, count(*) filter (where kind = 'normal' and is_pos)::int pos
       from warehouses where active and ($1::uuid is null or id <> $1)`, [id]);
  const o = others.rows[0]!;
  const mine = next.active && next.kind === 'normal';
  if (o.normal + (mine ? 1 : 0) === 0) throw E.conflict('ร้านต้องมีคลังขายที่เปิดใช้อย่างน้อย 1 คลัง', { field: 'active' });
  if (o.pos + (mine && next.isPos ? 1 : 0) === 0) throw E.conflict('ร้านต้องมีคลังหน้าร้าน (POS) ที่เปิดใช้อย่างน้อย 1 คลัง', { field: 'isPos' });
}

const dupCode = (e: unknown, code: string) => {
  if ((e as { code?: string }).code === '23505') return E.conflict(`รหัสคลัง ${code} มีอยู่แล้ว`, { field: 'code' });
  return e;
};

export async function createWarehouse(tx: Tx, ctx: Ctx, w: WarehouseUpsert): Promise<Warehouse> {
  requirePerm(ctx, 'sys.settings');
  await checkWarehouse(tx, w, null);
  try {
    await tx.query('savepoint wh_ins');
    const r = await tx.query<WhRow>(`insert into warehouses (tenant_id, code, name, is_pos, kind, active) values ($1,$2,$3,$4,$5,$6) returning ${WH_COLS}`,
      [ctx.tenantId, w.code, w.name, w.isPos, w.kind, w.active]);
    await tx.query('release savepoint wh_ins');
    await writeAuditFor(tx, ctx, 'create', 'warehouse', w.code, `${w.name} · ${w.kind === 'damaged' ? 'คลังสินค้าชำรุด' : w.isPos ? 'คลังหน้าร้าน' : 'คลังสินค้า'}`);
    return toWarehouse(r.rows[0]!);
  } catch (e) {
    await tx.query('rollback to savepoint wh_ins');
    throw dupCode(e, w.code);
  }
}

export async function updateWarehouse(tx: Tx, ctx: Ctx, id: string, patch: Partial<WarehouseUpsert>): Promise<Warehouse> {
  requirePerm(ctx, 'sys.settings');
  if (!isUuid(id)) throw E.notFound('Warehouse not found');
  const cur = (await tx.query<WhRow>(`select ${WH_COLS} from warehouses where id = $1 for update`, [id])).rows[0];
  if (!cur) throw E.notFound('Warehouse not found');
  const next: WarehouseUpsert = { code: patch.code ?? cur.code, name: patch.name ?? cur.name, isPos: patch.isPos ?? cur.is_pos, kind: patch.kind ?? cur.kind, active: patch.active ?? cur.active };
  const left = await whStock(tx, id);
  if (next.kind !== cur.kind && Number(left) !== 0) throw E.conflict(`เปลี่ยนประเภทคลังไม่ได้ เพราะยังมีสินค้าคงเหลือ ${left} หน่วย ให้โอนออกก่อน`, { field: 'kind' });
  if (!next.active && cur.active && Number(left) !== 0) throw E.conflict(`ปิดคลังไม่ได้ เพราะยังมีสินค้าคงเหลือ ${left} หน่วย ให้โอนออกก่อน`, { field: 'active' });
  if (cur.is_system && next.kind !== 'damaged') throw E.conflict('คลังสินค้าชำรุดที่ระบบสร้างเปลี่ยนประเภทไม่ได้', { field: 'kind' });
  await checkWarehouse(tx, next, id);
  try {
    await tx.query('savepoint wh_upd');
    const r = await tx.query<WhRow>(`update warehouses set code = $2, name = $3, is_pos = $4, kind = $5, active = $6 where id = $1 returning ${WH_COLS}`,
      [id, next.code, next.name, next.isPos, next.kind, next.active]);
    await tx.query('release savepoint wh_upd');
    const TH: Record<keyof WarehouseUpsert, string> = { code: 'รหัส', name: 'ชื่อ', isPos: 'POS', kind: 'ประเภท', active: 'เปิดใช้' };
    const was: WarehouseUpsert = { code: cur.code, name: cur.name, isPos: cur.is_pos, kind: cur.kind, active: cur.active };
    const diff = (Object.keys(TH) as (keyof WarehouseUpsert)[]).filter((k) => was[k] !== next[k]).map((k) => `${TH[k]}: ${String(was[k])} → ${String(next[k])}`);
    if (diff.length) await writeAuditFor(tx, ctx, 'update', 'warehouse', next.code, diff.join(' · '));
    return toWarehouse(r.rows[0]!);
  } catch (e) {
    await tx.query('rollback to savepoint wh_upd');
    throw dupCode(e, next.code);
  }
}

/** The default sellable warehouse: back store first (non-POS), then the POS one; never a damaged-goods warehouse. */
export async function defaultSellableWarehouse(tx: Tx): Promise<string | null> {
  const r = await tx.query<{ id: string }>(`select id from warehouses where active and kind = 'normal' order by is_pos, code limit 1`);
  return r.rows[0]?.id ?? null;
}

export const DAMAGED_WAREHOUSE_NAME = 'คลังสินค้าชำรุด';

/**
 * The shop's damaged-goods warehouse; created on first use (system-created, audited by the caller's document).
 * Prefers an active damaged warehouse the shop made itself, then the system one (re-activated if it was closed).
 * Concurrent first damaged returns race on warehouses_tenant_system_damaged; the loser re-reads the winner's row.
 */
export async function damagedWarehouse(tx: Tx, ctx: Ctx): Promise<{ wh: WhRow; created: boolean }> {
  const find = async () => (await tx.query<WhRow>(
    `select ${WH_COLS} from warehouses where kind = 'damaged' and (active or is_system) order by active desc, is_system, code limit 1`)).rows[0];
  const have = await find();
  if (have) {
    if (!have.active) await tx.query(`update warehouses set active = true where id = $1`, [have.id]);
    return { wh: { ...have, active: true }, created: false };
  }
  const codes = new Set((await tx.query<{ code: string }>(`select code from warehouses where code like 'DMG%'`)).rows.map((x) => x.code));
  let code = 'DMG';
  for (let i = 2; codes.has(code); i++) code = `DMG${i}`;
  const ins = await tx.query<WhRow>(
    `insert into warehouses (tenant_id, code, name, is_pos, kind, is_system) values ($1,$2,$3,false,'damaged',true)
     on conflict do nothing returning ${WH_COLS}`,
    [ctx.tenantId, code, DAMAGED_WAREHOUSE_NAME],
  );
  if (ins.rows[0]) return { wh: ins.rows[0], created: true };
  return { wh: (await find())!, created: false };
}
