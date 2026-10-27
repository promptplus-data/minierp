/**
 * Creates the test database if it is missing, recreates its public schema and applies the migrations once per run.
 * TEST_DATABASE_URL picks the database, so parallel worktrees can use erp_test_a, erp_test_b, ...
 */
import pg from 'pg';
import { runMigrations } from '@erp/db';
import { TEST_DATABASE_URL } from './db-url';

async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    const r = await c.query('select 1 from pg_database where datname = $1', [name]);
    if (r.rowCount === 0) {
      await c.query(`create database ${pg.escapeIdentifier(name)}`);
      console.log(`[test] created database ${name}`);
    }
  } catch (err) {
    // Two worktrees racing on the same name: the loser sees duplicate_database (42P04).
    if ((err as { code?: string }).code !== '42P04') throw err;
  } finally {
    await c.end();
  }
}

export default async function setup(): Promise<void> {
  await ensureDatabase(TEST_DATABASE_URL);
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await c.connect();
  await c.query('drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public;');
  await c.end();
  await runMigrations(TEST_DATABASE_URL);
}
