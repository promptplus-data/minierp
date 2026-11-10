# purchasing (group B)

M18 payables (AP bills from goods receipts, payment vouchers, vendor returns), M04 Import Hub, M06 stock count,
stock ledger and reorder list, M05 GR-overdue alert (BR-10) and M19-08 delivery-file import. Every route exists on
both editions (`purchasingRouteEditions = {}`); the delivery-file import is the on-prem way to receive SCG goods
and is harmless on cloud. No Prompt Plus API code.

Files: `index.ts` (routes), `ap.ts` (settings, receipts list, AP, payments, vendor returns), `grhook.ts` (called by
core `services/inventory.ts` inside the goods-receipt transaction), `delivery.ts` (delivery-file preview/commit,
GR drafts, column profiles, product aliases), `importhub.ts` (M04), `fileparse.ts` (CSV UTF-8/TIS-620 + XLSX),
`stockx.ts` (dashboard, BR-10 alert, stock count, ledger, reorder). Pure rules: `packages/core/src/payables.ts`,
`packages/core/src/importfmt.ts`. Migration `0200_purchasing.sql`. Demo data: `packages/db/src/seedPurchasing.ts`.

## Routes

| Key | Route | Permission |
| --- | --- | --- |
| purchasingSettings / Update | `GET` / `PATCH /api/purchasing/settings` | any / `sys.settings` (BR-19 bill-discount mode) |
| purchasingDashboard | `GET /api/purchasing/dashboard` | any (drafts, overdue drafts, below reorder, AP due 7 days when `fin.ap`) |
| grAlerts | `GET /api/purchasing/gr-alerts` | `inv.receive` or `inv.view` |
| grReceipts / grReceipt | `GET /api/purchasing/receipts[/:no]` | `inv.receive` or `inv.view` |
| apBills, apAging | `GET /api/ap/bills`, `GET /api/ap/aging` | `fin.ap` (read) |
| apPayments / Create / one | `GET|POST /api/ap/payments`, `GET /api/ap/payments/:no` | `fin.ap` |
| vendorReturns / Create / one | `GET|POST /api/ap/vendor-returns`, `GET .../:no` | `fin.ap` |
| purchaseDiscounts | `GET /api/ap/purchase-discounts` | `fin.ap` (read) |
| deliveryPreview / Commit | `POST /api/delivery-imports/preview|commit` | `inv.receive` or `data.import` |
| grDrafts, grDraft, grDraftUpdate | `GET /api/gr-drafts[/:id]`, `PATCH /api/gr-drafts/:id` | `inv.receive` (read also `inv.view`) |
| grDraftCreateProduct | `POST /api/gr-drafts/:id/lines/:lineId/product` | `data.master` or `inv.receive` |
| grDraftConfirm / Cancel | `POST /api/gr-drafts/:id/confirm|cancel` | `inv.receive` |
| importProfiles, productAliases (+ disable) | `GET /api/import/profiles|aliases`, `POST .../:id/disable` | `inv.receive` or `data.import` |
| importTemplate | `GET /api/import/templates/:kind?format=csv|xlsx` | `data.import` (`fin.ap` for opening AP) |
| importPreview / Commit / Batches | `POST /api/import/preview|commit`, `GET /api/import/batches` | `data.import` (`fin.ap` for opening AP) |
| stockCounts / Open / one | `GET|POST /api/stock-counts`, `GET /api/stock-counts/:id` | `inv.count` or `inv.adjApprove` |
| stockCountEntry / Submit / Cancel | `POST /api/stock-counts/:id/entries|submit|cancel` | `inv.count` |
| stockLedger | `GET /api/stock/ledger` | `inv.view` (cost only with `data.cost`) |
| stockReorder | `GET /api/stock/reorder` | `inv.view`, `inv.receive` or `fin.ap` |

