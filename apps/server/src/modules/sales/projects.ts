/**
 * Projects (M09): a project always comes from a sales order (BR-23) — a new order flagged as a project or "ตั้งเป็นโครงการ"
 * on an existing one; variation orders are further sales orders linked to it. Installment schedule from a template
 * (30/40/30, 50/50, 100%) or custom percentages summing to 100 (REQ-M09-04/07); installment invoices deduct deposits
 * pro rata (REQ-M09-05, core.installmentAmount); deposits of type guarantee (no VAT until applied / forfeited) or advance
 * (tax invoice on receipt), forfeit / refund by the owner (REQ-M09-03/06, BR-06).
 */
import type { Tx } from '@erp/db';
import type { SalesDeposit, SalesPageQuery, SalesProject, SalesProjectSummary } from '@erp/contracts';
import {
  INSTALLMENT_TEMPLATES, d, dueDate, fmtTHB, installmentAmount, money, planInstallments, splitInclusive, sum, validInstallmentPcts, type InstallmentTemplate,
} from '@erp/core';
import type { z } from 'zod';
import type { SalesDepositActionReq, SalesDepositReq, SalesInstallmentIn, SalesInstallmentsReq, SalesNewProject, SalesProjectReq } from '@erp/contracts';
import { writeAudit } from '../../lib/audit';
import { requirePerm, type Ctx, type Deps } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E, isUuid } from '../../lib/errors';
import { authorizeVoid, loadCustomer, loadShop, lumpVatMode, pageNewest, partyCols, partyOf, requireOwner, voidedJson, type CustomerRow, type PartyCols, type VoidBody } from './common';
import { insertInvoice } from './invoices';

type NewProject = z.infer<typeof SalesNewProject>;
type InstallmentIn = z.infer<typeof SalesInstallmentIn>;

/** Default installment labels (mockup PJT). */
const TEMPLATE_LABELS: Record<Exclude<InstallmentTemplate, 'custom'>, string[]> = {
  '30/40/30': ['งวดที่ 1 · งานฐานราก / โครงสร้าง', 'งวดที่ 2 · งานผนัง / หลังคา', 'งวดที่ 3 · งานตกแต่ง / ส่งมอบ'],
  '50/50': ['งวดที่ 1 · ส่งของครึ่งแรก', 'งวดที่ 2 · ส่งของครบ'],
  '100%': ['วางบิลครั้งเดียวเมื่อส่งของครบ'],
};

/** Installment rows of a new project: template percentages or the custom rows (sum must be 100, REQ-M09-07). */
function scheduleOf(p: NewProject, start: string): { pct: string; label: string; dueDate: string }[] {
  let rows: InstallmentIn[];
  if (p.template === 'custom' || p.installments?.length) {
    if (!p.installments?.length) throw E.validation('A custom schedule needs installments');
    rows = p.installments;
  } else {
    rows = INSTALLMENT_TEMPLATES[p.template].map((pct, i) => ({ pct, label: TEMPLATE_LABELS[p.template as Exclude<InstallmentTemplate, 'custom'>][i]! }));
  }
  const pcts = rows.map((r) => r.pct);
  if (!validInstallmentPcts(pcts)) throw E.validation(`Installment percentages must be > 0 and add up to 100 (now ${money(sum(pcts.map((x) => d(x))))})`, { need: 'pct100' });
  const plan = planInstallments(pcts, start);
  return rows.map((r, i) => ({ pct: d(r.pct).toFixed(), label: r.label || `งวดที่ ${i + 1}`, dueDate: r.dueDate ?? plan[i]!.dueDate }));
}

