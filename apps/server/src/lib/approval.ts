import argon2 from 'argon2';
import type { Tx } from '@erp/db';
import type { Role } from '@erp/core';
import { isUuid } from './errors';

export interface Approval { approverUserId: string; pin: string }
export type ApprovalResult = { ok: true; approver: { id: string; name: string; role: Role } } | { ok: false; reason: 'NOT_FOUND' | 'ROLE_NOT_ALLOWED' | 'BAD_PIN' };

/** Verifies an approver PIN: same tenant (RLS), active, role in `roles`, argon2 PIN match. */
export async function verifyApproval(tx: Tx, a: Approval, roles: readonly Role[]): Promise<ApprovalResult> {
  if (!isUuid(a.approverUserId)) return { ok: false, reason: 'NOT_FOUND' };
  const r = await tx.query<{ id: string; name: string; role: Role; pin_hash: string | null; status: string }>(
    `select id, name, role, pin_hash, status from users where id = $1`,
    [a.approverUserId],
  );
  const u = r.rows[0];
  if (!u || u.status !== 'active') return { ok: false, reason: 'NOT_FOUND' };
  if (!roles.includes(u.role)) return { ok: false, reason: 'ROLE_NOT_ALLOWED' };
  if (!u.pin_hash || !(await argon2.verify(u.pin_hash, a.pin).catch(() => false))) return { ok: false, reason: 'BAD_PIN' };
  return { ok: true, approver: { id: u.id, name: u.name, role: u.role } };
}
