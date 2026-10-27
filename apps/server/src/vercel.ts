/**
 * Vercel serverless entry (cloud edition only; docs/VERCEL.md). scripts/vercel-build.mjs bundles this file with
 * EDITION=cloud into .vercel/output/functions/api.func/index.mjs.
 *
 * The Fastify app is built once per cold start and reused by every invocation on that instance; each request is
 * handed to Fastify's own HTTP handler (`app.server.emit('request', req, res)`), so routing, body parsing, auth and
 * error handling are exactly what the Docker / on-prem server does. No listen(), no mDNS, no backup hook, no timers.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { createPool } from '@erp/db';
import { buildApp } from './app';

let appPromise: Promise<FastifyInstance> | undefined;

async function createApp(): Promise<FastifyInstance> {
  const env = process.env;
  // Neon / Vercel Postgres integrations set DATABASE_URL or POSTGRES_URL (pooled, sslmode=require).
  const databaseUrl = env.DATABASE_URL ?? env.POSTGRES_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL (or POSTGRES_URL) is not set');
  const jwtSecret = env.JWT_SECRET ?? '';
  if (!jwtSecret || jwtSecret === 'change-me') throw new Error('JWT_SECRET is not set');
  // A few connections per instance: Vercel runs many instances, and the pooled URL (PgBouncer) fans them in.
  const pool = createPool(databaseUrl, Number(env.DB_POOL_MAX ?? 2));
  const app = await buildApp({
    pool,
    edition: 'cloud',
    jwtSecret,
    corsOrigin: env.CORS_ORIGIN,
    trustProxy: /^(1|true)$/i.test(env.TRUST_PROXY ?? ''),
    requireDevicePairing: false,
    backgroundJobs: false,
    logger: { level: env.LOG_LEVEL ?? 'warn' },
  });
  await app.ready();
  return app;
}

function getApp(): Promise<FastifyInstance> {
  appPromise ??= createApp().catch((err: unknown) => {
    appPromise = undefined; // retry on the next request instead of caching the failure
    throw err;
  });
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let app: FastifyInstance;
  try {
    app = await getApp();
  } catch (err) {
    console.error('[vercel] app failed to start:', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ code: 'INTERNAL', message: 'Server failed to start; check the function logs' }));
    return;
  }
  app.server.emit('request', req, res);
}
