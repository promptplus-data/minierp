# @erp/core

Pure business rules shared by the cloud and on-premise servers. No I/O, no clock: dates come in as `YYYY-MM-DD` parameters.
Math uses `decimal.js` (round half up). Results are strings: money has 2 dp, quantities and unit costs up to 4 dp.
Logic is ported from `docs/mockup.html`. Only BR-07, BR-16, BR-17 and OQ-10 are cited because those are the rule ids given with the task.

| Module | Export | Rule |
|---|---|---|
| money.ts | `d`, `round2`, `round4`, `sum`, `money`, `qty4`, `fmtTHB` | Money handling |
| vat.ts | `calcDoc`, `lineNet`, `lineGross`, `lineDiscount`, `allocate` | VAT modes (inc / exc / none), bill discount, SCG Family coupon |
| fifo.ts | `takeLots`, `InsufficientStockError` | FIFO issue; BR-07 no negative stock |
| fifo.ts | `movingAverage` | Moving-average cost |
| belowcost.ts | `checkBelowCost`, `netUnitPricesExVat` | BR-16 below-cost guard (owner approval) |
| discount.ts | `discountPct`, `exceedsCap`, `CASHIER_DISC_CAP` | Discount cap, OQ-10 (cashier cap 0) |
| bundle.ts | `bundleAlloc` | BR-17 bundle revenue allocation |
| terms.ts | `dueDate`, `termLabel` | Payment terms (PEAK types) |
| docno.ts | `formatDocNo`, `docPeriodKey`, `DEFAULT_DOC_PATTERN` | Document numbering |
| bahttext.ts | `bahtText` | Printed amount in Thai words |
| payroll.ts | `payRow`, `estTax`, `leaveDays` | HR payroll: SSO 5% capped at 17,500, withholding estimate, leave |
| shift.ts | `shiftExpected`, `shiftDiff` | Shift cash reconciliation |
| perms.ts | `perm`, `ROLE_PERMS`, `OWNER_ONLY`, `approverRoles`, `PERM_KEYS` | Role permissions (mockup `roles` seed) |
| dates.ts | `addDays`, `dayOfWeek`, `parseISODate`, `ymd` | UTC calendar helpers |

Run `npx tsc --noEmit && npx vitest run` in this folder to typecheck and test.
