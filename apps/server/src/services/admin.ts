/** Audit log reads (BR-18) and on-prem client pairing. */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { withTenant, type Pool, type Tx } from '@erp/db';
import type { PageQuery } from '@erp/contracts';
import { writeAudit } from '../lib/audit';
import { requirePerm, type Ctx } from '../lib/context';
import { E } from '../lib/errors';
import { decodeCursor, pageOf } from '../lib/paging';

export async function auditLog(tx: Tx, ctx: Ctx, q: PageQuery) {
  requirePerm(ctx, 'sys.log', { readOnly: true });
  const cur = decodeCursor(q.cursor, 1);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.q) {
    params.push(`%${q.q}%`);
    where.push(`(action ilike $1 or object ilike $1 or coalesce(ref,'') ilike $1 or detail ilike $1 or user_name ilike $1)`);
  }
  if (cur) {
    params.push(cur[0]);
    where.push(`chain_seq < $${params.length}::bigint`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<{ id: string; chain_seq: string; at: Date; user_name: string; action: string; object: string; ref: string | null; detail: string }>(
    `select id::text, chain_seq::text, at, user_name, action, object, ref, detail from audit_log
      ${where.length ? 'where ' + where.join(' and ') : ''} order by audit_log.chain_seq desc limit $${params.length}`,
    params,
  );
  return pageOf(r.rows, q.limit, (a) => [a.chain_seq], (a) => ({ id: a.id, at: a.at.toISOString(), user: a.user_name, action: a.action, object: a.object, ref: a.ref, detail: a.detail }));
}

/** Recomputes the tenant's hash chain; brokenAt is the first chain_seq that does not verify. */
export async function verifyAudit(tx: Tx, ctx: Ctx): Promise<{ ok: boolean; brokenAt: string | null; rows: number }> {
  requirePerm(ctx, 'sys.log', { readOnly: true });
  const r = await tx.query<{ broken: string | null; n: string }>(`select erp_audit_verify($1)::text broken, (select count(*) from audit_log)::text n`, [ctx.tenantId]);
  return { ok: r.rows[0]!.broken == null, brokenAt: r.rows[0]!.broken, rows: Number(r.rows[0]!.n) };
}

export const PAIRING_TTL_MIN = 10;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createPairingCode(tx: Tx, ctx: Ctx): Promise<{ code: string; expiresAt: string }> {
  if (!['owner', 'manager'].includes(ctx.role)) throw E.forbidden('Only the owner or a manager can pair a new machine');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const r = await tx.query<{ expires_at: Date }>(
    `insert into pairing_codes (tenant_id, code, expires_at, created_by) values ($1,$2, now() + make_interval(mins => $3), $4) returning expires_at`,
    [ctx.tenantId, code, PAIRING_TTL_MIN, ctx.userId],
  );
  await writeAudit(tx, ctx, [{ action: 'create', object: 'pairing-code', detail: `หมดอายุใน ${PAIRING_TTL_MIN} นาที` }]);
  return { code, expiresAt: r.rows[0]!.expires_at.toISOString() };
}

/** Consumes a valid, unexpired, unused code and returns a new device token (only its hash is stored). */
export async function redeemPairingCode(pool: Pool, code: string, deviceName: string): Promise<{ token: string; deviceId: string } | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const hit = await withTenant(pool, null, (tx) =>
    tx.query<{ id: string; tenant_id: string }>(
      `select id, tenant_id from pairing_codes where code = $1 and used_at is null and expires_at > now() order by created_at desc limit 1`, [code],
    ), { authLookup: true });
  const row = hit.rows[0];
  if (!row) return null;
  return withTenant(pool, row.tenant_id, async (tx) => {
    const used = await tx.query(`update pairing_codes set used_at = now() where id = $1 and used_at is null`, [row.id]);
    if (!used.rowCount) return null; // raced with another redeem
    const token = randomBytes(32).toString('base64url');
    const dev = await tx.query<{ id: string }>(`insert into devices (tenant_id, name, token_hash) values ($1,$2,$3) returning id`, [row.tenant_id, deviceName, sha256(token)]);
    await writeAudit(tx, { tenantId: row.tenant_id, userId: null, name: 'system' }, [{ action: 'pair', object: 'device', ref: dev.rows[0]!.id, detail: deviceName }]);
    return { token, deviceId: dev.rows[0]!.id };
  });
}
