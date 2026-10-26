import type { Tx } from '@erp/db';
import type { Ctx } from './context';

export interface AuditInput { action: string; object: string; ref?: string | null; detail?: string }

/**
 * BR-18: append to the tenant's hash-chained audit log (the trigger fills chain_seq / prev_hash / hash).
 * The trigger takes a per-tenant advisory lock held until COMMIT, so call this as the LAST statement of a
 * transaction: every row lock is then taken before the audit lock, which rules out lock-order deadlocks.
 */
export async function writeAudit(tx: Tx, who: Pick<Ctx, 'tenantId' | 'name'> & { userId: string | null }, entries: AuditInput[]): Promise<void> {
  for (const e of entries) {
    await tx.query(
      `insert into audit_log (tenant_id, user_id, user_name, action, object, ref, detail) values ($1,$2,$3,$4,$5,$6,$7)`,
      [who.tenantId, who.userId, who.name, e.action, e.object, e.ref ?? null, e.detail ?? ''],
    );
  }
}
