/** REQ-M14-05 shop side (cloud): the owner allows SCG support a read-only look for 1–30 days and can revoke it. */
import type { Tx } from '@erp/db';
import { writeAudit } from '../../lib/audit';
import type { Ctx } from '../../lib/context';
import { E, isUuid } from '../../lib/errors';
import { requireOwner } from './backup';

interface GrantRow { id: string; by: string; note: string; expires_at: Date; revoked_at: Date | null; created_at: Date }
const toGrant = (r: GrantRow) => ({
  id: r.id, grantedBy: r.by, note: r.note, expiresAt: r.expires_at.toISOString(), revokedAt: r.revoked_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(), active: !r.revoked_at && r.expires_at.getTime() > Date.now(),
});
const SELECT = `select g.id, u.name by, g.note, g.expires_at, g.revoked_at, g.created_at from support_grants g join users u on u.id = g.granted_by`;

export async function listGrants(tx: Tx, ctx: Ctx) {
  requireOwner(ctx, 'manage SCG support access');
  return { items: (await tx.query<GrantRow>(`${SELECT} order by g.created_at desc limit 50`)).rows.map(toGrant) };
}

export async function createGrant(tx: Tx, ctx: Ctx, body: { days: number; note: string }) {
  requireOwner(ctx, 'manage SCG support access');
  const r = await tx.query<{ id: string }>(
    `insert into support_grants (tenant_id, granted_by, note, expires_at) values ($1,$2,$3, now() + make_interval(days => $4)) returning id`,
    [ctx.tenantId, ctx.userId, body.note, body.days]);
  const g = (await tx.query<GrantRow>(`${SELECT} where g.id = $1`, [r.rows[0]!.id])).rows[0]!;
  await writeAudit(tx, ctx, [{ action: 'grant', object: 'support-access', ref: null, detail: `อนุญาต SCG ดูข้อมูลแบบอ่านอย่างเดียว ${body.days} วัน ถึง ${g.expires_at.toISOString()}${body.note ? ` · ${body.note}` : ''}` }]);
  return toGrant(g);
}

export async function revokeGrant(tx: Tx, ctx: Ctx, id: string) {
  requireOwner(ctx, 'manage SCG support access');
  if (!isUuid(id)) throw E.notFound('Grant not found');
  const r = await tx.query(`update support_grants set revoked_at = now(), revoked_by = $2 where id = $1 and revoked_at is null`, [id, ctx.userId]);
  if (!r.rowCount) throw E.notFound('Grant not found or already revoked');
  const g = (await tx.query<GrantRow>(`${SELECT} where g.id = $1`, [id])).rows[0]!;
  await writeAudit(tx, ctx, [{ action: 'revoke', object: 'support-access', ref: null, detail: 'ยกเลิกสิทธิ์ SCG ดูข้อมูลร้าน' }]);
  return toGrant(g);
}
