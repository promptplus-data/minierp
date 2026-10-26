/**
 * Bearer JWT auth + per-request tenant transaction (BR-14 / M19).
 * `authed(handler)` verifies the token, opens ONE transaction scoped to the token's tenant
 * (SET LOCAL ROLE erp_app + app.tenant_id, so RLS applies), re-checks the user is still active,
 * and runs the handler inside it. Any thrown error rolls the whole request back.
 */
import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withTenant, type Tx } from '@erp/db';
import type { Ctx, Deps } from '../lib/context';
import { E, isUuid } from '../lib/errors';
import { loadActiveUser } from '../services/auth';

export interface TokenClaims { sub: string; tid: string }

export type AuthedHandler = (tx: Tx, ctx: Ctx, req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export async function registerAuth(app: FastifyInstance, jwtSecret: string): Promise<void> {
  await app.register(jwt, { secret: jwtSecret, sign: { expiresIn: '12h' } });
}

export function signToken(app: FastifyInstance, ctx: Ctx): string {
  return app.jwt.sign({ sub: ctx.userId, tid: ctx.tenantId } satisfies TokenClaims);
}

/** Tenant id from a bearer token if present and valid (used by public endpoints such as /api/meta). */
export async function optionalTenant(req: FastifyRequest): Promise<string | null> {
  if (!req.headers.authorization) return null;
  try {
    const c = await req.jwtVerify<TokenClaims>();
    return isUuid(c.tid) ? c.tid : null;
  } catch {
    return null;
  }
}

export function makeAuthed(deps: Deps) {
  return (handler: AuthedHandler) => async (req: FastifyRequest, reply: FastifyReply) => {
    let claims: TokenClaims;
    try {
      claims = await req.jwtVerify<TokenClaims>();
    } catch {
      throw E.unauthorized('Not signed in or session expired');
    }
    if (!isUuid(claims.tid) || !isUuid(claims.sub)) throw E.unauthorized();
    return withTenant(deps.pool, claims.tid, async (tx) => {
      const u = await loadActiveUser(tx, claims.sub);
      if (!u) throw E.unauthorized('User is not active');
      return handler(tx, { tenantId: claims.tid, userId: u.id, name: u.name, role: u.role }, req, reply);
    });
  };
}

export type Authed = ReturnType<typeof makeAuthed>;
