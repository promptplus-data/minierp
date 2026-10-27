/**
 * M02 terms acceptance (BR-15) and the shop-status guard (REQ-M14-04 suspension, BR-15 terms) that runs for every
 * authed request through Deps.tenantGuards. Shops opened by SCG Admin carry adm_terms_required; their owner must
 * accept the current TERMS_VERSION before any other screen works. Legal text: placeholder until OQ-04.
 */
import type { z } from 'zod';
import type { Tx } from '@erp/db';
import type { TermsAccept, TermsAcceptance, TermsStatus } from '@erp/contracts';
import { TERMS_BODY, TERMS_CONSENTS, TERMS_PLACEHOLDER, TERMS_TITLE, TERMS_VERSION, missingConsents } from '@erp/core';
import { writeAudit } from '../../lib/audit';
import type { Ctx, TenantGuard } from '../../lib/context';
import { E } from '../../lib/errors';

/** Routes a shop that has not accepted the terms (or is read-only) may still call. */
const TERMS_FREE = new Set(['/api/terms', '/api/terms/accept', '/api/auth/me', '/api/license']);

interface AccRow { version: string; signer_name: string; signer_title: string; consents: Record<string, boolean>; user_name: string; accepted_at: Date; ip: string | null }
const toAcc = (r: AccRow): TermsAcceptance => ({
  version: r.version, signerName: r.signer_name, signerTitle: r.signer_title, consents: r.consents, acceptedBy: r.user_name,
  acceptedAt: r.accepted_at.toISOString(), ip: r.ip,
});

export async function termsStatus(tx: Tx, ctx: Ctx): Promise<TermsStatus> {
  const t = (await tx.query<{ req: boolean }>(`select adm_terms_required req from tenants where id = $1`, [ctx.tenantId])).rows[0];
  const hist = (await tx.query<AccRow>(
    `select a.version, a.signer_name, a.signer_title, a.consents, u.name user_name, a.accepted_at, a.ip
       from terms_acceptances a join users u on u.id = a.accepted_by order by a.accepted_at desc`,
  )).rows.map(toAcc);
  const cur = hist.find((h) => h.version === TERMS_VERSION) ?? null;
  return {
    required: t?.req ?? false, accepted: !!cur, canAccept: ctx.role === 'owner',
    current: { version: TERMS_VERSION, title: TERMS_TITLE, body: [...TERMS_BODY], consents: TERMS_CONSENTS.map((c) => ({ ...c })), placeholder: TERMS_PLACEHOLDER },
    acceptance: cur, history: hist,
  };
}

/** REQ-M02-01: only the owner (the shop's authorised person) signs; every required consent must be ticked. */
export async function acceptTerms(tx: Tx, ctx: Ctx, body: z.output<typeof TermsAccept>, ip: string | null): Promise<TermsStatus> {
  if (ctx.role !== 'owner') throw E.forbidden('Only the shop owner can accept the terms; ask the owner to sign in', { reason: 'OWNER_ONLY' });
  if (body.version !== TERMS_VERSION) throw E.conflict(`Terms version ${body.version} is not current (${TERMS_VERSION})`, { reason: 'TERMS_VERSION' });
  const missing = missingConsents(body.consents);
  if (missing.length) throw E.validation('Every required consent must be ticked', { reason: 'CONSENT_REQUIRED', missing });
  const consents = Object.fromEntries(TERMS_CONSENTS.map((c) => [c.id, body.consents[c.id] === true]));
  const r = await tx.query(
    `insert into terms_acceptances (tenant_id, version, signer_name, signer_title, consents, accepted_by, ip) values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (tenant_id, version) do nothing`,
    [ctx.tenantId, TERMS_VERSION, body.signerName, body.signerTitle, JSON.stringify(consents), ctx.userId, ip],
  );
  if (!r.rowCount) throw E.conflict('These terms are already accepted');
  const yes = TERMS_CONSENTS.filter((c) => consents[c.id]).map((c) => c.id).join(', ');
  const out = await termsStatus(tx, ctx);
  await writeAudit(tx, ctx, [{ action: 'accept', object: 'terms', ref: TERMS_VERSION, detail: `ผู้ลงนาม ${body.signerName}${body.signerTitle ? ` (${body.signerTitle})` : ''} · ยินยอม: ${yes} · IP ${ip ?? '-'}` }]);
  return out;
}

/**
 * Suspended shop (REQ-M14-04): no login, no request. Terms not accepted (BR-15): every route except TERMS_FREE is
 * refused until the owner signs.
 */
export const shopStatusGuard: TenantGuard = async (tx, info) => {
  const r = (await tx.query<{ status: string; req: boolean; ok: boolean }>(
    `select adm_status status, adm_terms_required req, exists (select 1 from terms_acceptances where version = $2) ok from tenants where id = $1`,
    [info.tenantId, TERMS_VERSION],
  )).rows[0];
  if (!r) return;
  if (r.status === 'suspended') throw E.forbidden('This shop is suspended by SCG; contact SCG support', { reason: 'SHOP_SUSPENDED' });
  if (info.phase === 'request' && r.req && !r.ok && !TERMS_FREE.has(info.route)) {
    throw E.forbidden('The shop owner must accept the current terms before using the system (BR-15)', { reason: 'TERMS_REQUIRED', version: TERMS_VERSION });
  }
};
