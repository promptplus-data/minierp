# SCG Shop ERP

ERP/POS for SCG sub-dealer shops. One codebase, two editions:

| Edition | How it runs | Prompt Plus order API |
|---|---|---|
| **Cloud** (`EDITION=cloud`) | Multi-tenant SaaS: Docker image + managed PostgreSQL | Yes |
| **On-premise** (`EDITION=onprem`) | Windows installer: main machine (server + PostgreSQL as services) + client machines (Tauri app) over the shop LAN | **No** — not compiled into the build; CI enforces it with `scripts/check-onprem.mjs` |

Design docs: BRD/FSD v0.2 and Solution Architecture v0.1 (Claude Docs), clickable mockup in `docs/mockup.html`.

## Layout

```
packages/core       pure business rules (VAT, FIFO, below-cost, doc numbers, baht text, payroll…) — 76 unit tests
packages/contracts  zod API contract shared by server and web
packages/db         drizzle schema per module, file-based SQL migrations (RLS, no-delete triggers, audit hash chain), seed
apps/server         Fastify API — 91 integration tests on real PostgreSQL
apps/web            React + Vite UI ported from the mockup
apps/desktop        Tauri v2 client for on-prem client machines
apps/installer      Inno Setup + WinSW + PowerShell for the on-prem main machine
e2e/                Playwright flows, run against both editions
```

## Quick start (dev)

```bash
pnpm install
export DATABASE_URL=postgres://erp:erp@localhost:5432/erp
pnpm db:migrate
pnpm --filter @erp/db exec tsx src/seed.ts --reset   # demo shop: charoen / suda / prae / boy / chai, password & PIN 1234
EDITION=cloud JWT_SECRET=dev PORT=3000 pnpm dev:server
pnpm dev:web                                         # http://localhost:5173 (proxies /api to :3000)
```

## Checks

```bash
pnpm -r typecheck
pnpm --filter @erp/core test
pnpm --filter @erp/db test            # migrator + erp_secure_table (creates <test db>_migrate)
pnpm --filter @erp/server test        # TEST_DATABASE_URL, default postgres://erp:erp@localhost:5432/erp_test (created if missing)
pnpm e2e                              # builds + runs both editions in Chromium (E2E_DB, E2E_PORT override)
node scripts/check-onprem.mjs --source
```

Deploy and on-prem install: `docs/DEPLOY.md`. Cloud on Vercel: `docs/VERCEL.md`. Server routes, env vars and
rule-to-test map: `apps/server/README.md`. Where each module group's code goes (schema, migration range, contract,
server plugin, web module, tests): `docs/MODULES.md` and `packages/db/MIGRATIONS.md`.

## Phase 1 scope

Done: login/roles/approvals (M01), products/customers/vendors (M03), manual purchase receipt (M05-06), stock with FIFO lots, transfer, issue, adjust approval, no negative stock (M06), shift + POS with VAT, discounts, below-cost owner approval, receipts (M07), sales docs + void (M08), returns with searchable bill picker (M08-06), audit log, on-prem first-run setup and device pairing.

Next: quotations/SO/DO/invoices and AR (M08–M10), projects (M09), reports and PEAK export (M11–M12), SCG Family coupons (M13), SCG Admin (M14), promotions (M15), production (M16), HR/payroll (M17), AP (M18), Prompt Plus integration once its API is confirmed (OQ-16).
