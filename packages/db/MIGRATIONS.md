# Database migrations

The database is defined by hand-written SQL files in `packages/db/migrations/`. The Drizzle files in
`src/schema/*.ts` only describe tables for TypeScript; they do not generate migrations. Keep the two in sync.

## How the migrator works

`src/migrate.ts` (CLI `pnpm db:migrate`, bundled as `migrate.mjs` in `dist-cloud/` and `dist-onprem/`):

1. Takes a session advisory lock, so two migrators never run at once.
2. Creates `schema_migrations (filename, sha256, applied_at)` if it is missing.
3. Reads every `migrations/*.sql` file and sorts the files by name.
4. Stops before applying anything if an applied file's sha256 has changed. Never edit an applied file. Add a new
   one instead.
5. Applies each pending file in its own transaction, then records its name and sha256. A failing file rolls back
   completely and is not recorded.

A database migrated by the old drizzle-kit journal (`drizzle.__drizzle_migrations`) is adopted on the first run.
The migrator marks `0000`–`0002` as applied and does not run them again.

The migrator does not split files into statements. One file runs as a single multi-statement query, so do not use
statements that cannot run inside a transaction, such as `CREATE INDEX CONCURRENTLY` or `ALTER TYPE ... ADD VALUE`
followed by use of the new value in the same file.

`MIGRATIONS_DIR` overrides the folder. Otherwise the migrator looks next to `migrate.mjs`, then in
`packages/db/migrations`.

## Number ranges

Each module group writes files only in its own range, so parallel branches never collide on a number:

| Range | Owner | Modules |
| --- | --- | --- |
| `0000`–`0099` | platform / core | Phase 1 tables, RLS, audit, `erp_secure_table()` |
| `0100`–`0199` | A sales | M08 quotation/SO/DO/invoice/credit approval, M10 AR, M09 projects |
| `0200`–`0299` | B purchasing | M18 AP, M04 Import Hub, stock count/ledger/reorder, M05, M19-08 |
| `0300`–`0399` | C retail | M15 promotions, M16 production, held bills, customer price lists |
| `0400`–`0499` | D admin | M17 HR/payroll/leave, M14 SCG Admin, M19-07/09/10/11 |
| `0500`–`0599` | E reports | M11 reports, M12 accounting export |

Name files `<4-digit number>_<snake_case_description>.sql`, for example `0101_quotations.sql`. Files apply in
filename order across all ranges, so a module migration must depend only on core tables (`0000`–`0099`) and on
earlier files in its own range. If you need another module's table, ask its owner to add what you need, or
reference it by `uuid` without a foreign key.

## Rules for a new table

Every tenant table needs `tenant_id uuid NOT NULL`, the RLS policy, grants to `erp_app`, and, for documents, the
no-delete trigger. One call does all of it:

```sql
CREATE TABLE ar_receipts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  no          text NOT NULL,
  date        date NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id),
  total       numeric(14,2) NOT NULL,
  status      text NOT NULL DEFAULT 'active',      -- documents are voided, never deleted
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, no)
);
CREATE INDEX ar_receipts_tenant_date ON ar_receipts (tenant_id, date DESC, id);
SELECT erp_secure_table('ar_receipts', true);    -- true: document (adds the no-delete trigger)

CREATE TABLE price_list_items (...);
SELECT erp_secure_table('price_list_items');     -- master or config data: no trigger
```

`erp_secure_table(tbl regclass, is_document boolean DEFAULT false)` comes from `0003_secure_table_helper.sql`.
It is idempotent:

- It fails if the table has no `tenant_id` column.
- It runs `ENABLE` and `FORCE ROW LEVEL SECURITY` and creates the `tenant_isolation` policy
  (`tenant_id = erp_current_tenant()`, for both USING and WITH CHECK).
- It grants `SELECT, INSERT, UPDATE` to `erp_app`, plus `USAGE, SELECT` on the table's identity or serial
  sequences. It never grants `DELETE` or `TRUNCATE`.
- With `is_document = true`, it adds the `<table>_no_delete` trigger, which calls `erp_forbid_delete()`
  (BR-03/BR-18/BR-22). Use it for documents, their lines, stock movements and anything with legal or audit
  value.

Other conventions, matching the core tables:

- Money is `numeric(14,2)`. Quantities and unit costs are `numeric(14,4)`. Use `timestamptz` and `date`. The
  column helpers are in `src/schema/columns.ts`.
- Document numbers come from `doc_counters` through `nextDocNo` in `apps/server/src/lib/docno.ts`. Do not use
  sequences: a rollback must not leave a gap (BR-04).
- Add new columns to core tables only in your own range, and only when the owner of the core table agrees. Name
  each column after your module (for example, `ar_balance`) so it does not collide with another module's column.
- Functions you create are executable by `erp_app` through the default `PUBLIC` grant. Do not revoke it.
- Global tables without `tenant_id` (for example, M14 central master data) do not use `erp_secure_table`. Write
  their RLS policy and grants by hand in the same migration, and explain the access rule in a comment.

## Checking your migration

```bash
TEST_DATABASE_URL=postgres://erp:erp@localhost:5432/erp_test_a pnpm --filter @erp/server test   # creates the DB, migrates from zero
DATABASE_URL=postgres://erp:erp@localhost:5432/erp pnpm db:migrate                              # upgrade an existing dev DB
pnpm --filter @erp/db test                                                                     # migrator + erp_secure_table tests
```

`resetData()`, used by the tests and by `seed.ts --reset`, truncates every table in `public` except
`schema_migrations`. New tables need no registration.
