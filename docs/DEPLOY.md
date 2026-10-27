# Deploying SCG Shop ERP

One codebase ships as two editions. The edition is fixed at bundle time
(`process.env.EDITION` is replaced by esbuild `define`), not read at runtime.

| | Cloud | On-premise |
| --- | --- | --- |
| Server | `apps/server/dist-cloud/server.mjs` in a Docker image | `apps/server/dist-onprem/server.mjs` as a Windows service |
| Web UI | `apps/web/dist`, served by the server | `apps/web/dist-onprem`, served by the server on the LAN |
| Database | Managed PostgreSQL | Bundled PostgreSQL 16 on the main machine |
| Prompt Plus order/delivery adapters | Included | **Removed at build time and checked by CI** |

## 1. Build pipeline and the on-prem guard

```bash
pnpm install
VITE_EDITION=cloud  pnpm --filter @erp/web build                                  # -> apps/web/dist
VITE_EDITION=onprem pnpm --filter @erp/web exec vite build --outDir dist-onprem   # -> apps/web/dist-onprem
node apps/server/build.cloud.mjs     # -> apps/server/dist-cloud/
node apps/server/build.onprem.mjs    # -> apps/server/dist-onprem/
node scripts/check-onprem.mjs --source
node scripts/check-onprem.mjs apps/server/dist-onprem apps/web/dist-onprem
```

`build.*.mjs` (shared code in `apps/server/build.lib.mjs`) bundles `src/main.ts` and
the workspace packages into one ESM file. Native modules (`argon2`) stay external.
The script lists them in `dist-<edition>/package.json`. Run
`npm install --omit=dev` in that directory **on the target OS** to get the right
prebuilt binary. `packages/db/src/migrate.ts` is bundled to `migrate.mjs`, and
`packages/db/migrations/*.sql` is copied to `migrations/`. The migrator applies the
files in filename order and records each one in `schema_migrations`
(`packages/db/MIGRATIONS.md`). On its first run it adopts a database that the old
drizzle-kit migrator set up.

For the onprem bundle, an esbuild plugin replaces every import whose specifier
**or** resolved file path matches `/promptplus/i` with an empty module.

### Rules for server code

- Put Prompt Plus code in `packages/adapters/promptplus*` or in files named `*promptplus*`.
- Put every call site inside `if (process.env.EDITION === 'cloud') { ... }`. The
  bundler folds that condition to `false` and removes the branch. An unguarded call
  stays in the onprem bundle as `import_promptplus.startX()`, and the guard fails.
- Read `PROMPTPLUS_*` env vars only inside those cloud-only files.

### `scripts/check-onprem.mjs`

| Mode | What it scans | Use |
| --- | --- | --- |
| `--source` | Bundles `apps/server/src/main.ts` in memory with the onprem rules, then checks every module path in the import graph and the emitted code. Exits 0 with a notice if `main.ts` does not exist yet. | PR check, local pre-push |
| `<dir> [<dir>...]` | Every file under each directory, recursively, including sourcemaps, `node_modules` and binaries. Checks file paths and file contents. | After a build; the release workflow also runs it on the whole staged installer payload |

Forbidden: `/promptplus/i`, `PROMPTPLUS_*`, `/prompt[\s_-]plus/i`. Add more with
`--pattern '<regex>'`, for example the Prompt Plus API hostname once it is known.
Exit codes: 0 clean, 1 violation, 2 usage or analysis error.

## 2. Cloud (Docker)

To deploy the cloud edition on Vercel instead of Docker, see `docs/VERCEL.md`.

```bash
docker build -t scg-shop-erp .
docker run -p 3000:3000 \
  -e DATABASE_URL=postgres://USER:PASS@HOST:5432/erp \
  -e JWT_SECRET=... \
  -e PROMPTPLUS_BASE_URL=... -e PROMPTPLUS_CLIENT_ID=... \
  scg-shop-erp
```

The image has three stages: `pnpm fetch` (cached on the lockfile), then the web
build and the cloud server bundle, then `node:22-bookworm-slim` with only
`server.mjs`, `node_modules/argon2` and `web/`. The image runs as the `node` user
and has a `/healthz` health check.

