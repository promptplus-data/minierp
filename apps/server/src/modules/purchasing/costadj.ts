/**
 * ปรับปรุงต้นทุน: change the unit cost of the stock still on hand (every remaining FIFO lot of a product, in one
 * warehouse or all) through a request that a manager / owner approves. The owner switches the feature on or off;
 * while it is off nobody can request or approve a cost change. Approval rewrites the lots' unit cost, resets the
 * product's moving-average cost and writes one zero-quantity ledger row per product × warehouse with the value change.
 */
import type { Tx } from '@erp/db';
import type { CostAdj } from '@erp/contracts';
import { d, fmtTHB, money, qty4, sum } from '@erp/core';
import { writeAudit } from '../../lib/audit';
import { can, requirePerm, type Ctx, type Deps } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E, isUuid } from '../../lib/errors';
import { decodeCursor, pageOf } from '../../lib/paging';

interface StoredLine { productId: string; warehouseId: string | null; qty: string; oldCost: string; newCost: string }

const needCost = (ctx: Ctx) => requirePerm(ctx, 'data.cost');

export async function getSettings(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'inv.view', { readOnly: true });
  const r = await tx.query<{ cost_adjust_enabled: boolean; name: string | null; updated_at: Date | null }>(
    `select s.cost_adjust_enabled, u.name, s.updated_at from purchasing_settings s left join users u on u.id = s.updated_by`);
  const s = r.rows[0];
  return { enabled: s?.cost_adjust_enabled ?? false, updatedBy: s?.name ?? null, updatedAt: s?.updated_at?.toISOString() ?? null };
}

/** Owner only: open or lock cost adjustment for the whole shop. */
export async function updateSettings(tx: Tx, ctx: Ctx, body: { enabled: boolean }) {
  if (ctx.role !== 'owner') throw E.forbidden('เฉพาะเจ้าของร้านเปิด/ปิดการปรับปรุงต้นทุนได้');
  const before = await getSettings(tx, ctx);
  await tx.query(
    `insert into purchasing_settings (tenant_id, cost_adjust_enabled, updated_by, updated_at) values ($1,$2,$3,now())
     on conflict (tenant_id) do update set cost_adjust_enabled = excluded.cost_adjust_enabled, updated_by = excluded.updated_by, updated_at = now()`,
    [ctx.tenantId, body.enabled, ctx.userId]);
  if (before.enabled !== body.enabled) {
    await writeAudit(tx, ctx, [{ action: 'update', object: 'purchasing-settings', ref: 'ปรับปรุงต้นทุน', detail: body.enabled ? 'เปิดให้ปรับปรุงต้นทุน' : 'ปิด (ล็อก) ไม่ให้แก้ต้นทุน' }]);
  }
  return getSettings(tx, ctx);
}

async function requireEnabled(tx: Tx, ctx: Ctx) {
  if (!(await getSettings(tx, ctx)).enabled) throw E.conflict('การปรับปรุงต้นทุนถูกปิดอยู่ (ล็อก) ให้เจ้าของร้านเปิดก่อน', { reason: 'COST_LOCKED' });
}

/** Remaining stock and its average unit cost for one product (one warehouse or all). */
async function onHand(tx: Tx, productId: string, warehouseId: string | null, lock = false) {
  const r = await tx.query<{ q: string | null; v: string | null; n: number }>(
    `select sum(remaining)::text q, sum(remaining * unit_cost)::text v, count(*)::int n from (
       select remaining, unit_cost from stock_lots where product_id = $1 and remaining > 0 and ($2::uuid is null or warehouse_id = $2) ${lock ? 'for update' : ''}) l`,
    [productId, warehouseId]);
  const q = d(r.rows[0]?.q ?? 0);
  const v = d(r.rows[0]?.v ?? 0);
  return { qty: qty4(q), value: money(v), avgCost: q.isZero() ? qty4(0) : qty4(v.div(q)), lots: r.rows[0]?.n ?? 0 };
}

export async function preview(tx: Tx, ctx: Ctx, q: { productId: string; warehouseId?: string }) {
  needCost(ctx);
  if (!isUuid(q.productId) || (q.warehouseId && !isUuid(q.warehouseId))) throw E.validation('Unknown product or warehouse');
  const h = await onHand(tx, q.productId, q.warehouseId ?? null);
  return { productId: q.productId, warehouseId: q.warehouseId ?? null, ...h };
}

const SELECT = `select c.id, c.no, to_char(c.date,'YYYY-MM-DD') date, c.reason, c.status, c.value_change::text, c.lines, ru.name requested_by,
                       du.name decided_by, c.decided_at, c.decide_note, c.created_at
                  from cost_adjustments c join users ru on ru.id = c.requested_by left join users du on du.id = c.decided_by`;
