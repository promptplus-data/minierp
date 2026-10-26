# @erp/server

Fastify 5 API for SCG Shop ERP. One codebase, two editions (`cloud`, `onprem`). The edition is baked in at
bundle time (`process.env.EDITION` is replaced by esbuild); under `tsx` it is read from the environment.
Business rules come from `@erp/core`. The schema, migrations and seed data live in `@erp/db`. The API shapes
are defined in `@erp/contracts`.

## Run it

```bash
# PostgreSQL 16 on localhost:5432, user erp/erp, databases erp and erp_test
export DATABASE_URL=postgres://erp:erp@localhost:5432/erp
pnpm db:migrate                                        # packages/db/migrations
pnpm --filter @erp/db exec tsx src/seed.ts --reset     # demo shop ร้านวัสดุเจริญชัย (omit --reset to keep data)
EDITION=onprem JWT_SECRET=dev pnpm --filter @erp/server start   # or EDITION=cloud
```

Demo users (password `1234`, approval PIN `1234`): `charoen` (owner), `suda` (manager), `prae` (cashier),
`boy` (sales), `chai` (warehouse). `ton` has resigned and cannot log in.

| Script | What it does |
| --- | --- |
| `pnpm --filter @erp/server start` / `dev` | Run `src/main.ts` with tsx (`dev` watches) |
| `pnpm --filter @erp/server typecheck` | `tsc --noEmit` over `src` and `test` |
| `pnpm --filter @erp/server test` | vitest against `erp_test`. Migrates once, then truncates and re-seeds per file. Files run one at a time |
| `node apps/server/build.cloud.mjs` / `build.onprem.mjs` | Single-file bundles in `dist-cloud/` and `dist-onprem/`, each with `migrate.mjs` and `migrations/` |
| `node scripts/check-onprem.mjs --source` and `... apps/server/dist-onprem` | Prompt Plus guard. Passes on the source and the on-prem bundle. Fails on `dist-cloud`, which is expected |

## Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | (required) | PostgreSQL connection |
| `EDITION` | `cloud` | `cloud` or `onprem`. Fixed in bundles |
| `JWT_SECRET` | dev secret, with a warning | Required when `NODE_ENV=production` |
| `HOST` / `PORT` | `0.0.0.0` / 3000 (cloud), 8443 (onprem) | Listen address |
| `TLS_PFX_FILE`, `TLS_PFX_PASSPHRASE` | unset | Serve HTTPS from a PFX. Plain HTTP when unset |
| `WEB_DIST_DIR` | unset | Static web build, with SPA fallback for non-`/api` GETs that accept HTML |
| `BACKUP_SCRIPT` | unset | On-prem only: runs `<script> -Reason shift-close` after a shift closes. `.ps1` files run through `powershell.exe` (Windows) or `pwsh`. Fire-and-forget: it never blocks or fails the close |
| `MDNS_SERVICE_TYPE` | `_scgerp._tcp` | On-prem only: mDNS advertisement (PTR/SRV/TXT/A) through the pure-JS `multicast-dns` package. `off` disables it |
| `CORS_ORIGIN` | unset | Comma-separated origins for a separately hosted web dev server |
| `DB_POOL_MAX`, `LOG_LEVEL`, `APP_VERSION` | 10, info, 0.1.0 | |
| `MIGRATIONS_DIR` | next to `migrate.mjs` / `packages/db/migrations` | Used by the migrator |
| `PROMPTPLUS_BASE_URL`, `PROMPTPLUS_CLIENT_ID` | unset | Cloud only, read only in `adapters/promptplus.ts` |
| `SCGFAMILY_BASE_URL` | unset | When set, on-prem reports `scgFamily: true`. The adapter itself is a stub |
| `TEST_DATABASE_URL` | `postgres://erp:erp@localhost:5432/erp_test` | Tests |

## How it is built

- **One transaction per request.** `plugins/auth.ts` `authed()` verifies the bearer JWT. It then opens a
  transaction with `SET LOCAL ROLE erp_app` and `set_config('app.tenant_id', …, true)`, re-checks that the user
  is still active, and runs the handler. Any error rolls back the whole request.