| Env | Default in image | Meaning |
| --- | --- | --- |
| `EDITION` | `cloud` | Informational only; the bundle already has the edition fixed |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Listen address |
| `WEB_DIST_DIR` | `/app/web` | Static web build the server must serve |
| `MIGRATIONS_DIR` | `/app/migrations` | Passed to the migrator |
| `RUN_MIGRATIONS` | `0` | `1` runs `node migrate.mjs` before start. Keep `0` with several replicas; run migrations as a one-off job instead: `docker run --rm ... scg-shop-erp node migrate.mjs` |

Local development:

```bash
docker compose up -d db            # PostgreSQL 16 on localhost:5432 (erp/erp)
pnpm dev:server & pnpm dev:web     # on the host
docker compose up --build          # or run the production image against it
```

## 3. On-premise (Windows)

### What gets installed

`SCG-Shop-ERP-Setup.exe` comes from `.github/workflows/release-windows.yml` on a
`v*` tag. It is built from `apps/installer/setup.iss` with Inno Setup. The first
page asks for the **machine role**.

**Main machine** (one per shop):

| Path | Content |
| --- | --- |
| `C:\Program Files\SCG Shop ERP\node\` | Node.js 22 (win-x64) |
| `...\server\` | `dist-onprem` bundle + win32 `argon2` |
| `...\web\` | `apps/web/dist-onprem` |
| `...\pgsql\` | PostgreSQL 16 binaries (EnterpriseDB zip, trimmed) |
| `...\winsw\`, `...\services\` | WinSW binary, XML templates, rendered service XMLs |
| `...\scripts\` | `install-main.ps1`, `backup.ps1`, `uninstall-main.ps1` |
| `C:\ProgramData\SCG Shop ERP\` | `pgdata\`, `certs\`, `backups\`, `logs\`, `config\secrets.json` (ACL: SYSTEM, Administrators, LocalService) |

After the files are copied, `install-main.ps1` runs. It is idempotent and runs on
every install and upgrade:

1. Generates secrets once: Postgres superuser password, `erp` DB password, JWT secret, PFX password.
2. Runs `initdb` once. PostgreSQL listens on **127.0.0.1:5433** only, with scram-sha-256 auth.
3. Creates a self-signed TLS certificate once. SAN covers the hostname, `hostname.local`, `localhost` and the current LAN IPv4 addresses. Exports `certs\server.pfx` (for the server) and `certs\scg-shop-erp-main.cer` (public, for clients).
4. Registers the WinSW services `scgerp-postgres` and `scgerp-server`. Both run as `NT AUTHORITY\LocalService`, start automatically and restart on failure.
5. Creates the `erp` role and database, then runs `node server\migrate.mjs`.
6. Adds firewall rules: inbound TCP 8443 and UDP 5353 (mDNS), **Private profile only**, remote address `LocalSubnet`. Warns if the network is set to Public.
7. Registers the scheduled task "SCG Shop ERP nightly backup" (23:30, SYSTEM), then starts the server.

On the main machine you can also choose "Also install the client app", which you
need to print receipts there. Without it, the installer creates a desktop
shortcut to `https://localhost:8443/`.

**Client machine**: runs the Tauri client's own NSIS setup silently (`/S`). The
client app is in `apps/desktop/`. See its README.

### Server env contract (on-prem)

The server code must honour these variables. They are set in
`apps/installer/winsw/scgerp-server.xml.template`:

`EDITION=onprem`, `HOST=0.0.0.0`, `PORT=8443`, `DATABASE_URL`, `JWT_SECRET`,
`WEB_DIST_DIR`, `MIGRATIONS_DIR`, `TLS_PFX_FILE` + `TLS_PFX_PASSPHRASE` (serve HTTPS
when set), `DATA_DIR`, `BACKUP_SCRIPT`, `MDNS_SERVICE_TYPE=_scgerp._tcp`
(advertise the HTTPS port for client discovery). The server also needs a
`GET /pair?code=NNNNNN` route for client pairing.

### Connecting a client

1. On the main machine, open the web UI and generate a 6-digit pairing code.
2. On the client, the app lists main machines found by mDNS. You can also type the IP address (default port 8443).
3. Enter the code. The app navigates to `https://<ip>:8443/pair?code=...`.