interface Row { id: string; no: string; date: string; reason: string; status: CostAdj['status']; value_change: string | null; lines: StoredLine[]; requested_by: string; decided_by: string | null; decided_at: Date | null; decide_note: string; created_at: Date }

async function toAdj(tx: Tx, x: Row): Promise<CostAdj> {
  const p = await tx.query<{ id: string; sku: string; name: string; units: { name: string }[] }>(`select id, sku, name, units from products where id = any($1::uuid[])`, [x.lines.map((l) => l.productId)]);
  const w = await tx.query<{ id: string; name: string }>(`select id, name from warehouses`);
  const pm = new Map(p.rows.map((r) => [r.id, r]));
  const wm = new Map(w.rows.map((r) => [r.id, r.name]));
  return {
    id: x.id, no: x.no, date: x.date, reason: x.reason, status: x.status, valueChange: x.value_change == null ? null : money(x.value_change),
    lines: x.lines.map((l) => ({
      productId: l.productId, sku: pm.get(l.productId)?.sku ?? '', name: pm.get(l.productId)?.name ?? '', unitName: pm.get(l.productId)?.units[0]?.name ?? '',
      warehouseId: l.warehouseId, warehouseName: l.warehouseId ? wm.get(l.warehouseId) ?? null : null,
      qty: qty4(l.qty), oldCost: qty4(l.oldCost), newCost: qty4(l.newCost), change: money(d(l.newCost).minus(d(l.oldCost)).times(d(l.qty))),
    })),
    requestedBy: x.requested_by, decidedBy: x.decided_by, decidedAt: x.decided_at?.toISOString() ?? null, decideNote: x.decide_note, createdAt: x.created_at.toISOString(),
  };
}

export async function list(tx: Tx, ctx: Ctx, q: { limit: number; cursor?: string; status: 'pending' | 'all' }) {
  needCost(ctx);
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.status === 'pending') where.push(`c.status = 'pending'`);
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(c.created_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<Row>(`${SELECT} ${where.length ? 'where ' + where.join(' and ') : ''} order by c.created_at desc, c.id desc limit $${params.length}`, params);
  const pg = pageOf(r.rows, q.limit, (x) => [x.created_at.toISOString(), x.id], (x) => x);
  return { items: await Promise.all(pg.items.map((x) => toAdj(tx, x))), nextCursor: pg.nextCursor };
}

export async function get(tx: Tx, ctx: Ctx, no: string): Promise<CostAdj> {
  needCost(ctx);
  const r = await tx.query<Row>(`${SELECT} where c.no = $1`, [no]);
  if (!r.rows[0]) throw E.notFound(`ไม่พบใบปรับปรุงต้นทุน ${no}`);
  return toAdj(tx, r.rows[0]);
}

export async function create(tx: Tx, deps: Deps, ctx: Ctx, req: { lines: { productId: string; warehouseId?: string | null; newCost: string }[]; reason: string }): Promise<CostAdj> {
  needCost(ctx);
  if (can(ctx, 'inv.adj') !== 1 && can(ctx, 'inv.adjApprove') !== 1) throw E.forbidden('Permission inv.adj is required', { perm: 'inv.adj' });
  await requireEnabled(tx, ctx);
  const seen = new Set<string>();
  const lines: StoredLine[] = [];
  for (const l of req.lines) {
    const wh = l.warehouseId || null;
    if (!isUuid(l.productId) || (wh && !isUuid(wh))) throw E.validation('Unknown product or warehouse');
    const key = `${l.productId}|${wh ?? ''}`;
    if (seen.has(key)) throw E.validation('สินค้าและคลังซ้ำกันในใบเดียว');
    seen.add(key);
    const p = await tx.query<{ kind: string; name: string }>(`select kind, name from products where id = $1`, [l.productId]);
    if (p.rows[0]?.kind !== 'stock') throw E.validation('ปรับต้นทุนได้เฉพาะสินค้าที่นับสต็อก');
    const h = await onHand(tx, l.productId, wh);
    if (!d(h.qty).gt(0)) throw E.conflict(`${p.rows[0].name} ไม่มีของคงเหลือให้ปรับต้นทุน`);
    if (d(l.newCost).lt(0)) throw E.validation('ต้นทุนใหม่ติดลบไม่ได้');
    lines.push({ productId: l.productId, warehouseId: wh, qty: h.qty, oldCost: h.avgCost, newCost: qty4(l.newCost) });
  }
  if (lines.every((l) => d(l.oldCost).eq(d(l.newCost)))) throw E.validation('ต้นทุนใหม่เท่ากับต้นทุนเดิม');
  const no = await nextDocNo(tx, ctx.tenantId, 'CA', deps.today());
  await tx.query(`insert into cost_adjustments (tenant_id, no, date, lines, reason, requested_by) values ($1,$2,$3,$4,$5,$6)`,
    [ctx.tenantId, no, deps.today(), JSON.stringify(lines), req.reason, ctx.userId]);
  const change = sum(lines.map((l) => d(l.newCost).minus(d(l.oldCost)).times(d(l.qty))));
  await writeAudit(tx, ctx, [{ action: 'create', object: 'cost-adjust', ref: no, detail: `ขอปรับปรุงต้นทุน ${lines.length} รายการ · มูลค่าเปลี่ยน ฿${fmtTHB(money(change))} · ${req.reason}` }]);
  return get(tx, ctx, no);
}

