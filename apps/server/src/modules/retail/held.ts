/**
 * REQ-M07-08 held POS bills: several carts per device, kept server-side per shift. Holding never touches stock
 * (nothing is reserved); resuming hands the cart back to the POS, which prices and sells it as a normal bill.
 */
import type { Tx } from '@erp/db';
import type { HeldBill } from '@erp/contracts';
import { z } from 'zod';
import { HeldCart } from '@erp/contracts';
import { fmtTHB, money } from '@erp/core';
import { writeAudit } from '../../lib/audit';
import { requirePerm, type Ctx } from '../../lib/context';
import { E, isUuid } from '../../lib/errors';
import { decodeCursor, pageOf } from '../../lib/paging';
import { requireOwnOpenShift } from '../../services/sales';

/** At most this many bills on hold per shift (a cashier who needs more should finish some). */
export const MAX_HELD = 10;

interface Row { id: string; label: string; customer: string | null; item_count: number; total: string; status: HeldBill['status']; created_at: Date; user_name: string; cart: unknown }
const SELECT = `select h.id, h.label, c.name customer, h.item_count, h.total::text, h.status, h.created_at, u.name user_name, h.cart
  from retail_held_bills h join users u on u.id = h.user_id left join customers c on c.id = h.customer_id`;
const toHeld = (r: Row): HeldBill => ({
  id: r.id, label: r.label, customer: r.customer, itemCount: r.item_count, total: money(r.total), status: r.status, createdAt: r.created_at.toISOString(),
  userName: r.user_name, cart: HeldCart.parse(r.cart),
});

export async function listHeld(tx: Tx, ctx: Ctx, q: { limit: number; cursor?: string; shiftId?: string }) {
  requirePerm(ctx, 'pos.sell');
  const shift = await requireOwnOpenShift(tx, ctx, q.shiftId);
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [shift.id];
  let where = `h.shift_id = $1 and h.status = 'held'`;
  if (cur) {
    params.push(cur[0], cur[1]);
    where += ` and (h.created_at, h.id) > ($2::timestamptz, $3::uuid)`;
  }
  params.push(q.limit + 1);
  const r = await tx.query<Row>(`${SELECT} where ${where} order by h.created_at, h.id limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (x) => [x.created_at.toISOString(), x.id], toHeld);
}

export async function holdBill(tx: Tx, ctx: Ctx, body: { shiftId: string; label?: string; cart: z.infer<typeof HeldCart>; total: string }): Promise<HeldBill> {
  requirePerm(ctx, 'pos.sell');
  const shift = await requireOwnOpenShift(tx, ctx, body.shiftId);
  const items = body.cart.lines.length + body.cart.bundles.length;
  if (!items) throw E.validation('Nothing to hold: the bill is empty');
  if (body.cart.lines.some((l) => !isUuid(l.productId)) || body.cart.bundles.some((b) => !isUuid(b.promoId))) throw E.validation('Unknown product in the bill');
  if (body.cart.customerId && !isUuid(body.cart.customerId)) throw E.validation('Unknown customer');
  // Serialise holds of one shift so the cap holds under concurrent requests.
  await tx.query(`select id from shifts where id = $1 for update`, [shift.id]);
  const n = (await tx.query<{ n: number }>(`select count(*)::int n from retail_held_bills where shift_id = $1 and status = 'held'`, [shift.id])).rows[0]!.n;
  if (n >= MAX_HELD) throw E.conflict(`At most ${MAX_HELD} bills can be on hold; resume or discard one first`, { max: MAX_HELD });
  const label = body.label?.trim() || `บิลพัก ${n + 1}`;
  const r = await tx.query<{ id: string }>(
    `insert into retail_held_bills (tenant_id, shift_id, device_id, user_id, label, customer_id, cart, item_count, total) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [ctx.tenantId, shift.id, shift.device_id, ctx.userId, label, body.cart.customerId ?? null, JSON.stringify(body.cart), items, body.total],
  );
  await writeAudit(tx, ctx, [{ action: 'hold', object: 'pos-bill', ref: shift.no, detail: `${label} · ${items} รายการ · ฿${fmtTHB(body.total)}` }]);
  return toHeld((await tx.query<Row>(`${SELECT} where h.id = $1`, [r.rows[0]!.id])).rows[0]!);
}

async function closeHeld(tx: Tx, ctx: Ctx, id: string, status: 'resumed' | 'discarded'): Promise<HeldBill> {
  requirePerm(ctx, 'pos.sell');
  if (!isUuid(id)) throw E.notFound('Held bill not found');
  const row = (await tx.query<Row & { shift_id: string }>(`${SELECT.replace('h.cart', 'h.cart, h.shift_id')} where h.id = $1 for update of h`, [id])).rows[0];
  if (!row) throw E.notFound('Held bill not found');
  const shift = await requireOwnOpenShift(tx, ctx);
  if (row.shift_id !== shift.id) throw E.forbidden('This bill is held on another shift');
  if (row.status !== 'held') throw E.conflict(`This bill was already ${row.status}`);
  await tx.query(`update retail_held_bills set status = $2, closed_at = now(), closed_by = $3 where id = $1`, [id, status, ctx.userId]);
  await writeAudit(tx, ctx, [{ action: status === 'resumed' ? 'resume' : 'discard', object: 'pos-bill', ref: shift.no, detail: `${row.label} · ${row.item_count} รายการ · ฿${fmtTHB(row.total)}` }]);
  return { ...toHeld(row), status };
}

export const resumeHeld = (tx: Tx, ctx: Ctx, id: string) => closeHeld(tx, ctx, id, 'resumed');
export const discardHeld = (tx: Tx, ctx: Ctx, id: string) => closeHeld(tx, ctx, id, 'discarded');