- **Tenant isolation (BR-14).** Every table has `tenant_id`, plus `ENABLE` + `FORCE ROW LEVEL SECURITY` with a
  `tenant_id = app.tenant_id` policy. The app role `erp_app` has no DELETE or TRUNCATE privileges and cannot
  UPDATE `audit_log`. A superuser connection still gets RLS because of the role switch. Login is the only
  cross-tenant read. It uses `app.auth_lookup='on'` and a SELECT-only policy on `users`, `tenants` and
  `pairing_codes`.
- **Stock (BR-07/BR-21).** `lib/stock.ts` locks lots with `SELECT … FOR UPDATE`, always ordered by
  `(product_id, received_at, id)`. It plans FIFO consumption with `core.takeLots` and returns every shortage
  as `409 INSUFFICIENT_STOCK` before writing anything. Each move records its lots in `stock_move_lots`. A void
  puts quantities back into the same lots. A good return creates a lot at the sold line's original average
  FIFO cost. `CHECK (remaining >= 0)` is the last line of defence.
- **Document numbers (BR-04).** `lib/docno.ts` upserts a `doc_counters` row inside the document transaction,
  which row-locks it until COMMIT. There are no sequences, so a rollback never leaves a gap.
- **Audit (BR-18).** `lib/audit.ts` writes the audit row as the last statement of each transaction. A trigger
  fills `chain_seq`, `prev_hash` and `hash = sha256(prev_hash || row)` under a per-tenant advisory lock. Other
  triggers forbid UPDATE and DELETE (even for a superuser) and DELETE on documents, lots, moves and users.
  `erp_audit_verify(tenant)` recomputes the chain.
- **Editions.** Prompt Plus code is only in `adapters/promptplus.ts` and `routes/promptplus.ts`, and each use
  is inside `if (process.env.EDITION === 'cloud')`. The on-prem `/api/meta` sends only `{ scgFamily }`. The
  contract fills in `promptPlusOrders` and `promptPlusSso` as `false`, so no cloud-only name ships on-prem.

## Routes

All bodies and responses follow `packages/contracts/src/index.ts`. Errors use
`{ code, message, details? }`. Every list is cursor-paged with `?limit` (default 20, max 100) and `&cursor`.

| Route | Notes |
| --- | --- |
| `GET /healthz` | DB ping. 503 when the DB is down |
| `GET /api/meta` | Public. Shop comes from the bearer token, `?shop=<code>`, or the single on-prem tenant |
| `POST /api/auth/login`, `GET /api/auth/me` | argon2id. Locks after 5 failures. Resigned users are rejected. Every attempt is audited |
| `POST /api/users/:id/unlock` | Owner (`sys.users`) |
| `GET/POST /api/products`, `PATCH /api/products/:id` | `cost` is null without `data.cost`. Writes need `data.master` |
| `GET/POST /api/customers`, `GET /api/vendors`, `GET /api/warehouses` | |
| `GET /api/stock`, `GET /api/stock/lots` | Balances per product × warehouse. Lots need `data.cost` |
| `POST /api/stock/receipts` / `transfers` / `issues` | GR / TR / ADJ numbers. Bill discount is allocated into lot cost. Transfers keep the lot date and cost |
| `POST/GET /api/stock/adjust-requests`, `POST …/:id/approve`, `POST …/:id/reject` | Approval needs `inv.adjApprove` and applies the deltas in one transaction |
| `GET /api/shifts/current`, `POST /api/shifts/open`, `POST /api/shifts/:id/cash-moves`, `POST /api/shifts/:id/close` | `current` is the X report (`Shift` or `null`). Close needs a note when the count differs. On-prem runs the backup hook after close |
| `POST /api/sales/pos` | BR-20 shift, BR-07 stock, BR-16 below cost, discount cap, idempotency. 201 new, 200 replay |
| `GET /api/sales/docs`, `GET /api/sales/docs/:no`, `POST /api/sales/docs/:no/void` | Void: `sales.voidDoc`, PIN when `apv`. Returns `DOWNSTREAM_FIRST` when a CN references the doc |
| `GET /api/returns/eligible`, `POST /api/returns` | pg_trgm haystack search. CN with stock back at original cost |
| `GET /api/audit-log`, `GET /api/audit-log/verify` | `sys.log` |
| `POST /api/devices/pairing-code`, `GET /pair?code=` | On-prem only. 6 digits, 10 minutes, single use. Sets an `erp_device` HttpOnly cookie |
| `GET /api/promptplus/incoming`, `POST /api/promptplus/orders` | Cloud only. Thin stub client |

