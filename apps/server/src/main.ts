/**
 * Server entry. Env: DATABASE_URL, EDITION (baked in by the bundler), JWT_SECRET, HOST, PORT, WEB_DIST_DIR,
 * TLS_PFX_FILE + TLS_PFX_PASSPHRASE (HTTPS when set), BACKUP_SCRIPT, MDNS_SERVICE_TYPE, CORS_ORIGIN, LOG_LEVEL.
 */
import { readFileSync } from 'node:fs';
import { createPool } from '@erp/db';
import { buildApp } from './app';
import { advertiseMdns } from './mdns';
import { APP_VERSION } from './routes/system';

const env = process.env;
// Must be spelled `process.env.EDITION`: the bundler replaces exactly that expression with the baked-in edition.
const edition = process.env.EDITION === 'onprem' ? 'onprem' : 'cloud';
const databaseUrl = env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
let jwtSecret = env.JWT_SECRET ?? '';
if (!jwtSecret || jwtSecret === 'change-me') {
  if (env.NODE_ENV === 'production') {
    console.error('JWT_SECRET must be set in production');
    process.exit(2);
  }
  jwtSecret = 'dev-only-insecure-secret';
  console.warn('[server] JWT_SECRET not set; using an insecure development secret');
}

const https = env.TLS_PFX_FILE ? { pfx: readFileSync(env.TLS_PFX_FILE), passphrase: env.TLS_PFX_PASSPHRASE } : undefined;
const port = Number(env.PORT ?? (edition === 'onprem' ? 8443 : 3000));
const pool = createPool(databaseUrl, Number(env.DB_POOL_MAX ?? 10));

const app = await buildApp({
  pool,
  edition,
  jwtSecret,
  webDistDir: env.WEB_DIST_DIR,
  backupScript: edition === 'onprem' ? env.BACKUP_SCRIPT : undefined,
  corsOrigin: env.CORS_ORIGIN,
  https,
  logger: { level: env.LOG_LEVEL ?? 'info' },
});

await app.listen({ host: env.HOST ?? '0.0.0.0', port });
app.log.info({ edition, https: !!https, version: APP_VERSION }, 'SCG Shop ERP server started');

let stopMdns: (() => void) | undefined;
if (edition === 'onprem' && env.MDNS_SERVICE_TYPE !== 'off') {
  try {
    stopMdns = advertiseMdns({ serviceType: env.MDNS_SERVICE_TYPE ?? '_scgerp._tcp', port, version: APP_VERSION, https: !!https, log: app.log });
  } catch (err) {
    app.log.warn({ err }, 'mDNS advertisement failed; clients can still connect by IP');
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    stopMdns?.();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