/** Creates the project for a sales order (inside the order's transaction or from "ตั้งเป็นโครงการ"). */
export async function createProjectForOrder(tx: Tx, deps: Deps, ctx: Ctx, so: { id: string; no: string; customerId: string; date: string }, p: NewProject): Promise<{ id: string; no: string }> {
  requirePerm(ctx, 'sales.project');
  const start = p.startDate ?? so.date;
  const rows = scheduleOf(p, start);
  const no = await nextDocNo(tx, ctx.tenantId, 'PJ', deps.today());
  const id = (await tx.query<{ id: string }>(
    `insert into sales_projects (tenant_id, no, name, customer_id, site, contact, template, main_so_id, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [ctx.tenantId, no, p.name, so.customerId, p.site, p.contact, p.installments?.length ? 'custom' : p.template, so.id, ctx.userId],
  )).rows[0]!.id;
  for (const [i, r] of rows.entries()) {
    await tx.query(`insert into sales_project_installments (tenant_id, project_id, n, label, pct, due_date) values ($1,$2,$3,$4,$5,$6)`, [ctx.tenantId, id, i + 1, r.label, r.pct, r.dueDate]);
  }
  await tx.query(`update sales_orders set project_id = $2, ship_to = case when ship_to = '' then $3 else ship_to end where id = $1`, [so.id, id, p.site]);
  return { id, no };
}

/** "ตั้งเป็นโครงการ" on an existing sales order (REQ-M09-07 path ข). */
export async function createProject(tx: Tx, deps: Deps, ctx: Ctx, req: z.infer<typeof SalesProjectReq>): Promise<SalesProject> {
  requirePerm(ctx, 'sales.project');
  await tx.query(`select id from sales_orders where no = $1 for update`, [req.soNo]);
  const so = (await tx.query<{ id: string; no: string; customer_id: string; date: string; status: string; project_id: string | null; pj_status: string | null; total: string }>(
    `select x.id, x.no, x.customer_id, x.date::text, x.status, x.project_id, pj.status pj_status, x.total::text from sales_orders x left join sales_projects pj on pj.id = x.project_id where x.no = $1`,
    [req.soNo],
  )).rows[0];
  if (!so) throw E.notFound(`Sales order ${req.soNo} not found`);
  if (so.status !== 'active') throw E.conflict(`${so.no} is void`);
  if (so.project_id && so.pj_status === 'active') throw E.conflict(`${so.no} already belongs to a project`);
  const billed = await tx.query<{ no: string }>(
    `select distinct dd.no from sales_deliveries dv join sales_invoice_deliveries sid on sid.delivery_id = dv.id join docs dd on dd.id = sid.invoice_doc_id
      where dv.so_id = $1 and dd.status = 'active'`, [so.id]);
  if (billed.rowCount) throw E.conflict(`${so.no} is already invoiced (${billed.rows.map((r) => r.no).join(', ')}); a project bills by installment`);
  const pj = await createProjectForOrder(tx, deps, ctx, { id: so.id, no: so.no, customerId: so.customer_id, date: deps.today() }, req);
  await tx.query(`update sales_deliveries set project_id = $2 where so_id = $1`, [so.id, pj.id]);
  await writeAudit(tx, ctx, [{ action: 'create', object: 'project', ref: pj.no, detail: `${req.name} · จาก ${so.no} · มูลค่า ฿${fmtTHB(so.total)} · งวด ${req.installments?.length ? 'กำหนดเอง' : req.template}` }]);
  return getProject(tx, deps, pj.id);
}

// ---------- read ----------
interface ProjectRow extends PartyCols {
  id: string; no: string; name: string; customer_id: string; site: string; contact: string; template: string; status: 'active' | 'void'; main_so_no: string | null;
  created_by_name: string; created_at: Date; void_by_name: string | null; void_at: Date | null; void_reason: string | null;
}

async function projectRow(tx: Tx, id: string, forUpdate = false): Promise<ProjectRow> {
  if (!isUuid(id)) throw E.notFound('Project not found');
  if (forUpdate) await tx.query(`select id from sales_projects where id = $1 for update`, [id]);
  const r = await tx.query<ProjectRow>(
    `select x.id, x.no, x.name, x.customer_id, x.site, x.contact, x.template, x.status, so.no main_so_no, cu.name created_by_name, x.created_at, vu.name void_by_name,
            x.void_at, x.void_reason, ${partyCols}
       from sales_projects x join customers c on c.id = x.customer_id join users cu on cu.id = x.created_by left join sales_orders so on so.id = x.main_so_id
       left join users vu on vu.id = x.void_by where x.id = $1`,
    [id],
  );
  if (!r.rows[0]) throw E.notFound('Project not found');
  return r.rows[0];
}

/** Project value = sum of its active sales orders (main order + variations, BR-23). */
async function projectValue(tx: Tx, id: string): Promise<string> {
  const r = await tx.query<{ v: string | null }>(`select sum(total)::text v from sales_orders where project_id = $1 and status = 'active'`, [id]);
  return money(r.rows[0]?.v ?? 0);
}

interface InstRow { id: string; n: number; label: string; pct: string; due_date: string; inv_no: string | null; gross: string | null; deduct: string | null }
async function installments(tx: Tx, projectId: string): Promise<InstRow[]> {
  const r = await tx.query<InstRow>(
    `select i.id, i.n, i.label, i.pct::text, i.due_date::text, inv.no inv_no, si.gross_amount::text gross, si.deposit_deduct::text deduct
       from sales_project_installments i
       left join sales_invoices si on si.installment_id = i.id and exists (select 1 from docs z where z.id = si.doc_id and z.status = 'active')
       left join docs inv on inv.id = si.doc_id
      where i.project_id = $1 and i.active order by i.n`,
    [projectId],
  );
  return r.rows;
}

interface DepRow { id: string; no: string; date: string; type: 'guarantee' | 'advance'; amount: string; method: string; status: SalesDeposit['status']; closed_amount: string; inv_no: string | null; forfeit_no: string | null; refund: { amount: string; method: string; date: string; by: string } | null; created_at: Date }
async function deposits(tx: Tx, projectId: string): Promise<DepRow[]> {
  const r = await tx.query<DepRow>(
    `select dp.id, dp.no, dp.date::text, dp.type, dp.amount::text, dp.method, dp.status, dp.closed_amount::text, iv.no inv_no, fv.no forfeit_no, dp.refund, dp.created_at
       from sales_deposits dp left join docs iv on iv.id = dp.invoice_doc_id left join docs fv on fv.id = dp.forfeit_doc_id
      where dp.project_id = $1 order by dp.created_at`,
    [projectId],
  );
  return r.rows;
}

/**
 * Deposit pool: each non-void deposit contributes amount − closed_amount; the deductions of active installment invoices
 * are allocated to the deposits oldest first. Returns per-deposit applied / remaining and the pool size.
 */
function depositPool(deps_: DepRow[], applied: string) {
  let left = d(applied);
  const rows = deps_.map((x) => {
    if (x.status === 'void') return { ...x, applied: '0.00', remaining: '0.00' };
    const avail = d(x.amount).minus(d(x.closed_amount));
    const a = left.gt(avail) ? avail : left;
    left = left.minus(a);
    return { ...x, applied: money(a), remaining: x.status === 'active' ? money(avail.minus(a)) : '0.00' };
  });
  const pool = money(sum(deps_.filter((x) => x.status !== 'void').map((x) => d(x.amount).minus(d(x.closed_amount)))));
  return { rows, pool };
}

export async function projectFigures(tx: Tx, id: string): Promise<SalesProject['figures']> {
  const value = await projectValue(tx, id);
  const dl = await tx.query<{ total: string; nab: string | null; dv: string | null }>(
    `select so.total::text, (select sum(l.net_after_bill) from sales_order_lines l where l.so_id = so.id)::text nab,
            (select sum(dl.value) from sales_delivery_lines dl join sales_deliveries dv on dv.id = dl.delivery_id join sales_order_lines l on l.id = dl.so_line_id
              where l.so_id = so.id and dv.status = 'active')::text dv
       from sales_orders so where so.project_id = $1 and so.status = 'active'`,
    [id],
  );
  const delivered = sum(dl.rows.map((r) => (r.nab && d(r.nab).gt(0) ? d(r.total).times(d(r.dv ?? 0)).div(d(r.nab)) : d(0))));
  const inv = await tx.query<{ gross: string; ar: string; credited: string | null }>(
    `select coalesce(si.gross_amount, x.total)::text gross, x.ar_balance::text ar,
            (select sum(c.total) from docs c where c.ref_doc_id = x.id and c.type = 'CN' and c.status = 'active' and c.refund = 'credit')::text credited
       from docs x join sales_invoices si on si.doc_id = x.id where si.project_id = $1 and x.status = 'active' and si.source not in ('deposit','forfeit')`,
    [id],
  );
  const billed = sum(inv.rows.map((r) => r.gross));
  const outstanding = sum(inv.rows.map((r) => r.ar));
  const collected = sum(inv.rows.map((r) => d(r.gross).minus(d(r.ar)).minus(d(r.credited ?? 0))));
  return { value, delivered: money(delivered), billed: money(billed), collected: money(collected), outstanding: money(outstanding), unbilled: money(d(value).minus(billed)) };
}

export async function getProject(tx: Tx, _deps: Deps, id: string): Promise<SalesProject> {
  const p = await projectRow(tx, id);
  const value = await projectValue(tx, id);
  const inst = await installments(tx, id);
  const dps = await deposits(tx, id);
  const applied = money(sum(inst.filter((i) => i.inv_no).map((i) => i.deduct ?? 0)));
  const pool = depositPool(dps, applied);
  const billedRows = inst.map((i) => ({ pct: i.pct, billed: i.inv_no ? { gross: i.gross ?? '0', deduct: i.deduct ?? '0' } : null }));
  const [orders, dlv, invs] = await Promise.all([
    tx.query<{ id: string; no: string; date: string; status: 'active' | 'void'; total: string; dlv_status: 'open' | 'partial' | 'delivered' }>(
      `select id, no, date::text, status, total::text, dlv_status from sales_orders where project_id = $1 order by created_at`, [id]),
    tx.query<{ no: string; date: string; status: 'active' | 'void'; so_no: string | null; total: string; vehicle: string; preview: string | null }>(
      `select x.no, x.date::text, x.status, so.no so_no, x.total::text, x.vehicle,
              (select string_agg(split_part(l.name, ' ', 1) || ' ×' || trim(trailing '.' from trim(trailing '0' from l.qty::text)) || ' ' || l.unit_name, ', ' order by l.line_no)
                 from sales_delivery_lines l where l.delivery_id = x.id) preview
         from sales_deliveries x left join sales_orders so on so.id = x.so_id where x.project_id = $1 order by x.created_at`, [id]),
    tx.query<{ no: string; date: string; status: 'active' | 'void'; total: string; ar_balance: string; source: SalesProject['invoices'][number]['source'] }>(
      `select x.no, x.date::text, x.status, x.total::text, x.ar_balance::text, si.source from docs x join sales_invoices si on si.doc_id = x.id where si.project_id = $1 order by x.created_at`, [id]),
  ]);
  const mainId = (await tx.query<{ main_so_id: string | null }>(`select main_so_id from sales_projects where id = $1`, [id])).rows[0]?.main_so_id;
  return {
    id: p.id, no: p.no, name: p.name, customer: partyOf(p), site: p.site, contact: p.contact, template: p.template, status: p.status, mainSoNo: p.main_so_no,
    figures: await projectFigures(tx, id),
    orders: orders.rows.map((o) => ({ no: o.no, date: o.date, status: o.status, total: o.total, dlvStatus: o.dlv_status, isMain: o.id === mainId })),
    installments: inst.map((i, idx) => {
      const amt = i.inv_no ? { gross: money(i.gross ?? 0), deduct: money(i.deduct ?? 0), net: money(d(i.gross ?? 0).minus(d(i.deduct ?? 0))) } : installmentAmount(value, pool.pool, billedRows, idx);
      return { id: i.id, n: i.n, label: i.label, pct: d(i.pct).toFixed(), dueDate: i.due_date, status: i.inv_no ? 'billed' as const : 'open' as const, invoiceNo: i.inv_no, ...amt };
    }),
    deposits: pool.rows.map((x) => ({
      id: x.id, no: x.no, date: x.date, type: x.type, amount: money(x.amount), method: x.method, applied: x.applied, remaining: x.remaining, status: x.status,
      invoiceNo: x.inv_no, forfeitNo: x.forfeit_no, refund: x.refund,
    })),
    deliveries: dlv.rows.map((x) => ({ no: x.no, date: x.date, status: x.status, soNo: x.so_no, total: x.total, itemsPreview: x.preview ?? '', vehicle: x.vehicle })),
    invoices: invs.rows.map((x) => ({ no: x.no, date: x.date, status: x.status, total: x.total, arBalance: x.status === 'void' ? '0.00' : x.ar_balance, source: x.source })),
    createdBy: p.created_by_name, createdAt: p.created_at.toISOString(), voided: voidedJson(p),
  };
}

export async function listProjects(tx: Tx, q: SalesPageQuery) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.customerId) {
    if (!isUuid(q.customerId)) throw E.validation('Unknown customer');
    params.push(q.customerId);
    where.push(`x.customer_id = $${params.length}`);
  }
  if (q.status === 'active' || q.status === 'void') {
    params.push(q.status);
    where.push(`x.status = $${params.length}`);
  }
  const page = await pageNewest<{ id: string; no: string; name: string; customer_id: string; c_name: string; site: string; status: 'active' | 'void'; created_at: Date }, Omit<SalesProjectSummary, 'figures'>>(
    tx, `x.id, x.no, x.name, x.customer_id, c.name c_name, x.site, x.status, x.created_at, x.search_text`,
    `(select p.*, p.no || ' ' || lower(p.name) || ' ' || lower(p.site) || ' ' || lower(c2.name) as search_text from sales_projects p join customers c2 on c2.id = p.customer_id) x join customers c on c.id = x.customer_id`,
    where, params, q,
    (r) => ({ id: r.id, no: r.no, name: r.name, customer: { id: r.customer_id, name: r.c_name }, site: r.site, status: r.status, createdAt: r.created_at.toISOString() }),
  );
  const items: SalesProjectSummary[] = [];
  for (const it of page.items) items.push({ ...it, figures: await projectFigures(tx, it.id) });
  return { items, nextCursor: page.nextCursor };
}

// ---------- installments ----------
/** REQ-M09-04: rewrite the schedule; billed installments keep their percentage; the total stays 100 %. */
export async function setInstallments(tx: Tx, deps: Deps, ctx: Ctx, id: string, req: z.infer<typeof SalesInstallmentsReq>): Promise<SalesProject> {
  requirePerm(ctx, 'sales.project');
  const p = await projectRow(tx, id, true);
  if (p.status !== 'active') throw E.conflict(`${p.no} is void`);
  const cur = await installments(tx, id);
  const billed = cur.filter((i) => i.inv_no);
  for (const b of billed) {
    const row = req.rows.find((r) => r.id === b.id);
    if (!row) throw E.conflict(`Installment ${b.n} is billed (${b.inv_no}) and cannot be removed`);
    if (!d(row.pct).eq(d(b.pct))) throw E.conflict(`Installment ${b.n} is billed (${b.inv_no}); its percentage cannot change`);
  }
  if (!validInstallmentPcts(req.rows.map((r) => r.pct))) {
    throw E.validation(`Installment percentages must be > 0 and add up to 100 (now ${money(sum(req.rows.map((r) => d(r.pct))))})`, { need: 'pct100' });
  }
  await tx.query(`update sales_project_installments set active = false where project_id = $1 and active and id <> all($2::uuid[])`, [id, billed.map((b) => b.id)]);
  for (const [i, r] of req.rows.entries()) {
    const b = billed.find((x) => x.id === r.id);
    if (b) await tx.query(`update sales_project_installments set n = $2, label = $3, due_date = $4 where id = $1`, [b.id, i + 1, r.label || b.label, r.dueDate]);
    else await tx.query(`insert into sales_project_installments (tenant_id, project_id, n, label, pct, due_date) values ($1,$2,$3,$4,$5,$6)`, [ctx.tenantId, id, i + 1, r.label || `งวดที่ ${i + 1}`, d(r.pct).toFixed(), r.dueDate]);
  }
  await writeAudit(tx, ctx, [{ action: 'update', object: 'project', ref: p.no, detail: `แก้งวดวางบิล: ${cur.map((i) => d(i.pct).toFixed()).join('/')} → ${req.rows.map((r) => d(r.pct).toFixed()).join('/')}` }]);
  return getProject(tx, deps, id);
}

async function projectCustomer(tx: Tx, ctx: Ctx, p: ProjectRow): Promise<CustomerRow> {
  const c = await loadCustomer(tx, p.customer_id);
  if ((await loadShop(tx, ctx)).vat_registered && !c.tax_id) throw E.validation('A full tax invoice needs a customer with a tax ID');
  return c;
}

/** REQ-M09-05: tax invoice for one installment, deducting the deposit pro rata (the last installment takes the rest). */
export async function billInstallment(tx: Tx, deps: Deps, ctx: Ctx, id: string, installmentId: string, body: { date?: string; note?: string }): Promise<{ invoiceNo: string; project: SalesProject }> {
  requirePerm(ctx, 'sales.project');
  const p = await projectRow(tx, id, true);
  if (p.status !== 'active') throw E.conflict(`${p.no} is void`);
  const inst = await installments(tx, id);
  const idx = inst.findIndex((i) => i.id === installmentId);
  if (idx < 0) throw E.notFound('Installment not found');
  const row = inst[idx]!;
  if (row.inv_no) throw E.conflict(`Installment ${row.n} is already billed (${row.inv_no})`);
  const value = await projectValue(tx, id);
  if (!d(value).gt(0)) throw E.conflict('The project has no active sales order value');
  const dps = await deposits(tx, id);
  const applied = money(sum(inst.filter((i) => i.inv_no).map((i) => i.deduct ?? 0)));
  const pool = depositPool(dps, applied);
  const depType = dps.find((x) => x.status !== 'void')?.type ?? null;
  const amt = installmentAmount(value, pool.pool, inst.map((i) => ({ pct: i.pct, billed: i.inv_no ? { gross: i.gross ?? '0', deduct: i.deduct ?? '0' } : null })), idx);
  const customer = await projectCustomer(tx, ctx, p);
  const mode = await lumpVatMode(tx, ctx);
  // advance deposits were taxed when received: deduct them from this invoice (no VAT twice, BR-06);
  // a guarantee deposit becomes taxable now: VAT on the full installment, the deposit pays part of the balance.
  const advance = depType === 'advance';
  const total = advance ? amt.net : amt.gross;
  const split = splitInclusive(total, mode);
  const main = (await tx.query<{ term: { t: 'cash' } | { t: 'days'; x: number } | { t: 'nextDay'; x: number } | { t: 'eom' } | { t: 'eonm' }; salesperson_id: string | null }>(
    `select so.term, so.salesperson_id from sales_projects pj join sales_orders so on so.id = pj.main_so_id where pj.id = $1`, [id])).rows[0];
  const term = main?.term ?? customer.term;
  const date = body.date ?? deps.today();
  const ar = advance ? total : money(d(amt.gross).minus(d(amt.deduct)));
  const textLines = [{ name: `${row.label} (${d(row.pct).toFixed()}% ของมูลค่าโครงการ ฿${fmtTHB(value)}) · ${p.name}`, amount: amt.gross }];
  if (d(amt.deduct).gt(0)) textLines.push({ name: advance ? 'หักเงินรับล่วงหน้าตามสัดส่วนงวด (ออกใบกำกับแล้วตอนรับเงิน)' : 'หักเงินมัดจำตามสัดส่วนงวด', amount: money(d(amt.deduct).neg()) });
  const inv = await insertInvoice(tx, ctx, {
    date, customer, vatMode: mode, totals: { gross: split.total, lineDisc: '0.00', billDisc: '0.00', base7: split.base7, exempt: split.exempt, vat: split.vat, total: split.total },
    lines: [], payments: [], arBalance: ar, search: [p.no, p.name, row.label],
    ext: {
      kind: 'credit', source: 'installment', projectId: id, installmentId: row.id, term, dueDate: dueDate(date, term), grossAmount: amt.gross, depositDeduct: amt.deduct,
      depositType: depType, textLines, note: body.note ?? '', salespersonId: main?.salesperson_id ?? null,
    },
  });
  await writeAudit(tx, ctx, [{ action: 'create', object: 'INV', ref: inv.no, detail: `วางบิลงวดที่ ${row.n} ${d(row.pct).toFixed()}% · ${p.name} · ฿${fmtTHB(amt.gross)}${d(amt.deduct).gt(0) ? ` − มัดจำ ${fmtTHB(amt.deduct)}` : ''}` }]);
  return { invoiceNo: inv.no, project: await getProject(tx, deps, id) };
}

// ---------- deposits ----------
const DEP_TH = { guarantee: 'มัดจำประกันสัญญา', advance: 'รับชำระค่าสินค้าล่วงหน้า' } as const;

/** REQ-M09-03: the type is fixed per project once a deposit exists ("แก้ประเภทหลังออกเอกสารไม่ได้"). */
export async function receiveDeposit(tx: Tx, deps: Deps, ctx: Ctx, id: string, req: z.infer<typeof SalesDepositReq>): Promise<SalesProject> {
  requirePerm(ctx, 'sales.project');
  const p = await projectRow(tx, id, true);
  if (p.status !== 'active') throw E.conflict(`${p.no} is void`);
  if (!d(req.amount).gt(0)) throw E.validation('Deposit amount must be > 0');
  const dps = await deposits(tx, id);
  const other = dps.find((x) => x.status !== 'void' && x.type !== req.type);
  if (other) throw E.conflict(`This project already has ${DEP_TH[other.type]} (${other.no}); one project uses one deposit type`);
  const date = req.date ?? deps.today();
  const no = await nextDocNo(tx, ctx.tenantId, 'DP', date);
  let invoiceId: string | null = null;
  let invNo = '';
  if (req.type === 'advance') {
    const customer = await projectCustomer(tx, ctx, p);
    const split = splitInclusive(req.amount, await lumpVatMode(tx, ctx));
    const inv = await insertInvoice(tx, ctx, {
      date, customer, vatMode: (await lumpVatMode(tx, ctx)), totals: { gross: split.total, lineDisc: '0.00', billDisc: '0.00', base7: split.base7, exempt: split.exempt, vat: split.vat, total: split.total },
      lines: [], payments: [{ method: req.method, amount: split.total }], arBalance: '0.00', search: [p.no, p.name, no],
      ext: { kind: 'cash', source: 'deposit', projectId: id, term: { t: 'cash' }, dueDate: date, textLines: [{ name: `รับชำระค่าสินค้าล่วงหน้า · ${p.name} (${no})`, amount: split.total }] },
    });
    invoiceId = inv.id;
    invNo = inv.no;
  }
  const depId = (await tx.query<{ id: string }>(
    `insert into sales_deposits (tenant_id, no, date, project_id, customer_id, type, amount, method, invoice_doc_id, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [ctx.tenantId, no, date, id, p.customer_id, req.type, money(req.amount), req.method, invoiceId, ctx.userId],
  )).rows[0]!.id;
  if (invoiceId) await tx.query(`update sales_invoices set deposit_id = $2 where doc_id = $1`, [invoiceId, depId]);
  await writeAudit(tx, ctx, [{ action: 'create', object: 'deposit', ref: no, detail: `${DEP_TH[req.type]} · ${p.name} · ฿${fmtTHB(req.amount)} · ${req.method}${invNo ? ` · ใบกำกับ ${invNo}` : ' · ยังไม่เกิด VAT'}` }]);
  return getProject(tx, deps, id);
}

async function depositFor(tx: Tx, no: string) {
  await tx.query(`select id from sales_deposits where no = $1 for update`, [no]);
  const r = await tx.query<{ id: string; project_id: string }>(`select id, project_id from sales_deposits where no = $1`, [no]);
  if (!r.rows[0]) throw E.notFound(`Deposit ${no} not found`);
  const pid = r.rows[0].project_id;
  await projectRow(tx, pid, true);
  const inst = await installments(tx, pid);
  const applied = money(sum(inst.filter((i) => i.inv_no).map((i) => i.deduct ?? 0)));
  const dep = depositPool(await deposits(tx, pid), applied).rows.find((x) => x.id === r.rows[0]!.id)!;
  return { dep, projectId: pid, p: await projectRow(tx, pid) };
}

/** REQ-M09-06: forfeit the unapplied part of a guarantee deposit (owner); a tax invoice is issued for it (BR-06). */
export async function forfeitDeposit(tx: Tx, deps: Deps, ctx: Ctx, no: string, req: z.infer<typeof SalesDepositActionReq>): Promise<SalesProject> {
  requirePerm(ctx, 'sales.project');
  const { dep, projectId, p } = await depositFor(tx, no);
  if (dep.status !== 'active') throw E.conflict(`${no} is ${dep.status}`);
  if (dep.type !== 'guarantee') throw E.conflict('Only a guarantee deposit can be forfeited; an advance payment is returned with a credit note');
  if (!d(dep.remaining).gt(0)) throw E.conflict(`${no} has nothing left to forfeit`);
  const by = await requireOwner(tx, deps, ctx, req.approval, `ริบมัดจำ ${no}`);
  const customer = await projectCustomer(tx, ctx, p);
  const mode = await lumpVatMode(tx, ctx);
  const split = splitInclusive(dep.remaining, mode);
  const date = deps.today();
  const inv = await insertInvoice(tx, ctx, {
    date, customer, vatMode: mode, totals: { gross: split.total, lineDisc: '0.00', billDisc: '0.00', base7: split.base7, exempt: split.exempt, vat: split.vat, total: split.total },
    lines: [], payments: [], arBalance: '0.00', search: [p.no, p.name, no],
    ext: { kind: 'cash', source: 'forfeit', projectId, depositId: dep.id, term: { t: 'cash' }, dueDate: date, textLines: [{ name: `ริบเงินมัดจำ ${no} · ${p.name}${req.reason ? ` · ${req.reason}` : ''}`, amount: split.total }] },
  });
  await tx.query(`update sales_deposits set status = 'forfeited', closed_amount = $2, forfeit_doc_id = $3 where id = $1`, [dep.id, dep.remaining, inv.id]);
  await writeAudit(tx, ctx, [{ action: 'update', object: 'deposit', ref: no, detail: `ริบมัดจำ ฿${fmtTHB(dep.remaining)} · ใบกำกับ ${inv.no}${req.reason ? ` · ${req.reason}` : ''} · อนุมัติโดย ${by}` }]);
  return getProject(tx, deps, projectId);
}

/** REQ-M09-06: return the unapplied part of a guarantee deposit (owner). */
export async function refundDeposit(tx: Tx, deps: Deps, ctx: Ctx, no: string, req: z.infer<typeof SalesDepositActionReq>): Promise<SalesProject> {
  requirePerm(ctx, 'sales.project');
  const { dep, projectId } = await depositFor(tx, no);
  if (dep.status !== 'active') throw E.conflict(`${no} is ${dep.status}`);
  if (dep.type !== 'guarantee') throw E.conflict('An advance payment is returned with a credit note on its tax invoice');
  if (!d(dep.remaining).gt(0)) throw E.conflict(`${no} has nothing left to refund`);
  const by = await requireOwner(tx, deps, ctx, req.approval, `คืนมัดจำ ${no}`);
  const refund = { amount: dep.remaining, method: req.method ?? dep.method, date: deps.today(), by };
  await tx.query(`update sales_deposits set status = 'refunded', closed_amount = $2, refund = $3 where id = $1`, [dep.id, dep.remaining, JSON.stringify(refund)]);
  await writeAudit(tx, ctx, [{ action: 'update', object: 'deposit', ref: no, detail: `คืนมัดจำ ฿${fmtTHB(dep.remaining)} · ${refund.method}${req.reason ? ` · ${req.reason}` : ''} · อนุมัติโดย ${by}` }]);
  return getProject(tx, deps, projectId);
}

/** BR-22: a deposit already deducted by an installment invoice cannot be voided; an advance deposit voids its invoice. */
export async function voidDeposit(tx: Tx, deps: Deps, ctx: Ctx, no: string, body: VoidBody): Promise<SalesProject> {
  const approvedBy = await authorizeVoid(tx, deps, ctx, body, no);
  const { dep, projectId } = await depositFor(tx, no);
  if (dep.status === 'void') throw E.conflict(`${no} is already void`);
  if (dep.status !== 'active') throw E.conflict(`${no} is ${dep.status}`);
  if (d(dep.applied).gt(0)) {
    const inv = await tx.query<{ no: string }>(
      `select x.no from docs x join sales_invoices si on si.doc_id = x.id where si.project_id = $1 and si.source = 'installment' and x.status = 'active' and si.deposit_deduct > 0`, [projectId]);
    throw E.downstreamFirst(`${no} is deducted by installment invoices; void them first`, { docs: inv.rows.map((r) => r.no) });
  }
  const inv = (await tx.query<{ invoice_doc_id: string | null }>(`select invoice_doc_id from sales_deposits where id = $1`, [dep.id])).rows[0]?.invoice_doc_id;
  if (inv) {
    const cn = await tx.query<{ no: string }>(`select no from docs where ref_doc_id = $1 and status = 'active'`, [inv]);
    if (cn.rowCount) throw E.downstreamFirst(`${no} has documents on its invoice`, { docs: cn.rows.map((r) => r.no) });
    await tx.query(`update docs set status = 'void', void_by = $2, void_at = now(), void_reason = $3 where id = $1`, [inv, ctx.userId, `ยกเลิกพร้อมใบรับมัดจำ ${no} · ${body.reason}`]);
  }
  await tx.query(`update sales_deposits set status = 'void', void_by = $2, void_at = now(), void_reason = $3 where id = $1`, [dep.id, ctx.userId, body.reason]);
  await writeAudit(tx, ctx, [{ action: 'void', object: 'deposit', ref: no, detail: `${body.reason} · ฿${fmtTHB(dep.amount)}${dep.inv_no ? ` · ยกเลิกใบกำกับ ${dep.inv_no}` : ''}${approvedBy}` }]);
  return getProject(tx, deps, projectId);
}

/** BR-22: invoices and deposits of the project go first; its sales orders stay and become ordinary orders. */
export async function voidProject(tx: Tx, deps: Deps, ctx: Ctx, id: string, body: VoidBody): Promise<SalesProject> {
  requirePerm(ctx, 'sales.project');
  const approvedBy = await authorizeVoid(tx, deps, ctx, body, 'โครงการ');
  const p = await projectRow(tx, id, true);
  if (p.status === 'void') throw E.conflict(`${p.no} is already void`);
  const down = await tx.query<{ no: string }>(
    `select x.no from docs x join sales_invoices si on si.doc_id = x.id where si.project_id = $1 and x.status = 'active'
     union all select no from sales_deposits where project_id = $1 and status = 'active'`, [id]);
  if (down.rowCount) throw E.downstreamFirst(`${p.no} has invoices or deposits; void them first`, { docs: down.rows.map((r) => r.no) });
  await tx.query(`update sales_projects set status = 'void', void_by = $2, void_at = now(), void_reason = $3 where id = $1`, [id, ctx.userId, body.reason]);
  await tx.query(`update sales_deliveries set project_id = null where project_id = $1`, [id]);
  await writeAudit(tx, ctx, [{ action: 'void', object: 'project', ref: p.no, detail: `${p.name} · ${body.reason}${approvedBy}` }]);
  return getProject(tx, deps, id);
}
