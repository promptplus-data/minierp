/** REQ-M11-01: sales and gross profit by day / month / product / category / customer / seller / sale type. */
import type { Tx } from '@erp/db';
import type { ReportSales, ReportSalesBy, ReportSalesQuery, ReportSalesRow } from '@erp/contracts';
import { d, money, qty4, round2 } from '@erp/core';
import { can, type Ctx } from '../../lib/context';
import { likeEscape } from '../../lib/paging';
import { SALE_LINES_CTE, checkRange, nextOffset, offsetOf } from './sources';

export const SALE_TYPE_TH: Record<string, string> = { retail: 'ขายปลีก (หน้าร้าน)', whole: 'ขายส่ง / เงินเชื่อ', project: 'ขายโครงการ' };
export const BY_TH: Record<ReportSalesBy, string> = { day: 'วันที่', month: 'เดือน', product: 'สินค้า', category: 'หมวดสินค้า', customer: 'ลูกค้า', seller: 'พนักงานขาย', saleType: 'ประเภทการขาย' };

const GROUP: Record<ReportSalesBy, { key: string; label: string; sub: string; byValue: boolean }> = {
  day: { key: `sl.date::text`, label: `sl.date::text`, sub: `''`, byValue: false },
  month: { key: `to_char(sl.date, 'YYYY-MM')`, label: `to_char(sl.date, 'YYYY-MM')`, sub: `''`, byValue: false },
  product: { key: `sl.product_id::text`, label: `p.name`, sub: `p.sku`, byValue: true },
  category: { key: `coalesce(nullif(p.category, ''), '-')`, label: `coalesce(nullif(p.category, ''), 'ไม่ระบุหมวด')`, sub: `''`, byValue: true },
  customer: { key: `coalesce(sl.customer_id::text, '-')`, label: `coalesce(c.name, sl.customer_name)`, sub: `coalesce(c.code, '')`, byValue: true },
  seller: { key: `sl.created_by::text`, label: `u.name`, sub: `''`, byValue: true },
  saleType: { key: `sl.sale_type`, label: `sl.sale_type`, sub: `''`, byValue: true },
};

interface AggRow { k: string; label: string; sub: string; bills: number; returns: number; qty: string | null; net: string; vat: string; cogs: string }

function toRow(r: AggRow, by: ReportSalesBy | null, seeCost: boolean): ReportSalesRow {
  const net = round2(r.net ?? 0);
  const vat = round2(r.vat ?? 0);
  const cogs = round2(r.cogs ?? 0);
  const gp = net.minus(cogs);
  return {
    key: r.k, label: by === 'saleType' ? SALE_TYPE_TH[r.label] ?? r.label : r.label, sub: r.sub ?? '',
    bills: Number(r.bills), returns: Number(r.returns), qty: by === 'product' && r.qty != null ? qty4(r.qty) : null,
    net: money(net), vat: money(vat), total: money(net.plus(vat)),
    cogs: seeCost ? money(cogs) : null, gp: seeCost ? money(gp) : null,
    gpPct: seeCost && !net.isZero() ? money(gp.div(net).times(100)) : null,
  };
}

/** All rows when `all` (file download), otherwise one page. Totals always cover the whole period. */
export async function salesReport(tx: Tx, ctx: Ctx, q: ReportSalesQuery, all = false): Promise<ReportSales> {
  checkRange(q.from, q.to);
  const g = GROUP[q.by];
  const seeCost = can(ctx, 'data.cost') === 1;
  const params: unknown[] = [q.from, q.to, q.saleType ?? null];
  const where = [`($3::text is null or sl.sale_type = $3)`];
  for (const w of (q.q ?? '').trim().split(/\s+/).filter(Boolean)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(${g.label} ilike $${params.length} or ${g.sub} ilike $${params.length})`);
  }
  const joins = `left join products p on p.id = sl.product_id left join users u on u.id = sl.created_by left join customers c on c.id = sl.customer_id`;
  const agg = `count(distinct sl.doc_id) filter (where sl.type <> 'CN')::int bills, count(distinct sl.doc_id) filter (where sl.type = 'CN')::int returns,
    sum(sl.base_qty * sl.sgn)::text qty, sum(sl.ex * sl.sgn)::text net, sum(sl.lvat * sl.sgn)::text vat, sum(sl.cogs)::text cogs`;

  const offset = all ? 0 : offsetOf(q.cursor);
  const order = g.byValue ? `sum(sl.ex * sl.sgn) desc, 1` : `1`;
  const pageParams = [...params];
  let limitSql = '';
  if (!all) {
    pageParams.push(q.limit, offset);
    limitSql = `limit $${pageParams.length - 1} offset $${pageParams.length}`;
  }
  const rows = await tx.query<AggRow & { n: number }>(
    `with ${SALE_LINES_CTE}
     select ${g.key} k, max(${g.label}) label, max(${g.sub}) sub, ${agg}, count(*) over ()::int n
       from sl ${joins} where ${where.join(' and ')} group by 1 order by ${order} ${limitSql}`,
    pageParams,
  );
  const tot = await tx.query<AggRow>(
    `with ${SALE_LINES_CTE}
     select 'total' k, 'รวม' label, '' sub, ${agg} from sl ${joins} where ${where.join(' and ')}`,
    params,
  );
  const voided = await tx.query<{ n: number; t: string | null }>(
    `select count(*)::int n, sum(total)::text t from docs where status = 'void' and type in ('ABB','INV','RC') and date between $1::date and $2::date`,
    [q.from, q.to],
  );
  const n = rows.rows[0]?.n ?? 0;
  return {
    from: q.from, to: q.to, by: q.by,
    rows: rows.rows.map((r) => toRow(r, q.by, seeCost)),
    totals: { ...toRow(tot.rows[0]!, null, seeCost), qty: q.by === 'product' && tot.rows[0]!.qty != null ? qty4(tot.rows[0]!.qty) : null },
    nextCursor: all ? null : nextOffset(offset, q.limit, n),
    costVisible: seeCost,
    voided: { count: voided.rows[0]!.n, total: money(d(voided.rows[0]!.t ?? 0)) },
    sources: [{ key: 'docs', label: 'เอกสารขาย POS / ใบกำกับ / ใบลดหนี้', available: true, note: 'ใบแจ้งหนี้ขายส่ง (M08) และงานโครงการ (M09) จะเข้ารายงานเมื่อโมดูลพร้อม' }],
  };
}

export function salesSheet(r: ReportSales): (string | number)[][] {
  const head = [BY_TH[r.by], r.by === 'product' || r.by === 'customer' ? 'รหัส' : '', 'จำนวนบิล', 'ใบลดหนี้', ...(r.by === 'product' ? ['จำนวน (หน่วยหลัก)'] : []),
    'ยอดขายก่อน VAT', 'VAT', 'รวม', ...(r.costVisible ? ['ต้นทุนขาย (FIFO)', 'กำไรขั้นต้น', 'กำไร %'] : [])];
  const line = (x: ReportSalesRow) => [x.label, x.sub, x.bills, x.returns, ...(r.by === 'product' ? [x.qty ?? ''] : []), x.net, x.vat, x.total,
    ...(r.costVisible ? [x.cogs ?? '', x.gp ?? '', x.gpPct ?? ''] : [])];
  return [
    [`รายงานยอดขายและกำไรขั้นต้น ${r.from} ถึง ${r.to} แยกตาม${BY_TH[r.by]}`],
    head,
    ...r.rows.map(line),
    line(r.totals),
  ];
}