Known gap: WebView2 does not trust the self-signed certificate yet. Until
certificate import is built, install `certs\scg-shop-erp-main.cer` on each
client into *Local Computer → Trusted Root Certification Authorities*:

```powershell
Import-Certificate -FilePath .\scg-shop-erp-main.cer -CertStoreLocation Cert:\LocalMachine\Root
```

## 4. Backup and restore

`apps/installer/scripts/backup.ps1` runs `pg_dump --format=custom` into
`C:\ProgramData\SCG Shop ERP\backups\erp-<yyyyMMdd-HHmmss>-<reason>.dump`.

| Trigger | Reason | Kept |
| --- | --- | --- |
| Scheduled task, daily 23:30 | `nightly` | 30 |
| Server job after a shift is closed (runs `BACKUP_SCRIPT -Reason shift-close`) | `shift-close` | 60 |
| Installer, before an upgrade | `pre-upgrade` | 5 |
| Start menu "Back up database now", or by hand | `manual` | 20 |

```powershell
# manual backup, plus a copy to a USB drive or NAS share
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\SCG Shop ERP\scripts\backup.ps1" -Reason manual -CopyTo E:\ERP-Backups
```

The script uses `$env:DATABASE_URL` when set (the server passes its own).
Otherwise it reads `config\secrets.json`. It exits 1 on failure and also writes
the error to the Windows Application event log.

Restore (as Administrator, on the main machine):

```powershell
$app = 'C:\Program Files\SCG Shop ERP'
$secrets = Get-Content 'C:\ProgramData\SCG Shop ERP\config\secrets.json' -Raw | ConvertFrom-Json
Stop-Service scgerp-server
$env:PGPASSWORD = $secrets.dbPassword
& "$app\pgsql\bin\pg_restore.exe" -h 127.0.0.1 -p 5433 -U erp -d erp --clean --if-exists --no-owner --single-transaction `
  'C:\ProgramData\SCG Shop ERP\backups\erp-20260101-233000-nightly.dump'
Remove-Item Env:PGPASSWORD
Start-Service scgerp-server
```

Cloud: use the managed database's point-in-time recovery. For a portable copy:
`pg_dump --format=custom "$DATABASE_URL" > erp.dump`, restore with the same
`pg_restore` flags.

## 5. Updates

**Cloud**: build and push a new image. Run `node migrate.mjs` as a one-off job,
then roll the deployment.

**On-premise**: run the new `SCG-Shop-ERP-Setup.exe` on the main machine. Inno
Setup recognises the existing install by `AppId` and remembers the role. Then:

1. `PrepareToInstall` runs `backup.ps1 -Reason pre-upgrade`. If that fails, setup asks before continuing.
2. Setup stops `scgerp-server` and `scgerp-postgres`, then replaces the files.
3. `install-main.ps1` runs again. It keeps the secrets, data and certificate, re-renders the service XMLs, runs migrations and starts the services.

Update client machines with the same setup file (choose "Client machine"), or
with the Tauri client's own setup.

Uninstall removes the services, firewall rules and backup task. It **keeps**
`C:\ProgramData\SCG Shop ERP` (database, backups, certificates).

## 6. Status: what has and has not been tested

| Item | Status |
| --- | --- |
| `check-onprem.mjs` (both modes), `build.{cloud,onprem}.mjs` | Run on Linux against a fixture server: stubbing, leak detection, missing `main.ts` |
| Workflow and compose YAML | Parsed only; never run on GitHub Actions |
| `Dockerfile` | Reviewed only; no Docker daemon was available |
| Tauri client: `discovery.rs`, `printing.rs` | Type-checked in a standalone crate (winspool code compiled on Linux against `windows-sys`); discovery ran (returns `[]`). The full Tauri crate was not compiled: gtk/webkit are missing on Linux and the Windows std target could not be downloaded |
| Receipt printing | Never sent to a real printer |
| `setup.iss`, all `.ps1` scripts, WinSW XMLs | Written, **never compiled or run on Windows** |
| `PG_VERSION=16.10-1` download URL | Not verified (EDB host unreachable from the build container); bump or confirm before the first release |
| Server-side pieces (HTTPS from PFX, `/pair`, mDNS advertisement, shift-close backup job, `/healthz`, serving `WEB_DIST_DIR`) | Contract documented here; not implemented in this change |
