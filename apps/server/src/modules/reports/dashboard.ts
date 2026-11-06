/**
 * REQ-M11-04: the mobile home dashboard. One request, one card per thing to do today. A card is null when the
 * role may not see it; a missing source (another module not installed yet) is listed in `sources`.
 */
import type { Tx } from '@erp/db';
import type { ReportDashboard, ReportSource } from '@erp/contracts';
import { addDays, d, dueDate, money, qty4, type PaymentTerm } from '@erp/core';
import { can, type Ctx, type Deps } from '../../lib/context';
import { Sources } from './sources';
import { salesTotals } from './extra';

const any = (ctx: Ctx, ...keys: Parameters<typeof can>[1][]) => keys.some((k) => !!can(ctx, k));

export async function dashboard(tx: Tx, deps: Deps, ctx: Ctx): Promise<ReportDashboard> {
  const today = deps.today();
  const src = new Sources(tx);
  const sources: ReportSource[] = [];
  const seeCost = can(ctx, 'data.cost') === 1;
  const seeReports = !!can(ctx, 'rep.view');

  let salesToday: ReportDashboard['salesToday'] = null;
  if (seeReports || any(ctx, 'pos.sell', 'fin.shift')) {
    const r = await tx.query<{ total: string | null; bills: number; vat: string | null; returns: string | null }>(
      `select sum(total) filter (where type <> 'CN')::text total, (count(*) filter (where type <> 'CN'))::int bills,
              (coalesce(sum(vat) filter (where type <> 'CN'), 0) - coalesce(sum(vat) filter (where type = 'CN'), 0))::text vat,
              sum(total) filter (where type = 'CN')::text returns
         from docs where date = $1::date and status = 'active' and type in ('ABB','INV','RC','CN')`,
      [today],
    );
    const x = r.rows[0]!;
    salesToday = { total: money(x.total ?? 0), bills: x.bills, vat: money(x.vat ?? 0), returns: money(x.returns ?? 0) };
  }

  let sales7d: ReportDashboard['sales7d'] = null;
  let month: ReportDashboard['month'] = null;
  if (seeReports) {
    const from = addDays(today, -6);
    const r = await tx.query<{ date: string; total: string }>(
      `select g.day::date::text date, coalesce(sum(case when d.type = 'CN' then -d.total else d.total end), 0)::text total
         from generate_series($1::date, $2::date, interval '1 day') g(day)
         left join docs d on d.date = g.day::date and d.status = 'active' and d.type in ('ABB','INV','RC','CN')
        group by 1 order by 1`,
      [from, today],
    );
    sales7d = r.rows.map((x) => ({ date: x.date, total: money(x.total) }));
    const m = await salesTotals(tx, `${today.slice(0, 7)}-01`, today);
    let stockValue: string | null = null;
    if (seeCost) {
      const v = await tx.query<{ v: string | null }>(`select sum(remaining * unit_cost)::text v from stock_lots where remaining > 0`);
      stockValue = money(v.rows[0]?.v ?? 0);
    }
    month = { sales: m.net, cogs: seeCost ? m.cogs : null, gp: seeCost ? money(d(m.net).minus(d(m.cogs))) : null, stockValue };
  }

  let lowStock: ReportDashboard['lowStock'] = null;
  if (any(ctx, 'inv.view', 'inv.receive')) {
    const r = await tx.query<{ id: string; name: string; units: { name: string }[]; qty: string; reorder_point: string; is_scg: boolean; n: number }>(
      `select p.id, p.name, p.units, coalesce(s.q, 0)::text qty, p.reorder_point::text, p.is_scg, count(*) over ()::int n
         from products p left join (select product_id, sum(remaining) q from stock_lots group by product_id) s on s.product_id = p.id
        where p.kind = 'stock' and p.active and p.reorder_point > 0 and coalesce(s.q, 0) < p.reorder_point
        order by coalesce(s.q, 0) / p.reorder_point, p.sku limit 8`,
    );
    lowStock = {
      count: r.rows[0]?.n ?? 0,
      items: r.rows.map((x) => ({ productId: x.id, name: x.name, unit: x.units[0]?.name ?? '', qty: qty4(x.qty), reorderPoint: qty4(x.reorder_point), isScg: x.is_scg })),
    };
  }

  let arDue: ReportDashboard['arDue'] = null;
  if (can(ctx, 'fin.ar')) {
    const open = await arOpen(tx, src);
    const items = open.map((x) => ({ ...x, overdueDays: Math.round((Date.parse(today) - Date.parse(x.dueDate)) / 86_400_000) }))
      .sort((a, b) => b.overdueDays - a.overdueDays || a.no.localeCompare(b.no));
    const over = items.filter((x) => x.overdueDays > 0);
    arDue = { amount: money(over.reduce((a, x) => a.plus(d(x.balance)), d(0))), count: over.length, items: items.slice(0, 5) };
    sources.push(await src.status('arOpen', 'ยังไม่มีโมดูลลูกหนี้ (M10): แสดงเฉพาะบิลที่ยังมียอดค้างในระบบ'));
  }

  let approvals: ReportDashboard['approvals'] = null;
  const canAdj = can(ctx, 'inv.adjApprove') === 1;
  const canLeave = can(ctx, 'hr.leave') === 1;
  if (canAdj || canLeave) {
    const items: NonNullable<ReportDashboard['approvals']>['items'] = [];
    let count = 0;
    if (canAdj) {
      const r = await tx.query<{ no: string; reason: string; created_at: Date; n: number }>(
        `select no, reason, created_at, count(*) over ()::int n from adjust_requests where status = 'pending' order by created_at limit 5`);
      count += r.rows[0]?.n ?? 0;
      items.push(...r.rows.map((x) => ({ kind: 'stock-adjust', no: x.no, label: `ขอปรับยอดสต็อก · ${x.reason}`, at: x.created_at.toISOString(), path: `/stock?req=${encodeURIComponent(x.no)}` })));
    }
    if (canLeave) {
      const r = await tx.query<{ no: string; name: string; days: string; created_at: Date; n: number }>(
        `select l.no, e.name, l.days::text, l.created_at, count(*) over ()::int n from leave_requests l join employees e on e.id = l.employee_id
          where l.status = 'pending' order by l.created_at limit 5`);
      count += r.rows[0]?.n ?? 0;
      items.push(...r.rows.map((x) => ({ kind: 'leave', no: x.no, label: `ใบลา ${x.name} · ${Number(x.days)} วัน`, at: x.created_at.toISOString(), path: `/leave?no=${encodeURIComponent(x.no)}` })));
    }
    approvals = { count, items: items.sort((a, b) => a.at.localeCompare(b.at)).slice(0, 5) };
  }

  let grPending: ReportDashboard['grPending'] = null;
  if (any(ctx, 'inv.receive', 'inv.view')) {
    if (await src.has('grPending')) {
      const r = await tx.query<{ n: number; oldest: string | null }>(
        `select count(*)::int n, min(delivered_at)::date::text oldest from rpt_gr_pending where tenant_id = erp_current_tenant()`);
      const oldest = r.rows[0]?.oldest;
      grPending = { count: r.rows[0]?.n ?? 0, oldestDays: oldest ? Math.max(0, Math.round((Date.parse(today) - Date.parse(oldest)) / 86_400_000)) : 0 };
    }
    sources.push(await src.status('grPending', 'ยังไม่มีใบรับของร่างรอยืนยัน (M05) ในเวอร์ชันนี้'));
  }

  return { today, salesToday, sales7d, month, lowStock, arDue, approvals, grPending, sources };
}

/** Open receivables: the M10 plug-in view when present, else documents with a balance (due from the customer's term). */
async function arOpen(tx: Tx, src: Sources): Promise<{ no: string; customer: string; balance: string; dueDate: string }[]> {
  if (await src.has('arOpen')) {
    const r = await tx.query<{ no: string; customer: string; balance: string; due_date: string }>(
      `select no, customer, balance::text, due_date::text from rpt_ar_open where tenant_id = erp_current_tenant() and balance > 0 order by due_date limit 200`);
    return r.rows.map((x) => ({ no: x.no, customer: x.customer, balance: money(x.balance), dueDate: x.due_date }));
  }
  const r = await tx.query<{ no: string; date: string; customer: string; balance: string; term: PaymentTerm | null }>(
    `select d.no, d.date::text, coalesce(c.name, d.customer_name) customer, d.ar_balance::text balance, c.term
       from docs d left join customers c on c.id = d.customer_id
      where d.status = 'active' and d.ar_balance > 0 order by d.date limit 200`);
  return r.rows.map((x) => ({ no: x.no, customer: x.customer, balance: money(x.balance), dueDate: dueDate(x.date, x.term) }));
}