Every list is cursor-paged (20 default) with `q` search. Uploads travel as base64 JSON (body limit 15 MB, files
≤ 10 MB / 10,000 rows).

## Rules → tests

| Rule | Where | Test |
| --- | --- | --- |
| BR-19 / REQ-M05-08: bill discount is a separate purchase discount by default, AP and VAT after the discount (10,000 − 300 → 10,379, lot cost stays) | core `purchaseBill`, `grhook.ts` | core `payables.test.ts`; `test/purchasing/ap.test.ts` "10,000 goods − 300…", "BR-19 'alloc' setting…"; `test/inventory.test.ts` manual receipt |
| REQ-M18-01: AP bill created in the GR transaction, due date by vendor term | `grhook.ts`, core `dueDate` | ap.test "due date follows each vendor term", "a failing receipt leaves no AP bill and no number gap" |
| REQ-M18-02: several bills, partial, WHT on pre-VAT amount, no overpay, bills locked `FOR UPDATE` | `ap.ts createPayment`, core `whtAmount`, `checkAllocations` | ap.test "pays several bills…", "refuses overpaying…", "two concurrent payments…" |
| REQ-M18-03 / BR-07 / BR-21: return ≤ received − returned, at the GR lot cost, never negative, reduces AP, vendor CN no. | `ap.ts createReturn`, core `vendorReturnAmounts` | ap.test "vendor returns" (3 tests) |
| REQ-M18-04: aging buckets, due within 7 days | core `agingBucket` etc., `ap.ts aging` | core payables.test "aging"; ap.test "buckets by days overdue…" |
| BR-18: every mutation audited | all mutating handlers | ap.test "every AP mutation is audited" |
| REQ-M19-08 / BR-10: delivery file → one draft per DN, no stock until confirm, DN dedupe, mapping memory, aliases | `delivery.ts` | `test/purchasing/delivery.test.ts` (12 tests, AT-OP-01..07) |
| REQ-M05-03/04: short receipt needs a reason, unmapped lines block confirm, create product from the line | `delivery.ts confirmDraft`, `createProductForLine` | delivery.test "REQ-M05-04…", "REQ-M05-03…" |
| BR-10 / REQ-M05-09: drafts older than 2 days raise the alert until confirmed | `stockx.ts grAlerts` (computed on read, no timer) | delivery.test "BR-10 raises the alert after 2 days"; e2e banner |
| REQ-M04-01/03/04/05/07/08, REQ-M04-02 | `importhub.ts`, core `importfmt.ts` | `test/purchasing/importhub.test.ts` (11 tests); core `importfmt.test.ts` |
| REQ-M06-05/06 / BR-09: count hides system qty, several counters, sales during the count netted, variance → adjustment request approved by the owner/manager | `stockx.ts` + core adjust approval | `test/purchasing/stock.test.ts` "stock count" (4 tests) |
| REQ-M06-01 ledger / reorder | `stockx.ts ledger`, `reorder` | stock.test "stock ledger" (2 tests) |
| Seed idempotent, ledger = lots | `seedPurchasing.ts` | `test/purchasing/seed.test.ts` |

Browser flows (both editions): `e2e/purchasing.spec.ts` — delivery file → drafts → map → confirm (stock + AP),
BR-10 banner, payment voucher with WHT, vendor return, stock count → approval request, Import Hub dry run +
commit. Screenshots: `e2e/screenshots/purchasing-<edition>-*.png`.

## REQ coverage

