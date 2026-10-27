/**
 * File-based SQL migrator (see ../MIGRATIONS.md).
 *
 * Applies `migrations/*.sql` in lexical filename order. Each file runs in its own transaction and is recorded in
 * `schema_migrations (filename, sha256, applied_at)`. A file that was applied and has since been edited (different
 * sha256) stops the run before anything is applied: write a new migration instead.
 *
 * Databases migrated by the old drizzle-kit journal (`drizzle.__drizzle_migrations`) are adopted: the legacy files
 * whose hashes drizzle recorded are marked applied without running them again.
 *
 * CLI: DATABASE_URL=... tsx src/migrate.ts   (bundled as dist-<edition>/migrate.mjs)
 * MIGRATIONS_DIR overrides where the migration folder is looked up.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

/** Files that drizzle-kit applied before this migrator existed, in journal order. */
const LEGACY_DRIZZLE_FILES = ['0000_init.sql', '0001_rls_triggers.sql', '0002_approval_pin_lock.sql'];
/** Serializes concurrent migrators (several replicas, parallel deploy builds). */
const LOCK_KEY = 'erp_schema_migrations';

const hasSql = (d: string) => existsSync(d) && readdirSync(d).some((f) => f.endsWith('.sql'));

export function defaultMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.MIGRATIONS_DIR, path.join(here, 'migrations'), path.join(here, '../migrations')];
  const found = candidates.find((d): d is string => !!d && hasSql(d));
  if (!found) throw new Error(`migrations folder not found (tried ${candidates.filter(Boolean).join(', ')})`);
  return found;
}

export interface MigrationFile { filename: string; sha256: string; sql: string }

export function readMigrationFiles(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const sql = readFileSync(path.join(dir, filename), 'utf8');
      return { filename, sql, sha256: createHash('sha256').update(sql).digest('hex') };
    });
}

export interface MigrateOptions {
  log?: (msg: string) => void;
  /** Use an existing pool instead of opening one from the connection string. */
  pool?: pg.Pool;
}

export interface MigrateResult { applied: string[]; adopted: string[]; skipped: number }

export async function runMigrations(
  connectionString: string,
  migrationsFolder = defaultMigrationsDir(),
  opts: MigrateOptions = {},
): Promise<MigrateResult> {
  const log = opts.log ?? (() => {});
  const files = readMigrationFiles(migrationsFolder);
  const pool = opts.pool ?? new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  const result: MigrateResult = { applied: [], adopted: [], skipped: 0 };
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    await client.query(`create table if not exists schema_migrations (
      filename text primary key,
      sha256 text not null,
      applied_at timestamptz not null default now()
    )`);
    result.adopted = await adoptDrizzleJournal(client, files);
    for (const f of result.adopted) log(`adopted ${f} from the drizzle journal`);

    const applied = new Map(
      (await client.query<{ filename: string; sha256: string }>('select filename, sha256 from schema_migrations')).rows.map((r) => [r.filename, r.sha256]),
    );
    const changed = files.filter((f) => applied.has(f.filename) && applied.get(f.filename) !== f.sha256);
    if (changed.length) {
      throw new Error(
        `applied migration(s) changed on disk: ${changed.map((f) => f.filename).join(', ')}. ` +
          'Never edit an applied migration; add a new file instead.',
      );
    }
    const known = new Set(files.map((f) => f.filename));
    for (const name of applied.keys()) if (!known.has(name)) log(`warning: ${name} is applied but not in ${migrationsFolder}`);

    for (const f of files) {
      if (applied.has(f.filename)) {
        result.skipped++;
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(f.sql);
        await client.query('insert into schema_migrations (filename, sha256) values ($1, $2)', [f.filename, f.sha256]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${f.filename} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      result.applied.push(f.filename);
      log(`applied ${f.filename}`);
    }
  } finally {
    await client.query('select pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => {});
    client.release();
    if (!opts.pool) await pool.end();
  }
  return result;
}

/**
 * Marks the legacy files applied when drizzle-kit already applied them. Matches on drizzle's recorded sha256 of the
 * file text; if hashes do not match (line endings, a hand-edited file), falls back to drizzle's row count, since
 * drizzle applies journal entries strictly in order. Runs only while schema_migrations is still empty.
 */
async function adoptDrizzleJournal(client: pg.PoolClient, files: MigrationFile[]): Promise<string[]> {
  const empty = (await client.query('select 1 from schema_migrations limit 1')).rowCount === 0;
  if (!empty) return [];
  const reg = await client.query<{ t: string | null }>(`select to_regclass('drizzle.__drizzle_migrations')::text as t`);
  if (!reg.rows[0]?.t) return [];
  const rows = (await client.query<{ hash: string }>('select hash from drizzle.__drizzle_migrations order by created_at, id')).rows;
  if (rows.length === 0) return [];
  const hashes = new Set(rows.map((r) => r.hash));
  const legacy = LEGACY_DRIZZLE_FILES.map((n) => files.find((f) => f.filename === n)).filter((f): f is MigrationFile => !!f);
  let adopt = legacy.filter((f) => hashes.has(f.sha256));
  if (adopt.length < Math.min(rows.length, legacy.length)) adopt = legacy.slice(0, rows.length);
  for (const f of adopt) {
    await client.query('insert into schema_migrations (filename, sha256) values ($1, $2) on conflict do nothing', [f.filename, f.sha256]);
  }
  return adopt.map((f) => f.filename);
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
  runMigrations(url, defaultMigrationsDir(), { log: (m) => console.log(`[migrate] ${m}`) })
    .then((r) => console.log(`[migrate] done: ${r.applied.length} applied, ${r.skipped} already applied`))
    .catch((err) => {
      console.error('[migrate] failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
