# Module groups: where each agent works

Phase 2 is built by parallel module groups, each in its own git worktree. Every group owns its own files in each
layer. A group edits only the files listed for it, so branches merge without conflicts.

| Group | Name | Modules | Migration range |
| --- | --- | --- | --- |
| A | `sales` | M08 quotation/SO/DO/invoice/credit approval, M10 AR (billing note, receipts, WHT, aging), M09 projects | `0100`–`0199` |
| B | `purchasing` | M18 AP, payment vouchers, vendor returns, M04 Import Hub, stock count/ledger/reorder, M05 GR-overdue alert, M19-08 delivery-file import | `0200`–`0299` |
| C | `retail` | M15 promotions (discount and bundle in POS), M16 production (BOM/MO), held bills, customer price lists | `0300`–`0399` |
| D | `admin` | M17 HR/payroll/leave, M14 SCG Admin (tenants, central master, KPI, license issuing), M19-07 on-prem to cloud export/import, M19-09 cloud backup, M19-10 sales-summary share, M19-11 license verification | `0400`–`0499` |
| E | `reports` | M11 reports, M12 PEAK/FlowAccount/Express export | `0500`–`0599` |

## Files you own (replace `<m>` with your group name)

| Layer | Path | Notes |
| --- | --- | --- |
| SQL migrations | `packages/db/migrations/<NNNN>_<name>.sql` in your range | Rules and `erp_secure_table()`: `packages/db/MIGRATIONS.md` |
| Drizzle schema | `packages/db/src/schema/<m>.ts` | Re-exported by `schema/index.ts`. Column helpers are in `schema/columns.ts` |
| API contract | `packages/contracts/src/modules/<m>.ts` | zod schemas, `<m>Routes` and `<m>RouteEditions`. Shared building blocks come from `../core` |
| Server plugin | `apps/server/src/modules/<m>/index.ts` (+ any `modules/<m>/*.ts`) | Exports `<m>Module: ErpModule`. Conventions are in `modules/types.ts` |
| Server tests | `apps/server/test/<m>/*.test.ts` | Import `../helpers` (`setupEnv`, `login`, `client`, `openShift`, `saleBody`) |
| Web module | `apps/web/src/modules/<m>/index.tsx` (+ screens in the same folder) | Exports `<m>Module: WebModule = { nav, routes }` |
| e2e | `e2e/<m>.spec.ts` | Picked up automatically. Use `./helpers` (`login`, `approve`, `apiToken`, `EDITION`) |

The registries are already wired, so nobody edits them: `packages/db/src/schema/index.ts`,
`packages/contracts/src/index.ts`, `apps/server/src/modules/index.ts`, `apps/web/src/modules/index.tsx`,
`Shell.tsx` and `main.tsx`.

### Shared files (avoid; if you must, make a small additive change)

- `packages/core/src/*`: pure rules. Add a new file (for example, `ar.ts`) and one `export *` line in
  `index.ts`. Every permission key the modules need already exists in `perms.ts` (`sales.creditApv`,
  `fin.ap`, `inv.count`, `inv.produce`, `promo.manage`, `hr.*`, `rep.view`, `data.export`, ...).
- `packages/contracts/src/core.ts`: only if you need a new `ApiError` code. Append it to the end of the enum.
- `apps/web/src/styles.css`: put module styles in a CSS file inside your web folder and import it from your screen.
- `packages/db/src/seed.ts`: put demo data for your module in your own `seed<M>.ts`, called from your tests.
  Change the shared demo seed only when a cross-module e2e flow needs the data.

## Server plugin

```ts
// apps/server/src/modules/sales/index.ts
import { ArReceiptReq } from '@erp/contracts';
import { requirePerm } from '../../lib/context';
import type { ErpModule } from '../types';
import { createReceipt } from './receipts';

export const salesModule: ErpModule = async (app, { deps, authed }) => {
  app.post('/api/ar/receipts', authed(async (tx, ctx, req, reply) => {
    requirePerm(ctx, 'fin.ar');
    reply.status(201);
    return createReceipt(tx, deps, ctx, ArReceiptReq.parse(req.body));
  }));
};
```

- `authed()` runs the handler in one transaction as `erp_app`, with `app.tenant_id` set, so RLS applies. Any
  throw rolls the whole request back. Throw `E.*` from `lib/errors.ts`.
