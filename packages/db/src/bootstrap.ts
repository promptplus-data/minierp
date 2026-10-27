/**
 * Deploy-time database setup (used by scripts/vercel-build.mjs): apply migrations, then optionally seed the demo shop.
 * Idempotent: migrations skip applied files and the seed skips when the demo tenant ("charoen") exists.
 *
 * CLI: DATABASE_URL=... [SEED_DEMO=1] tsx src/bootstrap.ts
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { runMigrations } from './migrate';
import { seedDemo } from './seed';
import { withTenant } from './tx';

export async function bootstrap(opts: { url: string; seed: boolean; log?: (m: string) => void }): Promise<void> {
  const log = opts.log ?? (() => {});
  const r = await runMigrations(opts.url, undefined, { log });
  log(`migrations: ${r.applied.length} applied, ${r.skipped} already applied`);
  if (!opts.seed) return;
  const pool = new pg.Pool({ connectionString: opts.url, max: 2 });
  try {
    const exists = await withTenant(pool, null, (c) => c.query(`select 1 from tenants where code = 'charoen'`), { authLookup: true });
    if (exists.rowCount) {
      log('demo shop "charoen" already exists; not seeding');
      return;
    }
    const s = await seedDemo(pool);
    log(`seeded demo shop "charoen" (tenant ${s.tenantId})`);
  } finally {
    await pool.end();
  }
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