| REQ | Status | Notes |
| --- | --- | --- |
| REQ-M04-01 | done | CSV/XLSX ≤ 10,000 rows, templates per kind (CSV with BOM and XLSX), batch log with user |
| REQ-M04-02 | done | Opening stock per warehouse, opening AR (old doc no., dates, no tax doc) and opening AP bills |
| REQ-M04-03 | done | Mapping guessed from Thai/English headers, saved per source program and reused |
| REQ-M04-04 | done | Row status ok/warn/error/exists with reasons, error-row download (web), all-or-nothing or valid rows only |
| REQ-M04-05 | partial | Barcode match links to the existing product; same-name match is only a warning. No interactive "confirm suggested pair" screen |
| REQ-M04-06 | not done | Periodic data feed of sales/purchases from other programs is not built (mode `ongoing` exists only as a batch label) |
| REQ-M04-07 | done | Same file flagged; master rows "exists" with skip/update; opening lots and documents skipped by source no. |
| REQ-M04-08 | done | Several lots per code, yyyymmdd dates, bad date / unknown code are row errors, FIFO by date |
| REQ-M05-03 | done | Received/damaged per line, reason when short, warehouse choice, stock only on confirm |
| REQ-M05-04 | done | Unmapped status, create product from the line, confirm blocked until all lines are mapped (aliases remembered) |
| REQ-M05-06 | partial | Core manual receipt now also writes GR lines and the AP bill; bill photo attachment and purchase-VAT report are not in this group |
| REQ-M05-08 | done | Bill discount on manual receipt and draft confirm; BR-19 setting `sep` (default) / `alloc` |
| REQ-M05-09 | partial | Banner on the receiving and ledger screens; the home page has no dashboard yet (home redirects to the first menu). `GrAlertBanner` / `GET /api/purchasing/gr-alerts` are ready for the home dashboard owner |
| REQ-M05-01/02/05 | not in scope | Depend on the Prompt Plus API (cloud integration, out of scope) |
| REQ-M06-01 | partial | Ledger with running balance and documents, reorder list. Reserved / available quantities are owned by core stock / sales |
| REQ-M06-05 | done | Whole warehouse or by category, scan or type a code, system qty hidden, several counters. Camera scanning uses the device's scanner input |
| REQ-M06-06 | partial | Variance becomes one adjustment request (approved via the core adjust approval); movements during the count are netted. Partial approval / "recount" are handled by rejecting the request and opening a new round |
| REQ-M18-01 | done | AP bill per GR with vendor invoice, due date by term, base/VAT/total, separate discount |
| REQ-M18-02 | done | Payment voucher over several bills, partial, transfer/cheque/cash, WHT 0/1/3% |
| REQ-M18-03 | done | Vendor return against the GR at the lot cost, ≤ remaining, reason, vendor CN no., reduces AP |
| REQ-M18-04 | partial | Aging buckets and "due within 7 days" card on the AP screen; home-page card waits for the home dashboard (`ApDueCard`) |
| REQ-M19-08 | done | Generic CSV/Excel delivery file (OQ-19: shop maps columns), one draft per DN, DN dedupe, stock on confirm only, BR-10 |
| BR-07, BR-09, BR-10, BR-19, BR-21 | done | See the rules table |

## Cross-cutting: pickers, notes, lazy lists

| REQ | Status | Notes |
| --- | --- | --- |
| Searchable entity pickers | done | Vendor (`VendorPicker`, partial Thai search, "+ สร้างผู้ขายใหม่" → `POST /api/vendors`, `data.master`), product (`ProductPicker` with stock) in manual receipt, delivery import, draft confirm (line mapping). Small enums stay `<select>` |
| Document note (หมายเหตุ) | done | GR (manual + draft confirm; stored in `stock_docs.reason`), AP bill (copied from GR, `PATCH /api/ap/bills/:no` `{ note }` with `fin.ap`, audited), PV, vendor return, import batch (Import Hub + delivery file). Migration `0640_document_notes.sql`. Shown on list rows and detail pages |
| Lazy lists | done | Drafts, receipts, AP bills, PVs, vendor returns, discounts, import history, profiles, aliases: 10–20 rows per page with `LoadMore` (infinite scroll) |

Tests: `apps/server/test/notes-pickers.test.ts`; e2e `e2e/pickers.spec.ts` (vendor partial search, GR → AP note, bill note edit).
