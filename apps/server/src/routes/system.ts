/** /healthz, /api/meta, on-prem first-run setup and client pairing. */
import type { FastifyInstance } from 'fastify';
import { withTenant } from '@erp/db';
import { SetupReq } from '@erp/contracts';
import type { Deps } from '../lib/context';
import { E } from '../lib/errors';
import { FailureLimiter } from '../lib/limiter';
import { DEVICE_COOKIE, isLoopback } from '../lib/net';
import { optionalTenant, signToken, type Authed } from '../plugins/auth';
import { createPairingCode, redeemPairingCode } from '../services/admin';
import { sessionUser } from '../services/auth';
import { needsSetup, runSetup } from '../services/setup';
import { capabilities } from '../capabilities';

export const APP_VERSION = process.env.APP_VERSION ?? '0.1.0';

interface ShopRow { name: string; tax_id: string; branch: string; vat_registered: boolean; b2b_vat_mode: 'inc' | 'exc' }

export function systemRoutes(app: FastifyInstance, deps: Deps, authed: Authed): void {
  app.get('/healthz', async (_req, reply) => {
    try {
      await deps.pool.query('select 1');
      return { ok: true, edition: deps.edition, version: APP_VERSION };
    } catch {
      return reply.status(503).send({ ok: false, edition: deps.edition, version: APP_VERSION, db: 'down' });
    }
  });

  /** Which shop /api/meta describes: the caller's (bearer token), ?shop=<code>, or the single on-prem shop. */
  async function shopFor(tenantId: string | null, code: string | undefined): Promise<ShopRow | null> {
    if (tenantId) return (await withTenant(deps.pool, tenantId, (tx) => tx.query<ShopRow>(`select name, tax_id, branch, vat_registered, b2b_vat_mode from tenants`))).rows[0] ?? null;
    if (!code && deps.edition !== 'onprem') return null;
    const r = await withTenant(deps.pool, null, (tx) =>
      tx.query<ShopRow>(
        `select name, tax_id, branch, vat_registered, b2b_vat_mode from tenants where ($1::text is null or code = $1) order by created_at limit 1`,
        [code ?? null],
      ), { authLookup: true });
    return r.rows[0] ?? null;
  }

  app.get('/api/meta', async (req) => {
    const shop = await shopFor(await optionalTenant(req), (req.query as { shop?: string }).shop);
    return {
      edition: deps.edition,
      capabilities: capabilities(deps.edition),
      shop: shop
        ? { name: shop.name, taxId: shop.tax_id, branch: shop.branch, vatRegistered: shop.vat_registered, b2bVatMode: shop.b2b_vat_mode }
        : { name: 'SCG Shop ERP', taxId: '', branch: '', vatRegistered: true, b2bVatMode: 'exc' },
      version: APP_VERSION,
      needsSetup: !shop && deps.edition === 'onprem' ? await needsSetup(deps.pool) : false,
    };
  });

  if (deps.edition !== 'onprem') return;

  // ---------- on-prem first run: only from the main machine itself, only while the database is empty ----------
  app.post('/api/setup', async (req, reply) => {
    if (!isLoopback(req.ip)) throw E.forbidden('Run the first-time setup on the main machine (https://localhost)');
    const ctx = await runSetup(deps.pool, SetupReq.parse(req.body));
    reply.status(201);
    return { token: signToken(app, ctx), user: sessionUser({ id: ctx.userId, name: ctx.name, role: ctx.role }) };
  });

  // ---------- on-prem pairing (docs/DEPLOY.md §3) ----------
  app.post('/api/devices/pairing-code', authed(async (tx, ctx, _req, reply) => {
    reply.status(201);
    return createPairingCode(tx, ctx);
  }));

  // Brute-force brake: 10 wrong codes per client IP per 10 minutes. req.ip is the socket address (trustProxy is
  // off on-prem), and the limiter tracks at most 10 000 addresses.
  const failures = new FailureLimiter({ max: 10, windowMs: 10 * 60_000, maxEntries: 10_000 });
  app.get('/pair', async (req, reply) => {
    const ip = req.ip;
    const wantsJson = (req.headers.accept ?? '').includes('application/json');
    if (failures.blocked(ip)) return reply.status(429).send({ code: 'FORBIDDEN', message: 'Too many wrong pairing codes; wait 10 minutes' });
    const { code = '', name } = req.query as { code?: string; name?: string };
    const r = await redeemPairingCode(deps.pool, code.trim(), (name ?? req.headers['user-agent'] ?? 'client').slice(0, 120));
    if (!r) {
      failures.fail(ip);
      return reply.status(400).send({ code: 'VALIDATION', message: 'Pairing code is wrong, used or expired' });
    }
    failures.clear(ip);
    const secure = req.protocol === 'https' ? '; Secure' : '';
    reply.header('set-cookie', `${DEVICE_COOKIE}=${r.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 3650}${secure}`);
    if (wantsJson) return { deviceId: r.deviceId, token: r.token };
    return reply.redirect('/');
  });
}
