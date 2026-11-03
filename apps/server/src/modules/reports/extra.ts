/**
 * REQ-M11-06 internal cost, REQ-M11-07 promotion P&L, REQ-M11-05 SCG Family coupons (cloud only).
 * Promotions, payroll and coupons come from plug-in views of their modules (./sources.ts); until those exist the
 * report says so instead of showing made-up numbers.
 */
import type { Tx } from '@erp/db';
import type { ReportCostLine, ReportCosts } from '@erp/contracts';
import { addDays, d, money, round2, sum } from '@erp/core';
import type { z } from 'zod';
import { can, type Ctx } from '../../lib/context';
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
    `select count(distinct d.id)::int n, sum(l.cogs)::text v from docs d join doc_lines l on l.doc_id = d.id
      where d.type = 'CN' and d.status = 'active' and d.condition = 'bad' and d.date between $1::date and $2::date`,
    [from, to],
  );
  const lines: CostLine[] = [
    { key: 'issue', label: 'เบิกใช้ภายในร้าน (ทุน FIFO)', amount: money(issue?.outv ?? 0), count: issue?.n ?? 0, note: '' },
    { key: 'adjShort', label: 'ปรับยอดสต็อก: ขาด / เสีย', amount: money(adjust?.outv ?? 0), count: adjust?.n ?? 0, note: '' },
    { key: 'adjOver', label: 'ปรับยอดสต็อก: เกิน (ลดต้นทุน)', amount: money(d(adjust?.inv ?? 0).neg()), count: null, note: '' },
    { key: 'badReturn', label: 'รับคืนสินค้าชำรุด (ไม่คืนเข้าสต็อก)', amount: money(bad.rows[0]?.v ?? 0), count: bad.rows[0]?.n ?? 0, note: '' },
  ];
  const sources = [await src.status('payroll', 'ยังไม่มีข้อมูลเงินเดือน (M17): กำไรนี้ยังไม่หักค่าแรง')];
  if (await src.has('payroll')) {
    if (can(ctx, 'hr.salary') === 1) {
      const p = await tx.query<{ gross: string | null; sso: string | null }>(
        `select sum(gross)::text gross, sum(sso_employer)::text sso from rpt_payroll_monthly where tenant_id = erp_current_tenant() and month = $1`, [month]);
      lines.push({ key: 'payroll', label: 'เงินเดือนและค่าจ้าง', amount: money(p.rows[0]?.gross ?? 0), count: null, note: '' });
      lines.push({ key: 'sso', label: 'ประกันสังคมส่วนนายจ้าง', amount: money(p.rows[0]?.sso ?? 0), count: null, note: '' });
    } else {
      lines.push({ key: 'payroll', label: 'เงินเดือนและประกันสังคม', amount: null, count: null, note: 'แสดงเฉพาะผู้มีสิทธิ์ดูเงินเดือน' });
    }
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
export async function promotionsReport(tx: Tx, ctx: Ctx, from: string, to: string) {
  checkRange(from, to);
  const src = new Sources(tx);
  const sources = [await src.status('promoLines', 'ยังไม่มีโมดูลโปรโมชั่นของร้าน (M15): รายงานจะแสดงเมื่อมีโปรที่ขายแล้ว')];
  if (!(await src.has('promoLines'))) return { from, to, rows: [], sources };
  const seeCost = can(ctx, 'data.cost') === 1;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  const bFrom = addDays(from, -(days + 1));
  const bTo = addDays(from, -1);
  const agg = (a: string, b: string) => tx.query<{ promo_id: string; promo_name: string; bills: number; sets: string; sales: string; discount: string; cogs: string }>(
    `select promo_id::text, max(promo_name) promo_name, count(distinct doc_id)::int bills, coalesce(sum(sets), 0)::text sets, coalesce(sum(sales), 0)::text sales,
            coalesce(sum(discount), 0)::text discount, coalesce(sum(cogs), 0)::text cogs
       from rpt_promo_lines where tenant_id = erp_current_tenant() and date between $1::date and $2::date group by promo_id order by 5 desc`,
    [a, b],
  );
  const now = await agg(from, to);
  const before = new Map((await agg(bFrom, bTo)).rows.map((r) => [r.promo_id, r]));
  return {
    from, to, sources,
    rows: now.rows.map((r) => {
      const b = before.get(r.promo_id);
      return {
        key: r.promo_id, label: r.promo_name, bills: r.bills, sets: r.sets, sales: money(r.sales), discount: money(r.discount),
        cogs: seeCost ? money(r.cogs) : null, gp: seeCost ? money(round2(r.sales).minus(round2(r.cogs))) : null,
        before: b ? { sales: money(b.sales), gp: seeCost ? money(round2(b.sales).minus(round2(b.cogs))) : null } : null,
      };
    }),
  };
}