/** Manager / owner approves or rejects; nobody approves their own request except the owner. */
export async function decide(tx: Tx, ctx: Ctx, no: string, body: { approve: boolean; note: string }): Promise<CostAdj> {
  needCost(ctx);
  if (can(ctx, 'inv.adjApprove') !== 1) throw E.forbidden('Permission inv.adjApprove is required', { perm: 'inv.adjApprove' });
  const r = await tx.query<{ id: string; status: string; requested_by: string; lines: StoredLine[] }>(`select id, status, requested_by, lines from cost_adjustments where no = $1 for update`, [no]);
  const c = r.rows[0];
  if (!c) throw E.notFound(`ไม่พบใบปรับปรุงต้นทุน ${no}`);
  if (c.status !== 'pending') throw E.conflict(`${no} ตัดสินแล้ว`);
  if (c.requested_by === ctx.userId && ctx.role !== 'owner') throw E.forbidden('อนุมัติคำขอของตัวเองไม่ได้');
  if (!body.approve) {
    await tx.query(`update cost_adjustments set status = 'rejected', decided_by = $2, decided_at = now(), decide_note = $3 where id = $1`, [c.id, ctx.userId, body.note]);
    await writeAudit(tx, ctx, [{ action: 'reject', object: 'cost-adjust', ref: no, detail: body.note || 'ไม่อนุมัติ' }]);
    return get(tx, ctx, no);
  }
  await requireEnabled(tx, ctx);
  let total = d(0);
  for (const l of c.lines) {
    // Lots move between request and approval: re-read them, change what is on hand now.
    const lots = await tx.query<{ id: string; warehouse_id: string; remaining: string; unit_cost: string }>(
      `select id::text, warehouse_id, remaining::text, unit_cost::text from stock_lots where product_id = $1 and remaining > 0 and ($2::uuid is null or warehouse_id = $2) order by id for update`,
      [l.productId, l.warehouseId]);
    const byWh = new Map<string, ReturnType<typeof d>>();
    for (const lot of lots.rows) {
      const diff = d(l.newCost).minus(d(lot.unit_cost)).times(d(lot.remaining));
      byWh.set(lot.warehouse_id, (byWh.get(lot.warehouse_id) ?? d(0)).plus(diff));
    }
    await tx.query(`update stock_lots set unit_cost = $3 where product_id = $1 and remaining > 0 and ($2::uuid is null or warehouse_id = $2)`, [l.productId, l.warehouseId, l.newCost]);
    for (const [wh, diff] of byWh) {
      total = total.plus(diff);
      await tx.query(
        `insert into stock_moves (tenant_id, doc_type, doc_no, doc_id, product_id, warehouse_id, qty, cost, note, user_id) values ($1,'CA',$2,$3,$4,$5,0,$6,$7,$8)`,
        [ctx.tenantId, no, c.id, l.productId, wh, money(diff), `ปรับปรุงต้นทุนเป็น ${qty4(l.newCost)}/หน่วย · มูลค่าเปลี่ยน ${money(diff)}`, ctx.userId]);
    }
    // Moving-average cost shown on the product follows the stock it now describes.
    const all = await onHand(tx, l.productId, null);
    if (d(all.qty).gt(0)) await tx.query(`update products set cost = $2 where id = $1`, [l.productId, all.avgCost]);
  }
  await tx.query(`update cost_adjustments set status = 'approved', decided_by = $2, decided_at = now(), decide_note = $3, value_change = $4 where id = $1`, [c.id, ctx.userId, body.note, money(total)]);
  await writeAudit(tx, ctx, [{ action: 'approve', object: 'cost-adjust', ref: no, detail: `ปรับปรุงต้นทุน ${c.lines.length} รายการ · มูลค่าสต็อกเปลี่ยน ฿${fmtTHB(money(total))}${body.note ? ` · ${body.note}` : ''}` }]);
  return get(tx, ctx, no);
}