## Tests and the rules they cover (`test/`)

| File | Covers |
| --- | --- |
| `auth.test.ts` | Login OK with an argon2id hash. Lock after 5 failures, then owner unlock. Resigned user rejected and audited (BR-18). Unknown user. 401 without a token. Cost hidden without `data.cost` |
| `pos.test.ts` | VAT-inclusive ABB totals, `ABB2610-0001`, FIFO COGS across 2 lots with `stock_move_lots` (BR-21). Pack unit to base quantity. Services skip stock. BR-20 shift required, including someone else's shift. Idempotent retry, sequential and concurrent. Payments must equal the total. A full invoice needs a tax ID. Discount over the cashier's 0% cap: blocked, bad PIN, wrong role, then approved. Price change needs approval. BR-16 below cost: blocked, manager PIN rejected, bad owner PIN rejected, owner PIN accepted and logged, owner self-sale logged |
| `stock-integrity.test.ts` | BR-07: two parallel sales of the last 8 units, exactly one wins, stock ends at 0. A sale and an issue racing (different counters): the loser gets a planned shortage. This test fails if `FOR UPDATE` is removed. One short line writes nothing. The DB CHECK rejects negative stock. BR-04: a crash before COMMIT and a shortage after numbering leave no gap. BR-03/BR-22: void keeps the number and restores the exact original lots and cost; a cashier needs a PIN; double void returns 409; a void sale leaves the shift cash; DELETE is refused even for a superuser |
| `returns.test.ts` | Eligible search by customer name, phone (formatted and digits), product name and SKU, bill number, amount, and tax ID; multi-word AND; 7/30/all period filters; newest first; cursor pages; max limit; trigram index exists. Returns: cashier needs a PIN; good condition restocks at the original average FIFO cost (119.3567) into the chosen warehouse; cash refund counts in the shift; quantity over sold minus returned is rejected; the last return gets the exact remainder; fully returned bills leave the picker; bad condition does not restock; cash refund needs a shift; credit refund needs a receivable; DOWNSTREAM_FIRST on void |
| `inventory.test.ts` | Multi-line transfer keeps lot cost; shortage rolls back every line; same warehouse rejected. Multi-line issue with a pack unit; shortage rollback; cashier forbidden; services rejected. Manual receipt: bill discount goes into lot cost; duplicate vendor invoice rejected. Adjustment request, `wh` cannot approve, manager approves, double approve returns 409; negative approval refused and the request stays pending; reject. Stock paging; lots need `data.cost`. Shift: cash in/out, X report with split payments, close needs a note for a difference, Z values, closed shift cannot sell |
| `platform.test.ts` | BR-14 RLS: a query with no WHERE sees only its tenant; no tenant set sees nothing; cross-tenant insert refused; API isolation. BR-18: audit entries and a valid hash chain; UPDATE/DELETE refused for the app role and, by trigger, for a superuser; tampering detected. M19 meta and the route table for both editions. Pairing code is single use and sets a cookie. Backup hook runs after close; a failing script does not fail the close. `/healthz`. SPA fallback and JSON 404 for the API |
| `master.test.ts` | Product create/update/permissions/duplicate SKU/base-unit check; cursor paging and limits; customer auto code and phone search; warehouses and vendors; document list paging and preview |

## Not done in this phase

- **Bundles / promotions.** The contract has no bundle line, so `core.bundleAlloc` is not used yet.
- **SCG Family.** Interface stub only (`adapters/scgfamily.ts`).
- **Prompt Plus.** The client paths are placeholders.
- **Credit sales.** POS sales are always fully paid. `docs.ar_balance` exists and credit refunds reduce it, but
  nothing creates a receivable yet.
- **On-prem first run.** Creating the first tenant and owner on-prem is not built. Use the seed script or add a
  setup flow.
- **Device cookie.** `/pair` issues the `erp_device` cookie, but API requests do not require it yet.
- **Unknown routes on-prem.** An unknown `/api/*` route returns `404 NOT_FOUND`, not `NOT_AVAILABLE_IN_EDITION`.
  The guard forbids the on-prem bundle from naming the Prompt Plus paths.
