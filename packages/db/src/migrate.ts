/**
 * Applies the SQL migrations (drizzle journal format).
 * CLI: DATABASE_URL=... tsx src/migrate.ts   (bundled as dist-<edition>/migrate.mjs)
 * MIGRATIONS_DIR overrides where the migration folder is looked up.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

export function defaultMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.MIGRATIONS_DIR, path.join(here, 'migrations'), path.join(here, '../migrations')];
  const found = candidates.find((d): d is string => !!d && existsSync(path.join(d, 'meta/_journal.json')));
  if (!found) throw new Error(`migrations folder not found (tried ${candidates.filter(Boolean).join(', ')})`);
  return found;
}

export async function runMigrations(connectionString: string, migrationsFolder = defaultMigrationsDir()): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

// Only when this file itself is the entry (tsx src/migrate.ts or node migrate.mjs). The extra name check matters
// in bundles, where every inlined module shares the bundle's import.meta.url.
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isMain = /migrate\.(ts|mjs|js)$/.test(entry) && import.meta.url === pathToFileURL(entry).href;
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  runMigrations(url)
    .then(() => console.log('[migrate] done'))
    .catch((err) => {
      console.error('[migrate] failed:', err);
      process.exit(1);
    });
}
