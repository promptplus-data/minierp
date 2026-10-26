import type { Tx } from '@erp/db';
import { DEFAULT_DOC_PATTERN, docPeriodKey, formatDocNo } from '@erp/core';

/**
 * BR-04: gap-free running number. The counter row is upserted (and thereby row-locked) inside the caller's
 * transaction, so a rollback also rolls the number back and concurrent writers queue on the row.
 * No PostgreSQL sequences (they leave gaps on rollback).
 * The device joins the counter key only when the pattern prints {DEV} (offline ABB numbering per POS).
 */
export async function nextDocNo(tx: Tx, tenantId: string, type: string, date: string, device = ''): Promise<string> {
  const t = await tx.query<{ doc_patterns: Record<string, string> }>(`select doc_patterns from tenants where id = $1`, [tenantId]);
  const pattern = t.rows[0]?.doc_patterns?.[type] ?? DEFAULT_DOC_PATTERN;
  const period = docPeriodKey(pattern, date);
  const dev = pattern.includes('{DEV}') ? device : '';
  const r = await tx.query<{ seq: number }>(
    `insert into doc_counters (tenant_id, type, period, device, seq) values ($1,$2,$3,$4,1)
     on conflict (tenant_id, type, period, device) do update set seq = doc_counters.seq + 1
     returning seq`,
    [tenantId, type, period, dev],
  );
  return formatDocNo(pattern, { type, date, seq: r.rows[0]!.seq, device: dev });
}
