/** REQ-M03-07 / BR-05 price lists: per customer or per customer group, qty breaks, validity dates, VAT basis. */
import type { Tx } from '@erp/db';
import type { PriceList } from '@erp/contracts';
import { z } from 'zod';
import { PriceListInput, PriceListUpdate } from '@erp/contracts';
import { money, qty4 , searchTokens } from '@erp/core';
import { writeAudit } from '../../lib/audit';
import { requirePerm, type Ctx } from '../../lib/context';
import { E, isUuid } from '../../lib/errors';
import { decodeCursor, likeEscape, pageOf } from '../../lib/paging';
import { loadProducts, unitOf } from '../../services/master';
import { unitRetailPrice } from './pricing';

const GROUP_TH: Record<string, string> = { retail: 'ปลีก', whole: 'ขายส่ง', contr: 'ผู้รับเหมา' };

interface Row {
  id: string; name: string; customer_id: string | null; customer_name: string | null; customer_group: PriceList['customerGroup']; vat_included: boolean;
  valid_from: string | null; valid_to: string | null; active: boolean; item_count: number; created_by: string; created_at: Date; note: string;
}
const SELECT = `select l.id, l.name, l.customer_id, c.name customer_name, l.customer_group, l.vat_included, l.valid_from, l.valid_to, l.active,
    (select count(*)::int from retail_price_list_items i where i.list_id = l.id and i.active) item_count, u.name created_by, l.created_at, l.note
  from retail_price_lists l join users u on u.id = l.created_by left join customers c on c.id = l.customer_id`;
const toList = (r: Row): PriceList => ({
  id: r.id, name: r.name, customer: r.customer_id ? { id: r.customer_id, name: r.customer_name ?? '' } : null, customerGroup: r.customer_group,
  vatIncluded: r.vat_included, validFrom: r.valid_from, validTo: r.valid_to, active: r.active, itemCount: r.item_count,
  createdBy: r.created_by, createdAt: r.created_at.toISOString(), note: r.note,
});

