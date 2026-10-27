/**
 * M14 SCG Admin sign-in (cloud only). Platform administrators are not shop users: their JWT carries `adm: true` and
 * no tenant id (so the shop `authed()` refuses it), and their requests run in a transaction with app.platform = 'on'
 * and NO app.tenant_id, so RLS still hides every shop table (BR-14). Cross-shop numbers come only from the
 * SECURITY DEFINER functions of 0401_platform_admin.sql; writes into a shop run in that shop's own transaction.
 */
import argon2 from 'argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withTenant, type Pool, type Tx } from '@erp/db';
import type { AdmRole, AdmUser } from '@erp/contracts';
import { E, isUuid } from '../../lib/errors';

export interface AdmCtx { adminId: string; name: string; username: string; role: AdmRole }
export type AdmHandler = (tx: Tx, a: AdmCtx, req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
interface AdmClaims { sub: string; adm?: boolean; tid?: string }

export const ADM_MAX_FAILED = 5;

/** Which SCG roles may do what (mockup VIEWS.adm_users). super may do everything. */
export const ADM_CAN = {
  shopsWrite: ['super', 'onboarding'],
  support: ['super', 'support'],
  masterWrite: ['super', 'master'],
  licenseWrite: ['super', 'onboarding'],
  admins: ['super'],
  audit: ['super'],
} as const satisfies Record<string, readonly AdmRole[]>;

export function requireAdm(a: AdmCtx, allowed: readonly AdmRole[]): void {
  if (!allowed.includes(a.role)) throw E.forbidden(`SCG role ${a.role} cannot do this`, { reason: 'ADM_ROLE', allowed });
}

/** One transaction in platform context (no shop). */
export async function withPlatform<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(pool, null, async (tx) => {
    await tx.query(`select set_config('app.platform', 'on', true)`);
    return fn(tx);
  });
}

export async function admAudit(tx: Tx, a: Pick<AdmCtx, 'adminId' | 'name'> | null, action: string, object: string, ref: string | null, detail = ''): Promise<void> {
  await tx.query(`insert into platform_audit (admin_id, admin_name, action, object, ref, detail) values ($1,$2,$3,$4,$5,$6)`,
    [a?.adminId ?? null, a?.name ?? 'system', action, object, ref, detail]);
}

interface AdminRow { id: string; username: string; name: string; role: AdmRole; status: 'active' | 'disabled'; password_hash: string; failed_logins: number; locked_at: Date | null; last_login_at: Date | null }
export const toAdmUser = (r: Omit<AdminRow, 'password_hash' | 'failed_logins' | 'locked_at'>): AdmUser => ({
  id: r.id, username: r.username, name: r.name, role: r.role, status: r.status, lastLoginAt: r.last_login_at?.toISOString() ?? null,
});

export async function admLogin(app: FastifyInstance, pool: Pool, body: { username: string; password: string }): Promise<{ token: string; admin: AdmUser }> {
  const res = await withPlatform(pool, async (tx) => {
    const u = (await tx.query<AdminRow>(`select * from platform_admins where username = $1 for update`, [body.username.trim().toLowerCase()])).rows[0];
    if (!u) {
      await admAudit(tx, null, 'login-failed', 'admin', body.username, 'ไม่พบผู้ใช้');
      return { ok: false as const, reason: 'BAD_CREDENTIALS' };
    }
    const who = { adminId: u.id, name: u.name };
    if (u.status !== 'active') {
      await admAudit(tx, who, 'login-failed', 'admin', u.username, 'ปิดใช้งาน');
      return { ok: false as const, reason: 'DISABLED' };
    }
    if (u.locked_at) {
      await admAudit(tx, who, 'login-failed', 'admin', u.username, 'บัญชีถูกล็อก');
      return { ok: false as const, reason: 'LOCKED' };
    }
    if (!(await argon2.verify(u.password_hash, body.password))) {
      const n = u.failed_logins + 1;
      await tx.query(`update platform_admins set failed_logins = $2::int, locked_at = case when $2::int >= $3::int then now() else locked_at end where id = $1`, [u.id, n, ADM_MAX_FAILED]);
      await admAudit(tx, who, 'login-failed', 'admin', u.username, `รหัสผ่านผิดครั้งที่ ${n}`);
      return { ok: false as const, reason: 'BAD_CREDENTIALS' };
    }
    await tx.query(`update platform_admins set failed_logins = 0, last_login_at = now() where id = $1`, [u.id]);
    await admAudit(tx, who, 'login', 'admin', u.username);
    return { ok: true as const, admin: toAdmUser({ ...u, last_login_at: new Date() }) };
  });
  if (!res.ok) throw E.unauthorized('Wrong username or password', { reason: res.reason });
  const token = app.jwt.sign({ sub: res.admin.id, adm: true }, { expiresIn: '8h' });
  return { token, admin: res.admin };
}

