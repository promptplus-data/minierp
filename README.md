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

## Status

Built (Phase 1 + 2): M01 users/roles/approvals, M02 terms & consent, M03 master data, M04 Import Hub, M05 manual receipts + GR alerts, M06 stock (FIFO, counts, ledger, no negative stock), M07 POS + shifts, M08 quotation→SO→DO→invoice, M09 projects, M10 receivables, M11 reports + home dashboard, M12 PEAK/FlowAccount/Express export, M14 SCG Admin, M15 promotions, M16 production, M17 HR/payroll/leave, M18 payables, M19 editions (setup, delivery-file import, cloud backup to S3, sales-summary share, export/import, license keys).

Round 3 (Nov 2026): Thai word-segmented partial search in every picker (SearchSelect, 20-row lazy pages) with quick-create of customers, vendors and ship-to addresses; BR-05 price order on QT/SO/INV; below-cost check on the server with cost/margin only for `data.cost`; POS manager override (PIN at entry, one approval per bill, reason chips) and totals with line + bill discounts; POS customer search and credit sale into AR; stock on SO lines; reserved / available stock; partial count approval and recount; automatic damaged-goods warehouse for returns; notes on every document; LoadMore on long lists.

Each module's routes, rules→tests map and REQ coverage table: `apps/server/src/modules/<group>/README.md` (sales, purchasing, retail, admin, reports).

Not built, waiting on the other teams (specs in `docs/integrations/`): Prompt Plus order/delivery API and SSO (REQ-M05-01/02/05, M08-11, M01-01), SCG Family coupons and points (M13, M08-07). Also deferred: Google Drive / OneDrive backup upload (needs OAuth client ids), POS offline mode (phase 2 by design).

Deploying the cloud demo to Vercel: `docs/VERCEL.md`.
