# Brief for module builder agents (Phase 2)

You are a builder agent for one module group of the SCG Shop ERP. Read, in this order:
1. `docs/MODULES.md` — the files you own, conventions, helpers. Edit ONLY your group's files (plus the small additive exceptions listed there).
2. `packages/db/MIGRATIONS.md` — migration range and `erp_secure_table()`.
3. `docs/BRD.md` — the requirements (REQ-Mxx-yy), business rules (BR-xx), NFRs. Your acceptance criteria come from here. Thai is the UI language.
4. `docs/mockup.html` — the clickable mockup the screens come from (search `VIEWS.<name>`, modal functions, seed data). Match its layout, Thai wording, document print layouts.
5. `apps/server/README.md`, `packages/core/README.md`, existing code in `apps/server/src/services`, `apps/web/src/pages|pos|stock` — follow the same patterns (transactions via `authed()`, `nextDocNo`, `writeAudit`, FIFO helpers in `lib/stock.ts`, cursor paging, `E.*` errors, zod contracts, TanStack Query, `ui.tsx` components).

## Non-negotiables
- Business rules enforced on the SERVER, in one transaction, with tests. Money as decimal strings / `numeric`; use `@erp/core` (calcDoc, takeLots, dueDate, bahtText, payRow, bundleAlloc, perm…) — add new pure rules to core as a new file + tests rather than inline.
- BR-07 stock never negative (lock lots `FOR UPDATE` via existing helpers), BR-21 FIFO with original-cost restore, BR-04 gap-free numbering, BR-03/22 no deletes (void = flag, downstream first), BR-18 audit every mutation, BR-14 tenant isolation (every new table: `tenant_id` + `erp_secure_table`).
- Permissions via `requirePerm` / core `perm` keys; approvals with PIN go through `lib/approval.ts` (no self-approval, lockout).
- Cost fields hidden unless `data.cost`.
- Every list endpoint cursor-paged (20 default) + search; every list screen paged with skeleton loading (NFR-12).
- Edition rules: On-premise must contain NO Prompt Plus code/strings (`node scripts/check-onprem.mjs --source` and on bundles). Never write the words "promptplus"/"prompt plus" in your files unless the file path contains `promptplus` and is cloud-only. SCG Family is cloud-only (OQ-A2). Integrations with Prompt Plus / SCG Family are OUT of scope — specs exist in `docs/integrations/`; do not call them.
- Background timers only when `deps.backgroundJobs` is true.
- Demo data: export an idempotent `seed<Group>(client, tenantId)` from `packages/db/src/seed<Group>.ts` that adds realistic Thai demo records for your modules (used by tests, e2e and the Vercel demo). Do not edit the shared `seed.ts`.

## Isolation for parallel work
- You run in your own git worktree. Run `pnpm install` first.
- PostgreSQL 16 is local (`service postgresql start` if down), superuser `erp`/`erp`. Use YOUR databases only:
  `TEST_DATABASE_URL=postgres://erp:erp@localhost:5432/erp_test_<g>` and `E2E_DB=erp_e2e_<g> E2E_PORT=<port>` (g/port given in your prompt). Never touch `erp`, `erp_test`, `erp_e2e` or another group's DBs.
- Do not push. Commit on your worktree branch in logical commits; each message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01UvHoQ23P99VFN8eYoVLAn7
  ```

## Done means
- `pnpm -r typecheck`; `pnpm --filter @erp/core test`; `TEST_DATABASE_URL=… pnpm --filter @erp/server test` (all, not just yours); `E2E_DB=… E2E_PORT=… pnpm e2e` for BOTH editions; `node apps/server/build.onprem.mjs && node scripts/check-onprem.mjs apps/server/dist-onprem`; onprem web build passes the guard.
- Screens look right: take screenshots at 1300px and 390px of your main screens into `e2e/screenshots/<group>-*.png`, LOOK at them, fix overflow/layout.
- `apps/server/src/modules/<group>/README.md`: routes, rules → tests map, REQ coverage table (REQ id → done/partial/not done + why).
- Final report: REQ coverage, routes, contract additions, tests added (counts), shared-file edits (exact), anything deferred.
