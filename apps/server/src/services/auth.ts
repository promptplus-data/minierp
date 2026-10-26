/** Login (M01): argon2id, lock after 5 failures, resigned users rejected; every attempt audited (BR-18). */
import argon2 from 'argon2';
import { withTenant, type Pool, type Tx } from '@erp/db';
import type { SessionUser } from '@erp/contracts';
import { PERM_KEYS, perm, type Role } from '@erp/core';
import { writeAudit } from '../lib/audit';
import type { Ctx } from '../lib/context';
import { E, isUuid } from '../lib/errors';

export const MAX_FAILED_LOGINS = 5;

export const sessionUser = (u: { id: string; name: string; role: Role }): SessionUser => ({
  id: u.id, name: u.name, role: u.role, perms: Object.fromEntries(PERM_KEYS.map((k) => [k, perm(u.role, k)])),
});

interface UserRow { id: string; tenant_id: string; name: string; role: Role; password_hash: string; status: string; failed_logins: number; locked_at: Date | null }

type Outcome = { ok: true; user: UserRow } | { ok: false; reason: 'BAD_CREDENTIALS' | 'LOCKED' | 'RESIGNED' };

export async function login(pool: Pool, body: { username: string; password: string; tenant?: string }): Promise<Ctx> {
  // 1. Find the user across tenants (the only cross-tenant read: app.auth_lookup, SELECT-only policy).
  const found = await withTenant(pool, null, (tx) =>
    tx.query<{ id: string; tenant_id: string }>(
      `select u.id, u.tenant_id from users u join tenants t on t.id = u.tenant_id
        where u.username = $1 and ($2::text is null or t.code = $2)`,
      [body.username, body.tenant ?? null],
    ), { authLookup: true });
  if (found.rows.length > 1) throw E.unauthorized('This username exists in several shops; give the shop code', { reason: 'TENANT_REQUIRED' });
  const hit = found.rows[0];
  if (!hit) {
    await argon2.hash(body.password).catch(() => undefined); // same work as a real check (timing)
    throw E.unauthorized('Wrong username or password', { reason: 'BAD_CREDENTIALS' });
  }

  // 2. Check and record the attempt inside the user's tenant; the audit row commits even when login fails.
  const outcome = await withTenant(pool, hit.tenant_id, async (tx): Promise<Outcome> => {
    const u = (await tx.query<UserRow>(
      `select id, tenant_id, name, role, password_hash, status, failed_logins, locked_at from users where id = $1 for update`, [hit.id],
    )).rows[0]!;
    const who = { tenantId: u.tenant_id, userId: u.id, name: u.name };
    if (u.status !== 'active') {
      await writeAudit(tx, who, [{ action: 'login-failed', object: 'user', ref: body.username, detail: 'ผู้ใช้ลาออกแล้ว (resigned)' }]);
      return { ok: false, reason: 'RESIGNED' };
    }
    if (u.locked_at) {
      await writeAudit(tx, who, [{ action: 'login-failed', object: 'user', ref: body.username, detail: 'บัญชีถูกล็อก' }]);
      return { ok: false, reason: 'LOCKED' };
    }
    const ok = await argon2.verify(u.password_hash, body.password).catch(() => false);
    if (!ok) {
      const n = u.failed_logins + 1;
      const lock = n >= MAX_FAILED_LOGINS;
      await tx.query(`update users set failed_logins = $2, locked_at = case when $3 then now() else locked_at end where id = $1`, [u.id, n, lock]);
      await writeAudit(tx, who, [{ action: lock ? 'locked' : 'login-failed', object: 'user', ref: body.username, detail: `รหัสผ่านผิด ครั้งที่ ${n}${lock ? ' · ล็อกบัญชี' : ''}` }]);
      return { ok: false, reason: lock ? 'LOCKED' : 'BAD_CREDENTIALS' };
    }
    if (u.failed_logins) await tx.query(`update users set failed_logins = 0 where id = $1`, [u.id]);
    await writeAudit(tx, who, [{ action: 'login', object: 'user', ref: body.username, detail: '' }]);
    return { ok: true, user: u };
  });
  if (!outcome.ok) {
    const msg = { BAD_CREDENTIALS: 'Wrong username or password', LOCKED: 'Account locked after too many failed logins; ask the owner to unlock it', RESIGNED: 'This user has resigned' }[outcome.reason];
    throw E.unauthorized(msg, { reason: outcome.reason });
  }
  const u = outcome.user;
  return { tenantId: u.tenant_id, userId: u.id, name: u.name, role: u.role };
}

/** Re-reads the token's user on every request: resigned or role-changed users take effect immediately. */
export async function loadActiveUser(tx: Tx, userId: string): Promise<{ id: string; name: string; role: Role } | null> {
  if (!isUuid(userId)) return null;
  const r = await tx.query<{ id: string; name: string; role: Role; status: string; locked: boolean }>(
    `select id, name, role, status, locked_at is not null locked from users where id = $1`, [userId]);
  const u = r.rows[0];
  return u && u.status === 'active' && !u.locked ? u : null; // resigned or locked: existing tokens stop working
}

/** Clears the login lock and the approval-PIN lock. Owner: anyone; manager: anyone except an owner. */
export async function unlockUser(tx: Tx, ctx: Ctx, userId: string): Promise<{ id: string; status: string }> {
  if (ctx.role !== 'owner' && ctx.role !== 'manager' && perm(ctx.role, 'sys.users') !== 1) throw E.forbidden('Only the owner or a manager can unlock users');
  if (!isUuid(userId)) throw E.notFound('User not found');
  const target = (await tx.query<{ role: Role }>(`select role from users where id = $1`, [userId])).rows[0];
  if (!target) throw E.notFound('User not found');
  if (target.role === 'owner' && ctx.role !== 'owner') throw E.forbidden('Only the owner can unlock the owner');
  const r = await tx.query<{ id: string; username: string; status: string }>(
    `update users set failed_logins = 0, locked_at = null, pin_failed = 0, pin_locked_until = null where id = $1 returning id, username, status`, [userId]);
  if (!r.rows[0]) throw E.notFound('User not found');
  await writeAudit(tx, ctx, [{ action: 'unlock', object: 'user', ref: r.rows[0].username }]);
  return { id: r.rows[0].id, status: r.rows[0].status };
}
