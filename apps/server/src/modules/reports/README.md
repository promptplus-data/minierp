# reports (group E): M11 reports + home dashboard, M12 accounting export

Contract: `packages/contracts/src/modules/reports.ts`. Migrations: `0500_reports_export.sql` (export tables, GL map, indexes),
`0501_reports_sources.sql` (read-only views over groups A/B). Web: `apps/web/src/modules/reports/`. Pure rules: `packages/core/src/taxreport.ts`, `acctexport.ts`.

## Routes
| Route | Perm | Notes |
| --- | --- | --- |
| `GET /api/reports/dashboard` | per card | home cards; a card is null when the role may not see it |
| `GET /api/reports/sales` | rep.view | by day/month/product/category/customer/seller/saleType; json (cursor) / csv / xlsx |
| `GET /api/reports/stock` | rep.view | as of a date, warehouse, low / slow; FIFO value needs data.cost |
| `GET /api/reports/vat` | rep.view | output / input VAT per month |
| `GET /api/reports/costs` | data.cost | issues, adjustments, bad returns, payroll + employer SSO (hr.salary) |
| `GET /api/reports/promotions` | rep.view | numbers from retail `promoPnl` (one source) |
| `GET /api/reports/coupons` | rep.view | cloud only; empty until M13 provides `rpt_coupon_redemptions` |
| `GET/PATCH /api/acct-export/gl` | data.export | GL codes used by PEAK / journal |
| `POST/GET /api/acct-export/runs`, `GET .../:id`, `GET .../:id/files/:seq` | data.export | run, history, file download |

## Sources (other groups)
- Sales: core `docs` (POS ABB, B2B INV via group A, RC, CN). Cost: `stock_moves` ledger. Voids excluded from totals, shown as 0 in VAT.
- Purchases: view `rpt_purchase_docs` over `ap_bills` (group B), lines from `gr_lines`. Base after bill discount; discount kept apart.
- Payroll: group D `hr_labour_cost_monthly`. Promotions: group C `promoPnl`. AR: `rpt_ar_open` (docs + `sales_invoices.due_date`). GR waiting: `rpt_gr_pending` (`gr_drafts`).
- Approvals card: `adjust_requests` (inv.adjApprove) and `leave_requests` (hr.leave).

## Rules -> tests
| Rule | Test |
| --- | --- |
| Sales/GP equal documents and ledger; voids out; CN minus | `test/reports/reports.test.ts` (sales) |
| B2B invoice adds exact net/VAT/cost, void reverts, shows in AR card | `test/reports/crossmodule.test.ts` |
| Stock as of a date from the ledger; low/slow | `reports.test.ts` (stock) |
| ABB per day per POS, voided at 0, CN negative | `reports.test.ts` (VAT) + `core/taxreport.test.ts` |
| Input VAT = AP bills after discount | `crossmodule.test.ts` |
| PEAK 21 / 47 columns, 2 header rows, split at 1,000 rows, GL codes | `export.test.ts`, `core/acctexport.test.ts` |
| Only-new, changed-after-export warning, history, audit | `export.test.ts` |
| Tenant isolation, edition rule for coupons, perms | `reports.test.ts` |
| Browser flows, CSV/XLSX downloads, 1300/390 px | `e2e/reports.spec.ts` |

## REQ coverage
| REQ | Status | Note |
| --- | --- | --- |
| M11-01 sales and GP | done | all groupings, filters, CSV/XLSX; project sale type shows 0 until group A tags project invoices as such |
| M11-02 stock | done | FIFO value as of date, slow movers, below reorder |
| M11-03 VAT | done | sales and purchase; vendor returns (CN from vendor) not netted from input VAT (deferred) |
| M11-04 home | done | reuses GrAlertBanner, ApDueCard, `/api/ar/due-soon`; "/" route |
| M11-05 coupons | partial | cloud-only screen and route; no data source until M13 (no SCG Family calls) |
| M11-06 internal cost | done | issues, adjustments, bad returns, payroll + employer SSO |
| M11-07 promo P&L | done | linked to the retail report |
| M12-01 PEAK | done | sales/purchase 21 cols, contacts 47, products template |
| M12-02 GL codes | done | editable mapping, audited |
| M12-03 FlowAccount / Express / journal / generic | done | |
| M12-04 history | done | only-new, changed-after warnings |
| M12-05 auto-split | done | <= 1,000 rows per PEAK file |
| M12-06 shop settings GL | done | |

## Lazy report tables

Sales, stock and VAT tables load 20 rows at a time (`useReportPages` + `LoadMore`). KPIs and the total row come from
the server totals of the first page (computed over the whole period), never from summing loaded rows. Export run
history, products and audit log are lazy lists too.
