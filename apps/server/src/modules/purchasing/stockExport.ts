/**
 * Excel / CSV export of the stock page (balance per product × warehouse) and of the stock ledger, for the products
 * and warehouses the user picked (none picked = all). Costs only for roles that may see them (data.cost).
 */
import { d } from '@erp/core';
import { STOCK_EXPORT_MAX_ROWS } from '@erp/contracts';
import type { Tx } from '@erp/db';
import { E, isUuid } from '../../lib/errors';
import { can, requirePerm, type Ctx } from '../../lib/context';
import { RESERVED_CTE } from '../../services/inventory';
import type { Sheet } from '../reports/files';
import { ledger } from './stockx';

const ids = (xs: readonly string[] | undefined, what: string) => {
  if (!xs?.length) return null;
  if (xs.some((x) => !isUuid(x))) throw E.validation(`Unknown ${what}`);
  return xs;
};
const tooMany = () => E.validation(`ข้อมูลเกิน ${STOCK_EXPORT_MAX_ROWS.toLocaleString('en-US')} แถว เลือกสินค้า คลัง หรือช่วงวันที่ให้แคบลง`, { reason: 'EXPORT_TOO_LARGE' });
const q4 = (v: string) => d(v).toDecimalPlaces(4).toFixed(4);
const WH_KIND: Record<string, string> = { normal: 'ปกติ', damaged: 'ชำรุด (ไม่นับเป็นสต็อกขาย)' };

/** "2026-11-18 09:56" in Thai time, sortable in Excel. */
export function bangkokTime(at: Date | string): string {
  const t = new Date(new Date(at).getTime() + 7 * 3600_000).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 16)}`;
}

export async function stockSheet(tx: Tx, ctx: Ctx, q: { productIds?: string[]; warehouseIds?: string[]; nonZero?: boolean }): Promise<Sheet> {
  requirePerm(ctx, 'inv.view', { readOnly: true });
  const cost = can(ctx, 'data.cost') === 1;
  const params: unknown[] = [];
  const where = [`p.kind = 'stock'`, `p.active`, `w.active`];
  const pids = ids(q.productIds, 'product');
  const wids = ids(q.warehouseIds, 'warehouse');
  if (pids) { params.push(pids); where.push(`p.id = any($${params.length}::uuid[])`); }
  if (wids) { params.push(wids); where.push(`w.id = any($${params.length}::uuid[])`); }
  params.push(STOCK_EXPORT_MAX_ROWS + 1);
  const r = await tx.query<{ sku: string; name: string; category: string; units: { name: string }[]; wcode: string; wname: string; wkind: string; qty: string; value: string; reserved: string }>(
    `with ${RESERVED_CTE}
     select p.sku, p.name, p.category, p.units, w.code wcode, w.name wname, w.kind wkind,
            coalesce(s.qty, 0)::text qty, coalesce(s.value, 0)::text value, coalesce(r.q, 0)::text reserved
       from products p cross join warehouses w
       left join (select l.product_id, l.warehouse_id, sum(l.remaining) qty, sum(l.remaining * l.unit_cost) value
                    from stock_lots l group by l.product_id, l.warehouse_id) s on s.product_id = p.id and s.warehouse_id = w.id
       left join reserved r on r.product_id = p.id and r.warehouse_id = w.id
      where ${where.join(' and ')} ${q.nonZero ? `and (coalesce(s.qty, 0) <> 0 or coalesce(r.q, 0) <> 0)` : ''}
      order by p.sku, w.code limit $${params.length}`, params);
  if (r.rows.length > STOCK_EXPORT_MAX_ROWS) throw tooMany();
  const head = ['รหัสสินค้า', 'ชื่อสินค้า', 'หมวด', 'หน่วยหลัก', 'รหัสคลัง', 'คลัง', 'ประเภทคลัง', 'คงเหลือ', 'จอง (ใบสั่งขาย)', 'พร้อมขาย', ...(cost ? ['ทุนเฉลี่ย/หน่วย', 'มูลค่าคงเหลือ'] : [])];
  return [head, ...r.rows.map((x) => {
    const damaged = x.wkind === 'damaged';
    const avail = damaged ? '0' : d(x.qty).minus(d(x.reserved)).toFixed();
    const unit = d(x.qty).isZero() ? '' : q4(d(x.value).div(d(x.qty)).toFixed());
    return [x.sku, x.name, x.category, x.units[0]?.name ?? '', x.wcode, x.wname, WH_KIND[x.wkind] ?? x.wkind, q4(x.qty), q4(x.reserved), q4(avail),
      ...(cost ? [unit, d(x.value).toDecimalPlaces(2).toFixed(2)] : [])];
  })];
}

const DOC_TH: Record<string, string> = { GR: 'รับสินค้า', PR: 'คืนผู้ขาย', TR: 'โอนคลัง', ADJ: 'เบิก / ปรับยอด', ABB: 'ขายหน้าร้าน', INV: 'ใบกำกับ', CN: 'รับคืน', OPEN: 'สต็อกเปิด', DO: 'ส่งของ', MO: 'ผลิต' };

export async function ledgerSheet(tx: Tx, ctx: Ctx, q: { productIds?: string[]; warehouseIds?: string[]; from?: string; to?: string }): Promise<Sheet> {
  const cost = can(ctx, 'data.cost') === 1;
  const pids = ids(q.productIds, 'product');
  const wids = ids(q.warehouseIds, 'warehouse');
  const whs = new Map((await tx.query<{ id: string; name: string }>(`select id, name from warehouses`)).rows.map((w) => [w.id, w.name]));
  const rows: Awaited<ReturnType<typeof ledger>>['items'] = [];
  let cursor: string | undefined;
  do {
    const page = await ledger(tx, ctx, { limit: 1000, cursor, from: q.from, to: q.to, productIds: pids ?? undefined, warehouseIds: wids ?? undefined });
    rows.push(...page.items);
    if (rows.length > STOCK_EXPORT_MAX_ROWS) throw tooMany();
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  rows.reverse(); // oldest first, as a ledger is read
  const head = ['วันที่เวลา', 'เลขที่เอกสาร', 'ประเภท', 'รหัสสินค้า', 'ชื่อสินค้า', 'คลัง', 'จำนวน', 'หน่วย', 'คงเหลือหลังรายการ', ...(cost ? ['ทุน/หน่วย'] : []), 'หมายเหตุ', 'โดย'];
  return [head, ...rows.map((m) => [bangkokTime(m.at), m.docNo, DOC_TH[m.docType] ?? m.docType, m.sku, m.name, whs.get(m.warehouseId) ?? '', q4(m.qty), m.unitName, q4(m.balance),
    ...(cost ? [m.unitCost == null ? '' : q4(m.unitCost)] : []), m.note, m.user])];
}
