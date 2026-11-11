/**
 * REQ-M11-02: stock on hand with FIFO value as of a date, slow movers, below reorder point.
 * Lot quantity as of the date = lot.remaining − Σ (ins − outs) of that lot's moves at or after the next day's
 * start (stock_move_lots × stock_moves.at), so value = Σ lot qty × lot cost exactly as FIFO kept it.
 */
import type { Tx } from '@erp/db';
import type { ReportStock, ReportStockQuery, ReportStockRow } from '@erp/contracts';
import { addDays, d, money, qty4 , searchTokens } from '@erp/core';
import { can, type Ctx, type Deps } from '../../lib/context';
import { E, isUuid } from '../../lib/errors';
import { likeEscape } from '../../lib/paging';
import { endOfDay, nextOffset, offsetOf } from './sources';

interface Row {
  product_id: string; sku: string; name: string; category: string; units: { name: string }[]; reorder_point: string;
  qty: string; value: string; last_out: string | null; first_in: string | null; low: boolean; slow: boolean;
  n: number; tq: string; tv: string; nlow: number; nslow: number; dq: string; dv: string; tdq: string; tdv: string;
}

export async function stockReport(tx: Tx, deps: Deps, ctx: Ctx, q: ReportStockQuery, all = false): Promise<ReportStock> {
  const asOf = q.asOf ?? deps.today();
  if (q.warehouseId && !isUuid(q.warehouseId)) throw E.validation('Unknown warehouse');
  const seeCost = can(ctx, 'data.cost') === 1;
  const slowFrom = addDays(asOf, -q.slowDays);
  // As of today (or later) is the live stock: no time cut, so it never depends on the clock vs the business date.
  const cut = asOf >= deps.today() ? null : endOfDay(asOf);
  const params: unknown[] = [cut, q.warehouseId ?? null, slowFrom, asOf];
  const where = [`p.kind = 'stock'`, `p.active`];
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(p.name ilike $${params.length} or p.sku ilike $${params.length})`);
  }
  const filter = q.only === 'low' ? 'where low' : q.only === 'slow' ? 'where slow' : '';
  const offset = all ? 0 : offsetOf(q.cursor);
  let limitSql = '';
  if (!all) {
    params.push(q.limit, offset);
    limitSql = `limit $${params.length - 1} offset $${params.length}`;
  }
  const r = await tx.query<Row>(
    `with after_cut as (
       select ml.lot_id, sum(case when m.qty < 0 then -ml.qty else ml.qty end) delta
         from stock_moves m join stock_move_lots ml on ml.move_id = m.id
        where $1::timestamptz is not null and m.at >= $1::timestamptz and ($2::uuid is null or m.warehouse_id = $2)
        group by ml.lot_id
     ),
     lot_q as (
       select l.product_id, l.unit_cost, l.received_at, l.remaining - coalesce(a.delta, 0) q,
              -- damaged-goods warehouses are reported apart unless the report is filtered to that warehouse
              (w.kind = 'damaged' and $2::uuid is null) dmg
         from stock_lots l left join after_cut a on a.lot_id = l.id join warehouses w on w.id = l.warehouse_id
        where ($2::uuid is null or l.warehouse_id = $2) and ($1::timestamptz is null or l.received_at < $1::timestamptz or l.created_at < $1::timestamptz)
     ),
     per as (
       select product_id, sum(q) filter (where not dmg) qty, sum(q * unit_cost) filter (where not dmg) value,
              min(received_at) filter (where q > 0 and not dmg) first_in,
              sum(q) filter (where dmg) dqty, sum(q * unit_cost) filter (where dmg) dvalue
         from lot_q group by product_id
     ),
     outs as (
       select m.product_id, max(coalesce(sd.date, st.date, (m.at at time zone 'Asia/Bangkok')::date)) last_out
         from stock_moves m left join docs sd on sd.id = m.doc_id left join stock_docs st on st.id = m.doc_id
        where m.qty < 0 and m.doc_type <> 'TR' and ($1::timestamptz is null or m.at < $1::timestamptz) and ($2::uuid is null or m.warehouse_id = $2)
          and coalesce(sd.status, 'active') = 'active'
        group by m.product_id
     ),
     agg as (
       select p.id product_id, p.sku, p.name, p.category, p.units, p.reorder_point,
              coalesce(per.qty, 0) qty, coalesce(per.value, 0) value, coalesce(per.dqty, 0) dq, coalesce(per.dvalue, 0) dv,
              o.last_out::text last_out,
              to_char(per.first_in at time zone 'Asia/Bangkok', 'YYYY-MM-DD') first_in,
              (p.reorder_point > 0 and coalesce(per.qty, 0) < p.reorder_point) low,
              (coalesce(per.qty, 0) > 0 and coalesce(o.last_out, (per.first_in at time zone 'Asia/Bangkok')::date, $4::date) < $3::date) slow
         from products p left join per on per.product_id = p.id left join outs o on o.product_id = p.id
        where ${where.join(' and ')}
     )
     select product_id, sku, name, category, units, reorder_point::text, qty::text, value::text, last_out, first_in, low, slow, dq::text, dv::text,
            (sum(dq) over ())::text tdq, (sum(dv) over ())::text tdv,
            count(*) over ()::int n, (sum(qty) over ())::text tq, (sum(value) over ())::text tv,
            (count(*) filter (where low) over ())::int nlow, (count(*) filter (where slow) over ())::int nslow
       from agg ${filter} order by sku ${limitSql}`,
    params,
  );
  // Totals when the page is empty (offset past the end or no match) still need the counts.
  const first = r.rows[0];
  const totals = first
    ? { products: first.n, qty: qty4(first.tq), value: seeCost ? money(first.tv) : null, low: first.nlow, slow: first.nslow, damagedQty: qty4(first.tdq), damagedValue: seeCost ? money(first.tdv) : null }
    : { products: 0, qty: '0', value: seeCost ? '0.00' : null, low: 0, slow: 0, damagedQty: '0', damagedValue: seeCost ? '0.00' : null };
  const idle = (x: Row) => {
    const since = x.last_out ?? x.first_in;
    return since ? Math.max(0, Math.round((Date.parse(asOf) - Date.parse(since)) / 86_400_000)) : null;
  };
  return {
    asOf, slowDays: q.slowDays, costVisible: seeCost, totals,
    nextCursor: all ? null : nextOffset(offset, q.limit, first?.n ?? 0),
    rows: r.rows.map((x): ReportStockRow => ({
      productId: x.product_id, sku: x.sku, name: x.name, category: x.category, unit: x.units[0]?.name ?? '',
      qty: qty4(x.qty), value: seeCost ? money(x.value) : null,
      avgCost: seeCost ? (d(x.qty).gt(0) ? qty4(d(x.value).div(d(x.qty))) : '0') : null,
      reorderPoint: qty4(x.reorder_point), lastOut: x.last_out, idleDays: idle(x), low: x.low, slow: x.slow,
      damagedQty: qty4(x.dq), damagedValue: seeCost ? money(x.dv) : null,
    })),
  };
}

export function stockSheet(r: ReportStock): (string | number)[][] {
  return [
    [`รายงานสต็อกคงเหลือ ณ ${r.asOf} (FIFO ตามล็อต) · ไม่เคลื่อนไหวเกิน ${r.slowDays} วัน`],
    ['รหัสสินค้า', 'ชื่อสินค้า', 'หมวด', 'หน่วย', 'คงเหลือ', ...(r.costVisible ? ['ทุนเฉลี่ย FIFO', 'มูลค่า'] : []), 'ชำรุด (คลังของเสีย)', ...(r.costVisible ? ['มูลค่าชำรุด'] : []), 'จุดสั่งซื้อ', 'ขาย/เบิกล่าสุด', 'ไม่เคลื่อนไหว (วัน)', 'สถานะ'],
    ...r.rows.map((x) => [x.sku, x.name, x.category, x.unit, x.qty, ...(r.costVisible ? [x.avgCost ?? '', x.value ?? ''] : []), x.damagedQty ?? '0', ...(r.costVisible ? [x.damagedValue ?? ''] : []), x.reorderPoint, x.lastOut ?? '', x.idleDays ?? '',
      [x.low ? 'ต่ำกว่าจุดสั่งซื้อ' : '', x.slow ? 'ไม่เคลื่อนไหว' : ''].filter(Boolean).join(' · ')]),
    ['รวม', `${r.totals.products} รายการ`, '', '', r.totals.qty, ...(r.costVisible ? ['', r.totals.value ?? ''] : []), r.totals.damagedQty ?? '0', ...(r.costVisible ? [r.totals.damagedValue ?? ''] : []), '', '', '', ''],
  ];
}
