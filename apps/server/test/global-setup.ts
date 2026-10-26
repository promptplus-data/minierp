/** Recreates the erp_test schema and applies the migrations once per test run. */
import pg from 'pg';
import { runMigrations } from '@erp/db';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_test';

export default async function setup(): Promise<void> {
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await c.connect();
  await c.query('drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public;');
  await c.end();
  await runMigrations(TEST_DATABASE_URL);
}
