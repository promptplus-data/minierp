# Deploying the cloud edition to Vercel

The **cloud** edition runs on Vercel as a static web build plus one Node.js serverless function that serves the
whole Fastify API. The on-premise edition is never deployed here.

```
Browser ──> Vercel CDN ── /assets/*, /index.html ......... apps/web built with VITE_EDITION=cloud
               │
               └─ /api/*, /healthz ──> function "api" ──> buildApp() from apps/server (EDITION=cloud)
                                         (Node 22)             │
                                                               └── pg Pool (max 2) ──> Neon / Vercel Postgres (pooled URL)
```

## How the build works

`vercel.json` sets `buildCommand: pnpm vercel-build`, which runs `scripts/vercel-build.mjs`. The script writes
[Build Output API v3](https://vercel.com/docs/build-output-api/v3) files to `.vercel/output/`. Vercel deploys
that directory as is.

| Output | Source |
| --- | --- |
| `static/` | `apps/web` built with `VITE_EDITION=cloud` |
| `functions/api.func/index.mjs` | `apps/server/src/vercel.ts`, bundled by esbuild with the cloud bundle rules (`build.lib.mjs`) |
| `functions/api.func/node_modules/` | `argon2` and its runtime dependencies, which include its prebuilt `linux-x64` binary |
| `functions/api.func/.vc-config.json` | `runtime: nodejs22.x`, `launcherType: Nodejs`, `maxDuration: 30` |
| `config.json` | Routes: `/api/*` and `/healthz` go to the function. Other paths try static files, then fall back to `index.html` (SPA). `/assets/*` is cached as immutable |

After writing the output, the script migrates the database (`packages/db/src/bootstrap.ts`) when a database URL
is set. With `SEED_DEMO=1`, it also seeds the demo shop. Both steps are idempotent: applied migrations are skipped,
and the seed is skipped once the shop `charoen` exists.

`apps/server/src/vercel.ts` builds the Fastify app once per cold start and passes each request to
`app.server.emit('request', req, res)`. It does not call `listen()`. mDNS, the backup hook and module timers never
start (`backgroundJobs: false`). `main.ts` also turns them off when `VERCEL` is set.

`argon2` is a native module. Its npm package ships prebuilt binaries for `linux-x64` (glibc and musl). The build
runs on Vercel's Linux x64 image and copies the package into the function, so no compiler and no pure-JS fallback
is needed. The local harness below loads the copied binary from outside the repo.

Node 22 comes from `"engines": { "node": "22.x" }` in the root `package.json`. Vercel supports 22.x and 24.x.

## Step by step

1. **Create the project.** In Vercel, choose **Add New → Project**, import `promptplus-data/minierp`, and keep the
   root directory as `./`. Leave **Framework Preset** as **Other**. `vercel.json` sets the install command
   (`pnpm install --frozen-lockfile`) and the build command. Do not set an output directory.
2. **Add the database.** In **Storage → Create Database**, choose **Neon** (Vercel Postgres is now Neon) and
   connect it to the project for Production and Preview. The integration adds `DATABASE_URL` (pooled,
   `sslmode=require`), `DATABASE_URL_UNPOOLED`, `POSTGRES_URL` and `POSTGRES_URL_NON_POOLING`. Put the database in
   the same region as the function. For shops in Thailand, use Singapore (`aws-ap-southeast-1`) and set the function
   region to `sin1` in **Settings → Functions**.
3. **Set the environment variables** (Settings → Environment Variables, Production and Preview):

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | Set by the Neon integration (pooled). The function uses it at runtime |
   | `DATABASE_URL_UNPOOLED` | Set by the integration. The build uses it for migrations, which hold an advisory lock that a pooled connection cannot keep |
   | `JWT_SECRET` | A long random string, for example from `openssl rand -hex 32` |
   | `EDITION` | `cloud`. Informational: the bundle already has the cloud edition built in |
   | `TRUST_PROXY` | `1`, so `req.ip` is the client address from Vercel's `X-Forwarded-For`, not the proxy's |
   | `SEED_DEMO` | `1` for a demo deployment. Remove it for a real shop |
   | `DB_POOL_MAX` | Optional. Default `2` connections per function instance |
   | `LOG_LEVEL` | Optional. Default `warn` |
   | `PROMPTPLUS_BASE_URL`, `PROMPTPLUS_CLIENT_ID` | Optional. Cloud only |

4. **Deploy.** Push to `main`, or click **Deploy**. The build log ends with lines like these:

   ```
   [vercel-build] function api.func (nodejs22.x), native modules: argon2, @phc/format, node-addon-api, node-gyp-build
   [bootstrap] migrations: 4 applied, 0 already applied
   [bootstrap] seeded demo shop "charoen" (tenant …)
   [vercel-build] done -> .vercel/output
   ```

5. **Check it.** Open `https://<project>.vercel.app/healthz`. It should return
   `{"ok":true,"edition":"cloud",…}`. Then open the site and sign in.

Every preview deployment also runs the build, and so the migrations, against its own environment's database. With
the Neon integration, each preview gets its own database branch. If a preview shares the production database, a
migration from an unmerged branch reaches production. Avoid that setup.

## Demo logins (`SEED_DEMO=1`)

Shop: ร้านวัสดุเจริญชัย (code `charoen`). Every password is `1234`, and every approval PIN is `1234`.

| Username | Role |
| --- | --- |
| `charoen` | owner (เจ้าของร้าน) |
| `suda` | manager (ผู้จัดการร้าน) |
| `prae` | cashier (แคชเชียร์) |
| `boy` | sales (พนักงานขาย) |
| `chai` | warehouse (พนักงานคลัง) |

`ton` has resigned and cannot sign in. For a real shop, deploy without `SEED_DEMO`. Then create the tenant and
owner with SCG Admin (M14) once it exists, or with `seedMinimalTenant` from a one-off script.

## Run the Vercel output locally

```bash
createdb erp_vercel   # or: psql postgres://erp:erp@localhost:5432/postgres -c 'create database erp_vercel'
DATABASE_URL=postgres://erp:erp@localhost:5432/erp_vercel SEED_DEMO=1 pnpm vercel-build
DATABASE_URL=postgres://erp:erp@localhost:5432/erp_vercel JWT_SECRET=dev node scripts/vercel-local.mjs          # http://127.0.0.1:3400
DATABASE_URL=postgres://erp:erp@localhost:5432/erp_vercel JWT_SECRET=dev node scripts/vercel-local.mjs --smoke  # scripted check
```

`scripts/vercel-local.mjs` serves `.vercel/output` with plain `node:http`. It applies the `config.json` routes in
order, serves `static/`, and imports `api.func/index.mjs` the way Vercel's Node launcher does. `--smoke` checks
`/healthz`, `/api/meta`, `index.html`, the SPA fallback, a static asset and the API's JSON 404. It then signs in
as `prae`, opens a shift, makes a POS sale and reads the sale back. Set `VERCEL_OUTPUT_DIR` to run a copy of the
output from outside the repo, which proves the function is self-contained. CI runs the build and `--smoke` on every
push.

## Limits and notes

- **Connections.** Each warm instance keeps at most `DB_POOL_MAX` connections, 2 by default. Use the pooled
  (PgBouncer) URL at runtime. The server uses only transaction-local settings (`SET LOCAL ROLE erp_app`,
  `set_config(…, true)`) and unnamed statements, so it works with transaction pooling.
- **Row-level security.** Migrations create the `erp_app` role and grant it to the migrating user. Neon's
  `neondb_owner` has the CREATEROLE right needed for both. Every request then runs as `erp_app`, so RLS
  applies even if the connection role could bypass it. Check the membership with `select pg_has_role(current_user, 'erp_app', 'MEMBER')`, which
  should return `true`.
- **Background jobs** do not run on Vercel. A module that needs a schedule (for example the GR-overdue alert or
  cloud backup) should expose an authenticated route and call it from a Vercel Cron job.
- **Timeouts.** `maxDuration` is 30 s (`VERCEL_MAX_DURATION` at build time changes it). Long exports should page or
  stream.
- **Not tested on Vercel itself.** This setup was verified with the local harness: the build output was run from a
  copy outside the repo against a fresh PostgreSQL 16 database (login and POS sale). It has not been deployed to a
  real Vercel project from this environment.
