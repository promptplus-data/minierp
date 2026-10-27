/**
 * File-based migrator and erp_secure_table() against a real PostgreSQL database: <TEST_DATABASE_URL>_migrate
 * (default erp_test_migrate), created when missing and recreated for each case.
 */
import { cpSync, mkdtempSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readMigrationFiles, runMigrations } from './migrate';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const base = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_test');
const DB_NAME = `${base.pathname.slice(1)}_migrate`;
const url = new URL(base.toString());
url.pathname = `/${DB_NAME}`;
const URL_ = url.toString();

async function adminQuery(sql: string) {
  const admin = new URL(base.toString());
  admin.pathname = '/postgres';
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

async function q<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: URL_ });
  await c.connect();
  try {
    // Multi-statement text returns one result per statement: use the last SELECT's rows.
    const res = (await c.query(sql, params)) as unknown as pg.QueryResult<T> | pg.QueryResult<T>[];
    const list = Array.isArray(res) ? res : [res];
    const selects = list.filter((r) => r.command === 'SELECT');
    return (selects[selects.length - 1] ?? list[list.length - 1])!.rows;
  } finally {
    await c.end();
  }
}

const tmpDirs: string[] = [];
beforeEach(async () => {
  await adminQuery(`drop database if exists ${DB_NAME} with (force)`);
  await adminQuery(`create database ${DB_NAME}`);
});
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('runMigrations', () => {
  it('applies every file in lexical order once and records filename + sha256', async () => {
    const files = readMigrationFiles(DIR);
    const first = await runMigrations(URL_, DIR);
    expect(first.applied).toEqual(files.map((f) => f.filename));
    const rows = await q<{ filename: string; sha256: string }>('select filename, sha256 from schema_migrations order by filename');
    expect(rows).toEqual(files.map((f) => ({ filename: f.filename, sha256: f.sha256 })));
    const again = await runMigrations(URL_, DIR);
    expect(again.applied).toEqual([]);
    expect(again.skipped).toBe(files.length);
  });

  it('refuses to run when an applied file changed, and applies nothing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'erp-mig-'));
    tmpDirs.push(dir);
    cpSync(DIR, dir, { recursive: true });
    await runMigrations(URL_, dir);
    appendFileSync(path.join(dir, '0001_rls_triggers.sql'), '\n-- edited\n');
    appendFileSync(path.join(dir, '9999_new.sql'), 'create table should_not_exist (id int);');
    await expect(runMigrations(URL_, dir)).rejects.toThrow(/0001_rls_triggers\.sql/);
    expect(await q(`select to_regclass('should_not_exist') as t`)).toEqual([{ t: null }]);
  });

  it('rolls back a failing file and leaves it unrecorded', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'erp-mig-'));
    tmpDirs.push(dir);
    cpSync(DIR, dir, { recursive: true });
    appendFileSync(path.join(dir, '9999_bad.sql'), 'create table half_done (id int); select 1/0;');
    await expect(runMigrations(URL_, dir)).rejects.toThrow(/9999_bad\.sql/);
    expect(await q(`select to_regclass('half_done') as t`)).toEqual([{ t: null }]);
    expect(await q(`select filename from schema_migrations where filename = '9999_bad.sql'`)).toEqual([]);
  });

  it('adopts a database migrated by the old drizzle journal without re-running those files', async () => {
    const legacy = readMigrationFiles(DIR).filter((f) => f.filename < '0003');
    expect(legacy.map((f) => f.filename)).toEqual(['0000_init.sql', '0001_rls_triggers.sql', '0002_approval_pin_lock.sql']);
    for (const f of legacy) await q(f.sql);
    await q('create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)');
    for (const [i, f] of legacy.entries()) await q('insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)', [f.sha256, i]);

    const r = await runMigrations(URL_, DIR);
    expect(r.adopted).toEqual(legacy.map((f) => f.filename));
    expect(r.applied[0]).toBe('0003_secure_table_helper.sql');
    expect(r.applied).not.toContain('0000_init.sql');
  });
});

describe('erp_secure_table', () => {
  it('turns on forced RLS with the tenant policy, grants without DELETE, and forbids deleting documents', async () => {
    await runMigrations(URL_, DIR);
    await q(`create table mod_docs (id bigint generated always as identity primary key, tenant_id uuid not null, no text not null);
             select erp_secure_table('mod_docs', true);
             select erp_secure_table('mod_docs', true);`); // idempotent
    const [rel] = await q(`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'mod_docs'`);
    expect(rel).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await q(`select polname from pg_policy where polrelid = 'mod_docs'::regclass`)).toEqual([{ polname: 'tenant_isolation' }]);
    const [priv] = await q(`select has_table_privilege('erp_app', 'mod_docs', 'INSERT') ins, has_table_privilege('erp_app', 'mod_docs', 'UPDATE') upd,
                                   has_table_privilege('erp_app', 'mod_docs', 'DELETE') del`);
    expect(priv).toEqual({ ins: true, upd: true, del: false });

    const t1 = '00000000-0000-0000-0000-000000000001';
    const t2 = '00000000-0000-0000-0000-000000000002';
    await q(`insert into mod_docs (tenant_id, no) values ($1, 'A'), ($2, 'B')`, [t1, t2]);
    const seen = await q(`begin; set local role erp_app; select set_config('app.tenant_id', '${t1}', true);
                          insert into mod_docs (tenant_id, no) values ('${t1}', 'C'); select no from mod_docs order by no; commit;`);
    expect(seen).toEqual([{ no: 'A' }, { no: 'C' }]);
    await expect(q(`delete from mod_docs`)).rejects.toThrow(/never deleted/);

    await q(`create table mod_master (id int primary key, tenant_id uuid not null); select erp_secure_table('mod_master');`);
    expect(await q(`select tgname from pg_trigger where tgrelid = 'mod_master'::regclass and not tgisinternal`)).toEqual([]);
    await expect(q(`create table no_tenant (id int); select erp_secure_table('no_tenant');`)).rejects.toThrow(/no tenant_id/);
  });
});
