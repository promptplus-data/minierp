/**
 * Deploy-time database setup (used by scripts/vercel-build.mjs): apply migrations, then optionally seed the demo shop.
 * Idempotent: migrations skip applied files and the seed skips when the demo tenant ("charoen") exists.
 * With SEED_DEMO and LICENSE_SIGNING_KEY both set, the demo shop also gets a lifetime cloud key once (cloud shops
 * need a key as soon as the server can issue them), registered so SCG Admin lists it and can revoke it.
 *
 * CLI: DATABASE_URL=... [SEED_DEMO=1] tsx src/bootstrap.ts
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { runMigrations } from './migrate';
import { seedFullDemo } from './seedFull';
import { randomBytes } from 'node:crypto';
import { encodeLicenseKey, signingKeyFrom } from './licenseKey';
import { withTenant } from './tx';

export async function bootstrap(opts: { url: string; seed: boolean; log?: (m: string) => void }): Promise<void> {
  const log = opts.log ?? (() => {});
  const r = await runMigrations(opts.url, undefined, { log });
  log(`migrations: ${r.applied.length} applied, ${r.skipped} already applied`);
  if (!opts.seed) return;
  const pool = new pg.Pool({ connectionString: opts.url, max: 2 });
  try {
    const exists = await withTenant(pool, null, (c) => c.query(`select 1 from tenants where code = 'charoen'`), { authLookup: true });
    if (exists.rowCount) log('demo shop "charoen" already exists; not seeding');
    else log(`seeded demo shop "charoen" (tenant ${(await seedFullDemo(pool)).tenantId})`);
    await ensureDemoLicense(pool, log);
  } finally {
    await pool.end();
  }
}

async function ensureDemoLicense(pool: pg.Pool, log: (m: string) => void): Promise<void> {
  const key = signingKeyFrom(process.env.LICENSE_SIGNING_KEY);
  if (!key) return;
  const shop = (await withTenant(pool, null, (c) => c.query<{ id: string; name: string; tax_id: string }>(
    `select id, name, tax_id from tenants where code = 'charoen'`), { authLookup: true })).rows[0];
  if (!shop) return;
  const has = await withTenant(pool, shop.id, (c) => c.query(`select 1 from licenses where edition = 'cloud' limit 1`));
  if (has.rowCount) return;
  const now = new Date();
  const payload = {
    v: 1, licenseId: `LIC-${now.toISOString().slice(0, 7).replace('-', '')}-${randomBytes(4).toString('hex').toUpperCase()}`,
    shopName: shop.name, taxId: shop.tax_id, edition: 'cloud', type: 'lifetime', expiresAt: null, issuedAt: now.toISOString(),
  };
  const lk = encodeLicenseKey(payload, key);
  await withTenant(pool, null, async (c) => {
    await c.query(`select set_config('app.platform','on',true)`);
    await c.query(
      `insert into license_registry (license_id, license_key, shop_name, tax_id, edition, key_type, expires_at, issued_at, note, issued_by)
       values ($1,$2,$3,$4,'cloud','lifetime',null,$5,'ร้านตัวอย่าง (ออกอัตโนมัติตอน deploy)','system')`,
      [payload.licenseId, lk, payload.shopName, payload.taxId, payload.issuedAt]);
  });
  await withTenant(pool, shop.id, (c) => c.query(
    `insert into licenses (tenant_id, license_id, license_key, shop_name, tax_id, edition, key_type, expires_at, issued_at)
     values ($1,$2,$3,$4,$5,'cloud','lifetime',null,$6)`,
    [shop.id, payload.licenseId, lk, payload.shopName, payload.taxId, payload.issuedAt]));
  log(`installed a lifetime cloud license for the demo shop (${payload.licenseId})`);
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (/bootstrap\.(ts|mjs|js)$/.test(entry) && import.meta.url === pathToFileURL(entry).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  bootstrap({ url, seed: /^(1|true)$/i.test(process.env.SEED_DEMO ?? ''), log: (m) => console.log(`[bootstrap] ${m}`) }).catch((err) => {
    console.error('[bootstrap] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
