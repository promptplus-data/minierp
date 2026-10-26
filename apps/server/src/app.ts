/**
 * buildApp(): the Fastify instance without listening (tests use app.inject()).
 * Edition is a parameter so tests can build both; in bundles it defaults to the baked-in EDITION.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { Pool } from '@erp/db';
import { bangkokToday, type Deps, type Edition, type TestHooks } from './lib/context';
import { makeAuthed, registerAuth } from './plugins/auth';
import { registerErrorHandler } from './plugins/errors';
import { coreRoutes } from './routes/core';
import { opsRoutes } from './routes/ops';
import { promptPlusRoutes } from './routes/promptplus';
import { systemRoutes } from './routes/system';

export interface BuildOptions {
  pool: Pool;
  edition?: Edition;
  jwtSecret: string;
  /** Static web build to serve with SPA fallback (WEB_DIST_DIR). */
  webDistDir?: string;
  /** On-prem: script run after a shift closes (BACKUP_SCRIPT). */
  backupScript?: string;
  /** Allowed CORS origin(s) for a separately hosted web dev server. */
  corsOrigin?: string;
  https?: { pfx: Buffer; passphrase?: string };
  logger?: FastifyServerOptions['logger'];
  hooks?: TestHooks;
  today?: () => string;
}

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const edition: Edition = opts.edition ?? (process.env.EDITION === 'onprem' ? 'onprem' : 'cloud');
  const app = (opts.https
    ? Fastify({ logger: opts.logger ?? false, https: opts.https, trustProxy: true })
    : Fastify({ logger: opts.logger ?? false, trustProxy: true })) as unknown as FastifyInstance;
  const deps: Deps = { pool: opts.pool, edition, hooks: opts.hooks ?? {}, today: opts.today ?? bangkokToday, backupScript: opts.backupScript };

  registerErrorHandler(app);
  if (opts.corsOrigin) await app.register(cors, { origin: opts.corsOrigin.split(',').map((s) => s.trim()) });
  await registerAuth(app, opts.jwtSecret);
  const authed = makeAuthed(deps);

  systemRoutes(app, deps, authed);
  coreRoutes(app, deps, authed);
  opsRoutes(app, deps, authed);
  if (process.env.EDITION === 'cloud') {
    if (edition === 'cloud') promptPlusRoutes(app, authed);
  }

  const web = opts.webDistDir && existsSync(path.join(opts.webDistDir, 'index.html')) ? path.resolve(opts.webDistDir) : null;
  if (web) await app.register(fastifyStatic, { root: web, wildcard: false, index: ['index.html'] });
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0] ?? '';
    // SPA fallback: unknown non-API GETs that accept HTML get index.html (client-side routing).
    if (web && req.method === 'GET' && !url.startsWith('/api/') && (req.headers.accept ?? '').includes('text/html')) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.status(404).send({ code: 'NOT_FOUND', message: `No route ${req.method} ${url}` });
  });
  return app;
}
