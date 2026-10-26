/** Cashier shifts (M07-06): open with float, cash in/out, X report (current), close with count (Z). */
import type { Tx } from '@erp/db';
import type { Shift } from '@erp/contracts';
import { d, fmtTHB, money, shiftDiff, shiftExpected, sum } from '@erp/core';
import { writeAudit } from '../lib/audit';
import { can, type Ctx, type Deps } from '../lib/context';
import { nextDocNo } from '../lib/docno';
import { E, isUuid } from '../lib/errors';

interface ShiftRow { id: string; no: string; user_id: string; device_id: string; opened_at: Date; closed_at: Date | null; float: string; counted: string | null; expected: string | null; diff: string | null; summary: Summary | null }
interface Summary { cashSales: string; cashRefunds: string; cashIn: string; cashOut: string; byMethod: Record<string, string>; bills: number; voids: number }

const SHIFT_COLS = `id, no, user_id, device_id, opened_at, closed_at, float::text, counted::text, expected::text, diff::text, summary`;

function requireShiftPerm(ctx: Ctx): void {
  if (can(ctx, 'fin.shift') !== 1 && can(ctx, 'pos.sell') !== 1) throw E.forbidden('Permission fin.shift or pos.sell is required');
}

/** Live totals for a shift (mockup shiftSum): live sales payments by method, cash refunds on CNs, cash moves. */
async function summarize(tx: Tx, shiftId: string): Promise<Summary> {
  const sales = await tx.query<{ payments: { method: string; amount: string }[]; status: string }>(
    `select payments, status from docs where shift_id = $1 and type in ('ABB','INV','RC')`,
    [shiftId],
  );
  const by: Record<string, ReturnType<typeof d>> = {};
  for (const s of sales.rows.filter((x) => x.status === 'active')) for (const p of s.payments) by[p.method] = (by[p.method] ?? d(0)).plus(d(p.amount));
  const refunds = await tx.query<{ t: string | null }>(`select sum(total)::text t from docs where shift_id = $1 and type = 'CN' and status = 'active' and refund = 'cash'`, [shiftId]);
  const moves = await tx.query<{ type: 'in' | 'out'; amount: string }>(`select type, amount::text from shift_moves where shift_id = $1`, [shiftId]);
  return {
    cashSales: money(by.cash ?? 0),
    cashRefunds: money(refunds.rows[0]?.t ?? 0),
    cashIn: money(sum(moves.rows.filter((m) => m.type === 'in').map((m) => m.amount))),
    cashOut: money(sum(moves.rows.filter((m) => m.type === 'out').map((m) => m.amount))),
    byMethod: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, money(v)])),
    bills: sales.rows.filter((x) => x.status === 'active').length,
    voids: sales.rows.filter((x) => x.status === 'void').length,
  };
}

async function toShift(tx: Tx, r: ShiftRow): Promise<Shift> {
  const s = r.summary ?? (await summarize(tx, r.id));
  return {
    id: r.id, no: r.no, userId: r.user_id, deviceId: r.device_id, openedAt: r.opened_at.toISOString(), closedAt: r.closed_at?.toISOString() ?? null,
    float: money(r.float), cashSales: s.cashSales, cashRefunds: s.cashRefunds, cashIn: s.cashIn, cashOut: s.cashOut,
    expected: r.expected ?? shiftExpected({ float: r.float, ...s }), counted: r.counted, diff: r.diff, byMethod: s.byMethod,
  };
}

/** X report: the caller's open shift with live totals, or null. */
export async function currentShift(tx: Tx, ctx: Ctx): Promise<Shift | null> {
  const r = await tx.query<ShiftRow>(`select ${SHIFT_COLS} from shifts where user_id = $1 and closed_at is null`, [ctx.userId]);
  return r.rows[0] ? toShift(tx, r.rows[0]) : null;
}