export async function listPriceLists(tx: Tx, ctx: Ctx, q: { q?: string; limit: number; cursor?: string }) {
  requirePerm(ctx, 'data.master', { readOnly: true });
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(l.name ilike $${params.length} or coalesce(c.name,'') ilike $${params.length} or coalesce(c.code,'') ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(l.created_at, l.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<Row>(`${SELECT} ${where.length ? 'where ' + where.join(' and ') : ''} order by l.created_at desc, l.id desc limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (x) => [x.created_at.toISOString(), x.id], toList);
}

export async function getPriceList(tx: Tx, ctx: Ctx, id: string): Promise<PriceList> {
  requirePerm(ctx, 'data.master', { readOnly: true });
  if (!isUuid(id)) throw E.notFound('Price list not found');
  const r = await tx.query<Row>(`${SELECT} where l.id = $1`, [id]);
  if (!r.rows[0]) throw E.notFound('Price list not found');
  const items = await tx.query<{ product_id: string; unit_idx: number; min_qty: string; price: string }>(
    `select i.product_id, i.unit_idx, i.min_qty::text, i.price::text from retail_price_list_items i join products p on p.id = i.product_id
      where i.list_id = $1 and i.active order by p.sku, i.unit_idx, i.min_qty`,
    [id],
  );
  const products = items.rows.length ? await loadProducts(tx, items.rows.map((x) => x.product_id)) : new Map();
  return {
    ...toList(r.rows[0]),
    items: items.rows.map((x) => {
      const p = products.get(x.product_id)!;
      return {
        productId: p.id, name: p.name, sku: p.sku, unitIdx: x.unit_idx, unitName: p.units[x.unit_idx]?.name ?? '', minQty: qty4(x.min_qty), price: money(x.price),
        retailPrice: p.units[x.unit_idx] ? unitRetailPrice(p, x.unit_idx) : money(p.price),
      };
    }),
  };
}

type Input = z.infer<typeof PriceListInput>;

async function validate(tx: Tx, b: Partial<Input>): Promise<void> {
  if (b.validFrom && b.validTo && b.validTo < b.validFrom) throw E.validation('valid to must not be before valid from');
  if (b.customerId && !isUuid(b.customerId)) throw E.validation('Unknown customer');
  if (b.customerId && !(await tx.query(`select 1 from customers where id = $1`, [b.customerId])).rowCount) throw E.validation('Unknown customer');
  if (b.items?.length) {
    const products = await loadProducts(tx, b.items.map((i) => i.productId));
    const keys = new Set<string>();
    for (const i of b.items) {
      unitOf(products.get(i.productId)!, i.unitIdx);
      const k = `${i.productId}|${i.unitIdx}|${qty4(i.minQty)}`;
      if (keys.has(k)) throw E.validation('The same product, unit and qty break appears twice');
      keys.add(k);
    }
  }
}

async function writeItems(tx: Tx, ctx: Ctx, listId: string, items: Input['items']): Promise<void> {
  await tx.query(`update retail_price_list_items set active = false where list_id = $1`, [listId]);
  for (const i of items) {
    await tx.query(
      `insert into retail_price_list_items (tenant_id, list_id, product_id, unit_idx, min_qty, price) values ($1,$2,$3,$4,$5,$6)
       on conflict (list_id, product_id, unit_idx, min_qty) do update set price = excluded.price, active = true`,
      [ctx.tenantId, listId, i.productId, i.unitIdx, i.minQty, i.price],
    );
  }
}

const target = (b: { customerId?: string | null; customerGroup?: string | null }, customerName?: string) =>
  b.customerId ? `ลูกค้า ${customerName ?? b.customerId}` : `กลุ่ม ${GROUP_TH[b.customerGroup ?? ''] ?? b.customerGroup}`;

export async function createPriceList(tx: Tx, ctx: Ctx, b: Input): Promise<PriceList> {
  requirePerm(ctx, 'data.master');
  if (!b.customerId === !b.customerGroup) throw E.validation('A price list is for one customer or one customer group');
  await validate(tx, b);
  const r = await tx.query<{ id: string }>(
    `insert into retail_price_lists (tenant_id, name, customer_id, customer_group, vat_included, valid_from, valid_to, active, created_by, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [ctx.tenantId, b.name, b.customerId ?? null, b.customerId ? null : b.customerGroup, b.vatIncluded, b.validFrom ?? null, b.validTo ?? null, b.active, ctx.userId, b.note?.trim() ?? ''],
  );
  await writeItems(tx, ctx, r.rows[0]!.id, b.items);
  const out = await getPriceList(tx, ctx, r.rows[0]!.id);
  await writeAudit(tx, ctx, [{ action: 'create', object: 'price-list', ref: b.name, detail: `${target(b, out.customer?.name)} · ${b.items.length} รายการ · ${b.vatIncluded ? 'รวม VAT' : 'ไม่รวม VAT'}${b.validFrom || b.validTo ? ` · ${b.validFrom ?? '…'}–${b.validTo ?? '…'}` : ''}` }]);
  return out;
}

export async function updatePriceList(tx: Tx, ctx: Ctx, id: string, b: z.infer<typeof PriceListUpdate>): Promise<PriceList> {
  requirePerm(ctx, 'data.master');
  const before = await getPriceList(tx, ctx, id);
  await tx.query(`select id from retail_price_lists where id = $1 for update`, [id]);
  const next = {
    name: b.name ?? before.name, customerId: b.customerId !== undefined ? b.customerId : before.customer?.id ?? null,
    customerGroup: b.customerGroup !== undefined ? b.customerGroup : before.customerGroup,
    vatIncluded: b.vatIncluded ?? before.vatIncluded, validFrom: b.validFrom !== undefined ? b.validFrom : before.validFrom,
    validTo: b.validTo !== undefined ? b.validTo : before.validTo, active: b.active ?? before.active,
    note: b.note !== undefined ? b.note.trim() : before.note,
  };
  if (b.customerId) next.customerGroup = null;
  if (b.customerGroup) next.customerId = null;
  if (!next.customerId === !next.customerGroup) throw E.validation('A price list is for one customer or one customer group');
  await validate(tx, { ...next, items: b.items });
  await tx.query(
    `update retail_price_lists set name = $2, customer_id = $3, customer_group = $4, vat_included = $5, valid_from = $6, valid_to = $7, active = $8, note = $9, updated_at = now() where id = $1`,
    [id, next.name, next.customerId, next.customerGroup, next.vatIncluded, next.validFrom, next.validTo, next.active, next.note],
  );
  if (b.items) await writeItems(tx, ctx, id, b.items);
  const out = await getPriceList(tx, ctx, id);
  const diffs: string[] = [];
  const diff = (label: string, a: unknown, c: unknown) => { if (String(a ?? '') !== String(c ?? '')) diffs.push(`${label}: ${a ?? '-'} → ${c ?? '-'}`); };
  diff('ชื่อ', before.name, out.name);
  diff('หมายเหตุ', before.note, out.note);
  diff('ใช้กับ', target({ customerId: before.customer?.id, customerGroup: before.customerGroup }, before.customer?.name), target({ customerId: out.customer?.id, customerGroup: out.customerGroup }, out.customer?.name));
  diff('ช่วง', `${before.validFrom ?? '…'}–${before.validTo ?? '…'}`, `${out.validFrom ?? '…'}–${out.validTo ?? '…'}`);
  diff('VAT', before.vatIncluded ? 'รวม' : 'ไม่รวม', out.vatIncluded ? 'รวม' : 'ไม่รวม');
  diff('สถานะ', before.active ? 'ใช้งาน' : 'ปิด', out.active ? 'ใช้งาน' : 'ปิด');
  if (b.items) {
    const fmt = (x: PriceList) => (x.items ?? []).map((i) => `${i.sku}#${i.unitIdx}≥${i.minQty}@${i.price}`).join(',');
    if (fmt(before) !== fmt(out)) diffs.push(`รายการราคา ${before.itemCount} → ${out.itemCount}`);
  }
  await writeAudit(tx, ctx, [{ action: 'update', object: 'price-list', ref: out.name, detail: diffs.join(' · ') || 'ไม่มีการเปลี่ยนแปลง' }]);
  return out;
}