- Use `nextDocNo` (`lib/docno.ts`) for document numbers, `writeAudit` (`lib/audit.ts`) as the last statement,
  `lib/stock.ts` for stock moves (FIFO, `FOR UPDATE` order), `lib/approval.ts` for PIN approvals, and
  `lib/paging.ts` for cursor lists.
- Edition-only code: `if (process.env.EDITION === 'cloud') { if (deps.edition === 'cloud') { ... } }`. List the
  route in `<m>RouteEditions` (for example, `{ adminTenants: 'cloud' }`). `test/platform.test.ts` checks that every
  contract route is registered, except the routes listed for the other edition.
- Timers and schedulers (GR-overdue alerts, cloud backup): start them only when `deps.backgroundJobs` is true
  (false in tests and on Vercel), and stop them in `app.addHook('onClose', ...)`. On Vercel, expose the job as an
  authenticated route that a Vercel Cron can call instead.
- No Prompt Plus names outside files named `*promptplus*` (`scripts/check-onprem.mjs`).

## Contract

```ts
// packages/contracts/src/modules/sales.ts
import { z } from 'zod';
import { Dec, DecNN, pageQuery, type RouteEditions } from '../core';

export const ArReceiptReq = z.object({ customerId: z.string(), amount: DecNN, wht: DecNN.default('0') });
export const salesRoutes = { arReceiptCreate: 'POST /api/ar/receipts', arReceipts: 'GET /api/ar/receipts' } as const;
export const salesRouteEditions: RouteEditions<typeof salesRoutes> = {};
```

Every export is re-exported from `@erp/contracts`, so give names a module prefix. `routes` merges all the tables.
A duplicate route key, or the same `METHOD /path` declared twice, throws when the package is imported, so the
first test run catches it.

## Web module

```tsx
// apps/web/src/modules/sales/index.tsx
import { lazy } from 'react';
import type { WebModule } from '../types';
const ArList = lazy(() => import('./ArList'));
const ArDetail = lazy(() => import('./ArDetail'));

export const salesModule: WebModule = {
  nav: [{ path: '/ar', label: 'ลูกหนี้ / รับชำระ', code: 'M10', section: 'sale', icon: 'ar', perm: 'fin.ar', order: 40 }],
  routes: [{ path: '/ar', element: <ArList /> }, { path: '/ar/:no', element: <ArDetail /> }],
};
```

`NavItem` (`apps/web/src/modules/types.ts`):

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | `string` | Top-level path. Every route under it is guarded by this item's visibility |
| `label` | `string` | Thai label for the nav and the page header |
| `code` | `string` | Module code shown in the nav and header (`'M10'`) |
| `section` | `'ov' \| 'sale' \| 'inv' \| 'data' \| 'hr' \| 'sys' \| 'adm'` | Nav group and accent colour: ภาพรวม, ขาย, ซื้อและคลัง, ข้อมูลหลัก, บุคคล, ตั้งค่า, SCG Admin |
| `icon` | `IconName \| string` | Key from `modules/icons.ts` (`dash pos sales returns project ar gr stock count master import export reports settings log admShops admMaster admMonitor admUsers`) or raw 24×24 SVG markup |
| `perm?` | `PermKey \| PermKey[]` | Visible when the role has any of them (non-zero `core.perm`) |
| `edition?` | `'cloud' \| 'onprem'` | Only in that build |
| `capability?` | `keyof Capabilities` | Only when `/api/meta` reports the capability as true |
| `show?` | `(can, caps) => boolean` | Extra condition, combined with AND |
| `order?` | `number` | Position within the section. Default 100. Core items use 10–90 |

Routes are react-router `RouteObject`s with absolute paths. The registry wraps each element in `Suspense` and in
a guard. The guard redirects to `/` when the nav item with the longest matching path prefix is hidden for the
user. A route that matches no nav item is not guarded, so it must check permissions itself.

## Running checks in your worktree

```bash
export TEST_DATABASE_URL=postgres://erp:erp@localhost:5432/erp_test_a     # b, c, d, e for the others
pnpm --filter @erp/server test                       # creates erp_test_a if missing, migrates from zero
pnpm --filter @erp/server exec vitest run test/sales # just your folder
E2E_DB=erp_e2e_a E2E_PORT=3410 pnpm e2e              # onprem on 3410, cloud on 3411 (B: 3420, C: 3430, ...)
E2E_DB=erp_e2e_a E2E_PORT=3410 EDITION=cloud pnpm e2e -- e2e/sales.spec.ts
pnpm -r typecheck && node scripts/check-onprem.mjs --source
```
