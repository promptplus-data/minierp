/**
 * REQ-M01-07 POS machines: the POS ID the Revenue Department approved for each machine (ภ.พ.06).
 * A machine is identified by the device name its shifts are opened on (shifts.device_id).
 * Rule: once the shop has registered any machine, an abbreviated tax invoice (ABB) can only be issued on a machine
 * that is registered, approved and has a POS ID; other machines issue full tax invoices only (REQ-M07-04).
 * A shop that has not set up the registry yet keeps the Phase 1 behaviour.
 */
import { searchTokens } from '@erp/core';
import type { Tx } from '@erp/db';
import type { PosDevice } from '@erp/contracts';
import { z } from 'zod';
import { PosDeviceInput, PosDeviceUpdate } from '@erp/contracts';
import { writeAudit } from '../../lib/audit';
import { requireAny, requirePerm, type Ctx } from '../../lib/context';
import { E, isUuid } from '../../lib/errors';
import { decodeCursor, likeEscape, pageOf } from '../../lib/paging';
import { iso } from './common';

const STATUS_TH: Record<PosDevice['status'], string> = { pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว', retired: 'เลิกใช้' };

interface Row {
  id: string; code: string; name: string; rd_pos_id: string | null; approved_on: string | null; status: PosDevice['status']; note: string;
  created_by: string; created_at: Date; updated_by: string | null; updated_at: Date | null;
}
const SELECT = `select d.id, d.code, d.name, d.rd_pos_id, d.approved_on, d.status, d.note, cu.name created_by, d.created_at, uu.name updated_by, d.updated_at
  from retail_pos_devices d join users cu on cu.id = d.created_by left join users uu on uu.id = d.updated_by`;
const toDevice = (r: Row): PosDevice => ({
  id: r.id, code: r.code, name: r.name, rdPosId: r.rd_pos_id, approvedOn: r.approved_on, status: r.status, note: r.note,
  canIssueAbb: r.status === 'approved' && !!r.rd_pos_id, createdBy: r.created_by, createdAt: r.created_at.toISOString(), updatedBy: r.updated_by, updatedAt: iso(r.updated_at),
});

/** Everyone who sells or sets up the shop may read the list (the POS needs it to grey out ABB). */
export async function listDevices(tx: Tx, ctx: Ctx, q: { q?: string; limit: number; cursor?: string; status?: PosDevice['status'] }) {
  requireAny(ctx, ['sys.settings', 'pos.sell', 'fin.shift'], { readOnly: true });
  const cur = decodeCursor(q.cursor, 1);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.status) {
    params.push(q.status);
    where.push(`d.status = $${params.length}`);
  }
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(d.code ilike $${params.length} or d.name ilike $${params.length} or coalesce(d.rd_pos_id,'') ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0]);
    where.push(`d.code > $${params.length}`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<Row>(`${SELECT} ${where.length ? 'where ' + where.join(' and ') : ''} order by d.code limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (x) => [x.code], toDevice);
}

function check(b: { status?: PosDevice['status']; rdPosId?: string | null; approvedOn?: string | null }): void {
  if (b.rdPosId != null && b.rdPosId !== '' && !/^[A-Za-z0-9-]{6,40}$/.test(b.rdPosId)) throw E.validation('POS ID must be 6–40 letters or digits');
  if (b.status === 'approved' && (!b.rdPosId || !b.approvedOn)) throw E.validation('An approved machine needs its POS ID and the approval date');
}

export async function createDevice(tx: Tx, ctx: Ctx, b: z.infer<typeof PosDeviceInput>): Promise<PosDevice> {
  requirePerm(ctx, 'sys.settings');
  const rd = b.rdPosId?.trim() || null;
  check({ ...b, rdPosId: rd });
  const dup = await tx.query(`select 1 from retail_pos_devices where code = $1`, [b.code]);
  if (dup.rowCount) throw E.conflict(`Machine ${b.code} is already registered`);
  const r = await tx.query<{ id: string }>(
    `insert into retail_pos_devices (tenant_id, code, name, rd_pos_id, approved_on, status, note, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [ctx.tenantId, b.code, b.name, rd, b.approvedOn ?? null, b.status, b.note, ctx.userId],
  );
  await writeAudit(tx, ctx, [{ action: 'create', object: 'pos-device', ref: b.code, detail: `${b.name} · POS ID ${rd ?? '-'} · ${STATUS_TH[b.status]}` }]);
  return toDevice((await tx.query<Row>(`${SELECT} where d.id = $1`, [r.rows[0]!.id])).rows[0]!);
}

export async function updateDevice(tx: Tx, ctx: Ctx, id: string, b: z.infer<typeof PosDeviceUpdate>): Promise<PosDevice> {
  requirePerm(ctx, 'sys.settings');
  if (!isUuid(id)) throw E.notFound('Machine not found');
  const row = (await tx.query<Row>(`${SELECT} where d.id = $1 for update of d`, [id])).rows[0];
  if (!row) throw E.notFound('Machine not found');
  const next = {
    name: b.name ?? row.name,
    rdPosId: b.rdPosId !== undefined ? b.rdPosId?.trim() || null : row.rd_pos_id,
    approvedOn: b.approvedOn !== undefined ? b.approvedOn : row.approved_on,
    status: b.status ?? row.status,
    note: b.note ?? row.note,
  };
  check(next);
  await tx.query(
    `update retail_pos_devices set name = $2, rd_pos_id = $3, approved_on = $4, status = $5, note = $6, updated_by = $7, updated_at = now() where id = $1`,
    [id, next.name, next.rdPosId, next.approvedOn, next.status, next.note, ctx.userId],
  );
  const diffs: string[] = [];
  const diff = (label: string, a: unknown, c: unknown) => { if (String(a ?? '') !== String(c ?? '')) diffs.push(`${label}: ${a ?? '-'} → ${c ?? '-'}`); };
  diff('ชื่อ', row.name, next.name);
  diff('POS ID', row.rd_pos_id, next.rdPosId);
  diff('วันที่อนุมัติ', row.approved_on, next.approvedOn);
  diff('สถานะ', STATUS_TH[row.status], STATUS_TH[next.status]);
  diff('หมายเหตุ', row.note, next.note);
  await writeAudit(tx, ctx, [{ action: 'update', object: 'pos-device', ref: row.code, detail: diffs.join(' · ') || 'ไม่มีการเปลี่ยนแปลง' }]);
  return toDevice((await tx.query<Row>(`${SELECT} where d.id = $1`, [id])).rows[0]!);
}

/**
 * Called by posSale before an ABB is numbered. Returns the machine's POS ID (null when the shop has no registry).
 * Throws VALIDATION with reason POS_ID_REQUIRED when the machine may not issue abbreviated tax invoices.
 */
export async function requireAbbDevice(tx: Tx, deviceCode: string): Promise<string | null> {
  const any = await tx.query(`select 1 from retail_pos_devices limit 1`);
  if (!any.rowCount) return null; // registry not set up
  const dev = (await tx.query<{ rd_pos_id: string | null; status: PosDevice['status'] }>(
    `select rd_pos_id, status from retail_pos_devices where code = $1`, [deviceCode])).rows[0];
  if (!dev || dev.status !== 'approved' || !dev.rd_pos_id) {
    throw E.validation(`Machine ${deviceCode} has no approved POS ID; issue a full tax invoice instead`, {
      reason: 'POS_ID_REQUIRED', device: deviceCode, status: dev?.status ?? 'unregistered',
    });
  }
  return dev.rd_pos_id;
}

/** POS ID printed on an issued ABB (null when the machine is not registered). */
export async function posIdOf(tx: Tx, deviceCode: string | null): Promise<string | null> {
  if (!deviceCode) return null;
  const r = await tx.query<{ rd_pos_id: string | null }>(`select rd_pos_id from retail_pos_devices where code = $1`, [deviceCode]);
  return r.rows[0]?.rd_pos_id ?? null;
}
