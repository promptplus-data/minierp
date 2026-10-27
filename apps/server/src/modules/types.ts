/**
 * Contract between the app and a module group's Fastify plugin. See modules/index.ts for the registry.
 *
 * Inside a module:
 *   - wrap handlers in `authed(async (tx, ctx, req, reply) => ...)`: one tenant-scoped transaction per request (RLS);
 *   - check permissions with requirePerm / requireAny from ../../lib/context; throw E.* from ../../lib/errors;
 *   - number documents with nextDocNo (../../lib/docno), write audit rows with writeAudit (../../lib/audit) last;
 *   - edition-specific code goes inside `if (process.env.EDITION === 'cloud') { if (deps.edition === 'cloud') ... }`
 *     (the bundler folds the outer test, so on-prem bundles drop the branch) and the route is listed in
 *     `<module>RouteEditions` in packages/contracts/src/modules/<module>.ts;
 *   - timers / schedulers only when `deps.backgroundJobs` is true (false in tests and on Vercel), and stop them in
 *     `app.addHook('onClose', ...)`.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { Deps } from '../lib/context';
import type { Authed } from '../plugins/auth';

export interface ModuleOptions {
  deps: Deps;
  authed: Authed;
}

export type ErpModule = FastifyPluginAsync<ModuleOptions>;