export function makeAdmAuthed(pool: Pool) {
  return (handler: AdmHandler) => async (req: FastifyRequest, reply: FastifyReply) => {
    let c: AdmClaims;
    try {
      c = await req.jwtVerify<AdmClaims>();
    } catch {
      throw E.unauthorized('Not signed in or session expired');
    }
    if (c.adm !== true || c.tid || !isUuid(c.sub)) throw E.unauthorized('SCG Admin sign-in required');
    return withPlatform(pool, async (tx) => {
      const u = (await tx.query<AdminRow>(`select * from platform_admins where id = $1`, [c.sub])).rows[0];
      if (!u || u.status !== 'active' || u.locked_at) throw E.unauthorized('SCG Admin account is not active');
      return handler(tx, { adminId: u.id, name: u.name, username: u.username, role: u.role }, req, reply);
    });
  };
}
export type AdmAuthed = ReturnType<typeof makeAdmAuthed>;

export async function createAdmin(tx: Tx, a: AdmCtx | null, body: { username: string; name: string; role: AdmRole; password: string }): Promise<AdmUser> {
  if (a) requireAdm(a, ADM_CAN.admins);
  const hash = await argon2.hash(body.password, { type: argon2.argon2id });
  const r = await tx.query<AdminRow>(
    `insert into platform_admins (username, name, role, password_hash) values ($1,$2,$3,$4) returning *`, [body.username, body.name, body.role, hash]);
  await admAudit(tx, a, 'create', 'admin', body.username, `${body.name} · ${body.role}`);
  return toAdmUser(r.rows[0]!);
}

export async function listAdmins(tx: Tx, a: AdmCtx): Promise<{ items: AdmUser[] }> {
  requireAdm(a, ADM_CAN.admins);
  const r = await tx.query<AdminRow>(`select * from platform_admins order by created_at, id`);
  return { items: r.rows.map(toAdmUser) };
}

/**
 * First SCG Admin account on a fresh cloud database: SCG_ADMIN_BOOTSTRAP="username:password[:display name]".
 * Does nothing once any administrator exists, so the variable can stay set.
 */
export async function bootstrapAdmin(pool: Pool, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const spec = env.SCG_ADMIN_BOOTSTRAP?.trim();
  if (!spec) return false;
  const [username, password, ...name] = spec.split(':');
  if (!username || !password || password.length < 8) throw new Error('SCG_ADMIN_BOOTSTRAP must be "username:password(8+ chars)[:name]"');
  return withPlatform(pool, async (tx) => {
    await tx.query(`select pg_advisory_xact_lock(hashtextextended('erp_platform_bootstrap', 0))`);
    if ((await tx.query(`select 1 from platform_admins limit 1`)).rowCount) return false;
    await createAdmin(tx, null, { username: username.toLowerCase(), name: name.join(':') || 'SCG Super Admin', role: 'super', password });
    return true;
  });
}
