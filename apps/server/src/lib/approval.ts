import argon2 from 'argon2';
import { withTenant, type Pool, type Tx } from '@erp/db';
import type { Role } from '@erp/core';
import { writeAudit } from './audit';
import type { Ctx } from './context';
import { isUuid } from './errors';

export interface Approval { approverUserId: string; pin: string }
export type ApprovalError = 'NOT_FOUND' | 'ROLE_NOT_ALLOWED' | 'BAD_PIN' | 'LOCKED' | 'SELF_APPROVAL';
export type ApprovalResult = { ok: true; approver: { id: string; name: string; role: Role } } | { ok: false; reason: ApprovalError };

export const MAX_PIN_FAILURES = 5;
export const PIN_LOCK_MINUTES = 15;

/**
 * Verifies an approver PIN: another user (never the caller), same tenant (RLS), active, role in `roles`,
 * approvals not locked, argon2 PIN match.
 *
 * Failed PINs are counted and audited in a SEPARATE transaction that commits even though the request
 * itself is about to roll back; 5 failures lock that approver's PIN for 15 minutes (POST /api/users/:id/unlock
 * clears it). The request transaction never writes the approver's row, so the side transaction cannot
 * wait on a lock the request holds.
 */
export async function verifyApproval(tx: Tx, pool: Pool, ctx: Ctx, a: Approval, roles: readonly Role[], purpose: string): Promise<ApprovalResult> {
  if (a.approverUserId === ctx.userId) return { ok: false, reason: 'SELF_APPROVAL' };
  if (!isUuid(a.approverUserId)) return { ok: false, reason: 'NOT_FOUND' };
  const r = await tx.query<{ id: string; name: string; role: Role; pin_hash: string | null; status: string; pin_failed: number; pin_locked: boolean }>(
    `select id, name, role, pin_hash, status, pin_failed, coalesce(pin_locked_until > now(), false) pin_locked from users where id = $1`,
    [a.approverUserId],
  );
  const u = r.rows[0];
  if (!u || u.status !== 'active') return { ok: false, reason: 'NOT_FOUND' };
  if (!roles.includes(u.role)) return { ok: false, reason: 'ROLE_NOT_ALLOWED' };
  if (u.pin_locked) {
    await recordFailure(pool, ctx, u, purpose, false);
    return { ok: false, reason: 'LOCKED' };
  }
  if (!u.pin_hash || !(await argon2.verify(u.pin_hash, a.pin).catch(() => false))) {
    const locked = await recordFailure(pool, ctx, u, purpose, true);
    return { ok: false, reason: locked ? 'LOCKED' : 'BAD_PIN' };
  }
  if (u.pin_failed > 0) {
    await withTenant(pool, ctx.tenantId, (t) => t.query(`update users set pin_failed = 0 where id = $1`, [u.id]));
  }
  return { ok: true, approver: { id: u.id, name: u.name, role: u.role } };
}

/** Commits the failure (and the lock when it is the 5th) plus an audit row. Returns whether approvals are now locked. */
async function recordFailure(pool: Pool, ctx: Ctx, approver: { id: string; name: string }, purpose: string, count: boolean): Promise<boolean> {
  return withTenant(pool, ctx.tenantId, async (t) => {
    let locked = true;
    let n = 0;
    if (count) {
      const r = await t.query<{ pin_failed: number; locked: boolean }>(
        `update users set pin_failed = pin_failed + 1,
                pin_locked_until = case when pin_failed + 1 >= $2 then now() + make_interval(mins => $3) else pin_locked_until end
          where id = $1 returning pin_failed, coalesce(pin_locked_until > now(), false) locked`,
        [approver.id, MAX_PIN_FAILURES, PIN_LOCK_MINUTES],
      );
      n = r.rows[0]?.pin_failed ?? 0;
      locked = r.rows[0]?.locked ?? false;
    }
    await writeAudit(t, ctx, [{
      action: 'approval-failed', object: 'pin', ref: approver.name,
      detail: `${purpose} · ${count ? `PIN ผิด ครั้งที่ ${n}${locked ? ` · ล็อกการอนุมัติ ${PIN_LOCK_MINUTES} นาที` : ''}` : 'การอนุมัติถูกล็อกอยู่'}`,
    }]);
    return locked;
  });
}
