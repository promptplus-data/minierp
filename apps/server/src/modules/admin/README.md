# admin module (group D)

M17 HR / payroll / payslip / leave, M14 SCG Admin (cloud only), M02 terms and consent, M19-07 export/import, M19-09 cloud
backup, M19-10 manual sales-summary share, M19-11 license keys. No Prompt Plus or SCG Family integration code.

## Files
| File | Purpose |
| --- | --- |
| `hr.ts` | Employees (+ login user created together, resign/rehire), leave, payroll runs, payslips, labour cost (rules in `@erp/core` `hr.ts`) |
| `license.ts`, `license-pubkey.ts` | Ed25519 signed keys `SCG1.<payload>.<sig>`; offline verification with the embedded public key; 30-day warning; expired = read-only |
| `terms.ts` | M02 terms versions, consent, signed copy; BR-15 gate for newly opened shops |
| `adm.ts`, `platform.ts`, `support.ts` | SCG Admin: separate sign-in, shops, central master + push, KPI, license issuing, support grants, platform audit |
| `transfer.ts`, `box.ts` | Passphrase-encrypted shop export / import / restore (scrypt + AES-256-GCM, client-side of the cloud store) |
| `backup.ts`, `s3.ts`, `oauth.ts` | Backup settings and runs (off by default), S3 SigV4 signed PUT, Drive / OneDrive device flow |
| `share.ts` | Sales-summary preview and manual send (no customer data) |

## Routes
HR: `GET/POST /api/hr/employees`, `GET/PATCH /api/hr/employees/:id`, `POST .../resign|rehire`, `GET/PATCH /api/hr/settings`,
`GET/POST /api/hr/leaves`, `POST /api/hr/leaves/:id/approve|reject`, `GET /api/hr/leave-balances`, `GET /api/hr/me`,
`GET/POST /api/hr/payroll`, `GET /api/hr/payroll/:period`, `PATCH .../lines/:lineId`, `POST .../recalc|approve|reopen|pay`,
`GET .../slips`, `GET /api/hr/labour-cost`.
On-prem: `GET/POST /api/license`, `POST /api/system/export`, `GET/POST /api/backup/config`, `POST /api/backup/oauth/start|poll`,
`POST /api/backup/run`, `GET /api/backup/runs|files`, `POST /api/backup/restore[/files]`, `GET /api/share/config|preview|history`,
`POST /api/share/send`. Both: `GET /api/terms`, `POST /api/terms/accept`, `GET/POST /api/support-grants`, `.../revoke`.
Cloud: `POST /api/scg/sales-summary` (receiver), `/api/adm/*` (auth, admins, tenants, kpi, central-products, central-push,
licenses, sales-shares, audit).

## License keys
Only the public key is in the repo (`license-pubkey.ts`). The private key is held by SCG: cloud server env
`LICENSE_SIGNING_KEY` (PKCS#8 PEM or its base64), or `node scripts/license-gen.mjs --key-file <file outside the repo>`.
`license-gen.mjs` refuses a key file inside the repository. Rotate with `--keygen --out <file outside repo>` and paste the printed
public key. Tests and e2e sign with a throw-away keypair and point the verifier at it with `ERP_LICENSE_TEST_PUBKEY`
(ignored when `NODE_ENV=production`).

## Rules to tests
| Rule | Test |
| --- | --- |
| User created with the employee, one-time temp password, audited | `hr.test.ts` creates the employee and the user together |
| Username unique incl. resigned, format | `hr.test.ts` usernames are unique |
| Thai national id check digit | `hr.test.ts` rejects a national id |
| Pay hidden without `hr.salary` | `hr.test.ts` pay and national id are hidden |
| Resign closes login, never deletes, rehire | `hr.test.ts` resign = status + login closed |
| Leave balances, half day, Sundays, no self-approval, over-entitlement | `hr.test.ts` (4 leave tests) |
| SSO 5% capped, payroll lines, locked after paid | `hr.test.ts` SSO / daily pay / draft to paid |
| Payslips with Thai baht text, staff see own paid slip | `hr.test.ts` payslips per person |
| Labour cost | `hr.test.ts` labour cost |
| Signed key offline, tamper / other signer rejected | `license.test.ts` verifies the signature offline |
| 30-day warning, expiry read-only, lifetime | `license.test.ts` warns 30 days; expired key |
| Key bound to shop and edition; owner only | `license.test.ts` only the owner installs |
| SCG Admin auth separate, lockout | `adm.test.ts` wrong password |
| Tenant isolation for platform context | `adm.test.ts` platform context sees no shop rows |
| New shop + owner, terms gate | `adm.test.ts` creates shop; the new shop cannot be used |
| Suspend / resume | `adm.test.ts` suspend |
| KPI | `adm.test.ts` counts cloud shops |
| Central master and push | `adm.test.ts` creates a product; push |
| Support grant (owner consent, read-only, logged) | `adm.test.ts` needs an active grant |
| License issuing + summary receiver | `adm.test.ts` issues expiring and lifetime keys; receiver |
| Export / import 100% match | `transfer.test.ts` imports with stock lots |
| Wrong passphrase / tamper refused | `transfer.test.ts` wrong passphrase |
| S3 SigV4 PUT to a local stub | `transfer.test.ts` AWS example; round-trips through a signature-checking store |
| Backup off by default, no secrets returned, failures recorded | `transfer.test.ts` is off by default; saves settings |
| Drive device flow | `transfer.test.ts` Google Drive |
| Summary has no customer data, owner-only | `transfer.test.ts` preview; needs the owner |
| Restore on a new machine | `transfer.test.ts` only while the machine has no shop |
| Screens end to end, both editions | `e2e/admin.spec.ts` |

## REQ coverage
| REQ | Status | Notes |
| --- | --- | --- |
| REQ-M01-10 (user with employee) | done | |
| REQ-M02-01 sign terms and consent | done | |
| REQ-M02-02 signed copy | done | Printable page (`/terms/signed`, save as PDF from the browser); no server-side PDF file |
| REQ-M02-03 new version re-consent | done | |
| REQ-M02-04 paper scan | not done | No paper-scan upload or paper-signed consent record; electronic signing only (deferred) |
| REQ-M02-05 export on termination | done | Shares the M19-07 export |
| REQ-M14-01 open shop | done | |
| REQ-M14-02 central master + push | done | |
| REQ-M14-03 KPI (registered shops) | done | |
| REQ-M14-04 suspend / resume | done | |
| REQ-M14-05 support access | done | Owner grant, read-only, logged |
| REQ-M17-01..06 HR, payroll, slips, leave, labour cost | done | |
| REQ-M19-06 on-prem setup offline | not in this group | Restore wizard (`/restore`) added for a new machine |
| REQ-M19-07 export / import | done | |
| REQ-M19-09 cloud backup | partial | S3 done and tested; Drive / OneDrive sign-in by device flow done, file upload is a stub marked TODO until SCG registers OAuth client ids |
| REQ-M19-10 manual sales summary | done | |
| REQ-M19-11 license | done | |