export async function openShift(tx: Tx, deps: Deps, ctx: Ctx, body: { float: string; deviceId: string }): Promise<Shift> {
  requireShiftPerm(ctx);
  if (d(body.float).lt(0)) throw E.validation('Float must be >= 0');
  const open = await tx.query(`select no from shifts where user_id = $1 and closed_at is null`, [ctx.userId]);
  if (open.rowCount) throw E.conflict(`You already have an open shift (${open.rows[0].no})`);
  const no = await nextDocNo(tx, ctx.tenantId, 'SH', deps.today());
  const r = await tx.query<ShiftRow>(
    `insert into shifts (tenant_id, no, user_id, device_id, float) values ($1,$2,$3,$4,$5) returning ${SHIFT_COLS}`,
    [ctx.tenantId, no, ctx.userId, body.deviceId, body.float],
  );
  await writeAudit(tx, ctx, [{ action: 'open', object: 'shift', ref: no, detail: `เงินทอนตั้งต้น ฿${fmtTHB(body.float)} · เครื่อง ${body.deviceId}` }]);
  return toShift(tx, r.rows[0]!);
}

/** Own shift, or any shift for owner / manager. Locked for the rest of the transaction. */
async function lockOpenShift(tx: Tx, ctx: Ctx, id: string): Promise<ShiftRow> {
  if (!isUuid(id)) throw E.notFound('Shift not found');
  const r = await tx.query<ShiftRow>(`select ${SHIFT_COLS} from shifts where id = $1 for update`, [id]);
  const s = r.rows[0];
  if (!s) throw E.notFound('Shift not found');
  if (s.user_id !== ctx.userId && !['owner', 'manager'].includes(ctx.role)) throw E.forbidden('Not your shift');
  if (s.closed_at) throw E.conflict(`Shift ${s.no} is already closed`);
  return s;
}

export async function cashMove(tx: Tx, ctx: Ctx, id: string, body: { type: 'in' | 'out'; amount: string; note: string }): Promise<Shift> {
  requireShiftPerm(ctx);
  if (!d(body.amount).gt(0)) throw E.validation('Amount must be > 0');
  const s = await lockOpenShift(tx, ctx, id);
  await tx.query(`insert into shift_moves (tenant_id, shift_id, type, amount, note, user_id) values ($1,$2,$3,$4,$5,$6)`, [ctx.tenantId, s.id, body.type, body.amount, body.note, ctx.userId]);
  await writeAudit(tx, ctx, [{ action: body.type === 'in' ? 'cash-in' : 'cash-out', object: 'shift', ref: s.no, detail: `฿${fmtTHB(body.amount)} · ${body.note}` }]);
  return toShift(tx, s);
}

export async function closeShift(tx: Tx, deps: Deps, ctx: Ctx, id: string, body: { counted: string; note?: string }): Promise<Shift> {
  requireShiftPerm(ctx);
  if (d(body.counted).lt(0)) throw E.validation('Counted cash must be >= 0');
  const s = await lockOpenShift(tx, ctx, id);
  const sum0 = await summarize(tx, s.id);
  const expected = shiftExpected({ float: s.float, ...sum0 });
  const diff = shiftDiff(expected, body.counted);
  const note = body.note?.trim() ?? '';
  if (!d(diff).isZero() && !note) throw E.validation(`Cash differs by ${diff}; a note is required`, { expected, counted: money(body.counted), diff });
  const r = await tx.query<ShiftRow>(
    `update shifts set closed_at = now(), summary = $2, counted = $3, expected = $4, diff = $5, note = $6 where id = $1 returning ${SHIFT_COLS}`,
    [s.id, JSON.stringify(sum0), body.counted, expected, diff, note || null],
  );
  await deps.hooks.beforeCommit?.('closeShift', tx);
  await writeAudit(tx, ctx, [{ action: 'close', object: 'shift', ref: s.no, detail: `ควรมี ฿${fmtTHB(expected)} · นับได้ ฿${fmtTHB(body.counted)} · ต่าง ${diff}${note ? ' · ' + note : ''}` }]);
  return toShift(tx, r.rows[0]!);
}
