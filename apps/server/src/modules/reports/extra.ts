/**
 * REQ-M11-06 internal cost, REQ-M11-07 promotion P&L, REQ-M11-05 SCG Family coupons (cloud only).
 * Payroll comes from group D's hr_labour_cost_monthly view, promotions from group C's promoPnl; coupons (M13) have no source yet.
 */
import type { Tx } from '@erp/db';
import type { ReportCostLine, ReportCosts } from '@erp/contracts';
import { d, money, sum } from '@erp/core';
import type { z } from 'zod';
import { can, type Ctx, type Deps } from '../../lib/context';
import { promoPnl } from '../retail/promos';
import { E } from '../../lib/errors';
import { SALE_LINES_CTE, Sources, checkRange, monthRange } from './sources';

type CostLine = z.infer<typeof ReportCostLine>;

/** Σ ex-VAT sales and ledger COGS of a period (live documents, net of credit notes). */
export async function salesTotals(tx: Tx, from: string, to: string): Promise<{ net: string; cogs: string; vat: string }> {
  const r = await tx.query<{ net: string | null; cogs: string | null; vat: string | null }>(
    `with ${SALE_LINES_CTE} select sum(ex * sgn)::text net, sum(cogs)::text cogs, sum(lvat * sgn)::text vat from sl`, [from, to]);
  return { net: money(r.rows[0]?.net ?? 0), cogs: money(r.rows[0]?.cogs ?? 0), vat: money(r.rows[0]?.vat ?? 0) };
}

export async function costsReport(tx: Tx, ctx: Ctx, month: string): Promise<ReportCosts> {
  if (can(ctx, 'data.cost') !== 1) throw E.forbidden('Permission data.cost is required for the cost report', { perm: 'data.cost' });
  const { from, to } = monthRange(month);
  const src = new Sources(tx);
  const s = await salesTotals(tx, from, to);
  const gp = d(s.net).minus(d(s.cogs));

  const adj = await tx.query<{ k: 'adj' | 'issue'; n: number; outv: string; inv: string }>(
    `select case when exists (select 1 from adjust_requests a where a.result_doc_no = s.no) then 'adj' else 'issue' end k,
            count(distinct s.id)::int n,
            coalesce(sum(m.cost) filter (where m.qty < 0), 0)::text outv,
            coalesce(sum(m.cost) filter (where m.qty > 0), 0)::text inv
       from stock_docs s join stock_moves m on m.doc_id = s.id
      where s.type = 'ADJ' and s.date between $1::date and $2::date
      group by 1`,
    [from, to],
  );
  const issue = adj.rows.find((x) => x.k === 'issue');
  const adjust = adj.rows.find((x) => x.k === 'adj');
  const bad = await tx.query<{ n: number; v: string | null }>(
    // Damaged returns now go into the damaged-goods warehouse (their loss shows when written off as an adjustment);
    // only older credit notes whose damaged goods were never restocked are a cost here.
    `select count(distinct d.id)::int n, sum(l.cogs)::text v from docs d join doc_lines l on l.doc_id = d.id
      where d.type = 'CN' and d.status = 'active' and coalesce(l.return_condition, case when d.condition = 'bad' then 'damaged' end) = 'damaged'
        and not exists (select 1 from stock_moves m where m.doc_line_id = l.id) and d.date between $1::date and $2::date`,
    [from, to],
  );
  const lines: CostLine[] = [
    { key: 'issue', label: 'เบิกใช้ภายในร้าน (ทุน FIFO)', amount: money(issue?.outv ?? 0), count: issue?.n ?? 0, note: '' },
    { key: 'adjShort', label: 'ปรับยอดสต็อก: ขาด / เสีย', amount: money(adjust?.outv ?? 0), count: adjust?.n ?? 0, note: '' },
    { key: 'adjOver', label: 'ปรับยอดสต็อก: เกิน (ลดต้นทุน)', amount: money(d(adjust?.inv ?? 0).neg()), count: null, note: '' },
    { key: 'badReturn', label: 'รับคืนสินค้าชำรุด (ไม่คืนเข้าสต็อก)', amount: money(bad.rows[0]?.v ?? 0), count: bad.rows[0]?.n ?? 0, note: '' },
  ];
  const sources: ReportCosts['sources'] = [{ key: 'payroll', label: 'เงินเดือนและประกันสังคม (M17)', available: true, note: '' }];
  if (can(ctx, 'hr.salary') === 1) {
    const p = await tx.query<{ gross: string | null; sso: string | null; n: number }>(
      `select sum(gross)::text gross, sum(employer_sso)::text sso, count(*)::int n from hr_labour_cost_monthly where period = $1`, [month]);
    const has = (p.rows[0]?.n ?? 0) > 0;
    if (!has) sources[0] = { ...sources[0]!, available: false, note: `ยังไม่มีงวดเงินเดือน ${month} ที่อนุมัติแล้ว: กำไรนี้ยังไม่หักค่าแรง` };
    lines.push({ key: 'payroll', label: 'เงินเดือนและค่าจ้าง', amount: money(p.rows[0]?.gross ?? 0), count: null, note: has ? '' : 'ยังไม่มีงวดเงินเดือนที่อนุมัติ' });
    lines.push({ key: 'sso', label: 'ประกันสังคมส่วนนายจ้าง', amount: money(p.rows[0]?.sso ?? 0), count: null, note: '' });
  } else {
    lines.push({ key: 'payroll', label: 'เงินเดือนและประกันสังคม', amount: null, count: null, note: 'แสดงเฉพาะผู้มีสิทธิ์ดูเงินเดือน' });
  }
  const totalCost = sum(lines.map((l) => l.amount ?? 0));
  return { month, sales: s.net, cogs: s.cogs, gp: money(gp), lines, totalCost: money(totalCost), profitAfter: money(gp.minus(totalCost)), sources };
}

export function costsSheet(r: ReportCosts): (string | number)[][] {
  return [
    [`ต้นทุนภายในร้าน เดือน ${r.month}`],
    ['รายการ', 'จำนวนเอกสาร', 'บาท', 'หมายเหตุ'],
    ['ยอดขายก่อน VAT', '', r.sales, ''], ['ต้นทุนขาย (FIFO)', '', r.cogs, ''], ['กำไรขั้นต้น', '', r.gp, ''],
    ...r.lines.map((l) => [l.label, l.count ?? '', l.amount ?? '', l.note]),
    ['รวมต้นทุนภายใน', '', r.totalCost, ''], ['กำไรหลังหักต้นทุนภายใน', '', r.profitAfter, ''],
  ];
}

// ---------- promotions (REQ-M11-07) ----------
/** Promotion P&L: the numbers come from the retail module (M15, one source of truth); the screen links to its report. */
export async function promotionsReport(tx: Tx, deps: Deps, ctx: Ctx, from: string, to: string) {
  checkRange(from, to);
  const { items } = await promoPnl(tx, deps, ctx, { from, to });
  const sources = [{ key: 'promoLines', label: 'ยอดขายตามโปรโมชั่น (M15)', available: true, note: '' }];
  return {
    from, to, sources,
    rows: items.map((x) => ({
      key: x.promoId, label: `${x.code} · ${x.name}`, bills: x.bills, sets: x.sets, sales: x.salesExVat, discount: x.discount,
      cogs: x.cogs, gp: x.grossProfit, before: x.before.salesExVat !== '0.00' ? { sales: x.before.salesExVat, gp: x.before.grossProfit } : null,
    })),
  };
}
