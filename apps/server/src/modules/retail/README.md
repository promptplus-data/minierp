# Module group C: retail

M15 promotions (discount + bundle at the POS), M16 production (BOM / MO), held bills, customer price lists (BR-05),
product images for the POS, POS machines and POS ID (REQ-M01-07). Migration `0300_retail.sql`; demo data `seedRetail`
(`packages/db/src/seedRetail.ts`); pure rules in `packages/core/src/retail.ts`.

## Files

| File | Role |
| --- | --- |
| `promos.ts` | promo CRUD, overlap check, below-cost owner confirmation, close/activate, promo P&L |
| `pricing.ts` | `GET /api/pos/pricing`, price resolution used by `POST /api/pos/sales` (promo, bundle, price list) |
| `held.ts` | held bills (no stock effect) |
| `pricelists.ts` | group / customer price lists with quantity breaks (BR-05) |
| `images.ts` | product photo upload / serve (shop products only, 256 KB, png/jpeg/webp) |
| `devices.ts` | POS machine registry, POS ID and approval date |
| `production.ts` | BOM versions, MO suggest / open / outputs / close / cancel, MO report |

## Routes

Promos: `GET/POST /api/promos`, `POST /api/promos/check`, `GET /api/promos/pnl`, `GET/PATCH /api/promos/:id`,
`POST /api/promos/:id/close|activate`, `GET /api/pos/pricing`.
Held bills: `GET/POST /api/pos/held`, `POST /api/pos/held/:id/resume|discard`.
Price lists: `GET/POST /api/price-lists`, `GET /api/price-lists/resolve`, `GET/PATCH /api/price-lists/:id`.
Images: `GET /api/product-images`, `GET/POST /api/product-images/:productId`, `POST /api/product-images/:productId/remove`.
POS machines: `GET/POST /api/pos-devices`, `PATCH /api/pos-devices/:id`.
Production: `GET/POST /api/boms`, `POST /api/boms/:id/activate`, `GET/POST /api/mos`, `POST /api/mos/suggest`,
`GET /api/mos/report`, `GET /api/mos/:no`, `POST /api/mos/:no/outputs|close|cancel`.

The shared `POST /api/pos/sales` accepts `promoId` on lines and `bundleId` lines. The bundle cuts every component
FIFO and splits the set revenue by BR-17 (`bundleAlloc`).

## Rules to tests

| Rule | Test |
| --- | --- |
| Promo price / state, BR-05 order, MO unit cost (pure) | `packages/core/src/retail.test.ts` |
| Below-cost promo needs the owner (manager gets `BELOW_COST`, manager PIN refused, owner PIN confirms) | `test/retail/promos.test.ts` |
| Overlapping discount promo refused; dates, percent, bundle validation | `promos.test.ts` |
| Bundle sale cuts all components FIFO; revenue pro-rata, remainder on last line (BR-17) | `promos.test.ts` |
| Bundle refused when stock cannot make the set (BR-07), no partial writes | `promos.test.ts` |
| Early close applies at once; issued bills keep their snapshot | `promos.test.ts` |
| Promo P&L; cost hidden without `data.cost`; tenant isolation (BR-14) | `promos.test.ts` |
| Held bills: no stock cut, cap per shift, resume / discard once | `test/retail/pos-extras.test.ts` |
| Price list own > group by qty break > retail; expiry / deactivation | `pos-extras.test.ts` |
| Images: shop products only, type vs bytes, size cap, remove = clear + version bump | `pos-extras.test.ts` |
| POS machines: approval needs POS ID + date; unapproved issues full tax invoice only; audited | `pos-extras.test.ts` |
| BOM versioning, validation, standard cost only with `data.cost` | `test/retail/production.test.ts` |
| MO issues materials FIFO; shortage blocks (BR-07) | `production.test.ts` |
| Good / reject output; close: lot cost = (materials used + labour) / good units; cancel restores original lots | `production.test.ts` |
| Audit of every step (BR-18) | `promos.test.ts`, `production.test.ts` |

e2e: `e2e/retail.spec.ts` (both editions), screenshots `e2e/screenshots/retail-*.png`.

## REQ coverage

| REQ | Status | Notes |
| --- | --- | --- |
| REQ-M15-01 discount promo | done | percent or promo price, date range, overlap check, below-cost owner confirmation |
| REQ-M15-02 bundle promo | done | components + set price, sellable sets from stock |
| REQ-M15-03 POS applies promo | done | promo category, struck-through price, no price approval, receipt shows promo / set |
| REQ-M15-04 close early | done | effect on new bills at once |
| REQ-M15-05 promo profitability | done | `GET /api/promos/pnl` + tab "กำไรต่อโปร" |
| REQ-M16-01 BOM | done | versions, one active |
| REQ-M16-02 open MO and issue | done | BOM x plan suggestion, editable qty, FIFO issue |
| REQ-M16-03 record output | done | repeated good / reject entries, close receives one lot |
| REQ-M16-04 cost vs plan | done | MO report (standard vs actual per unit) |
| REQ-M07-08 hold bill | done | several held bills per shift |
| REQ-M07-11 pick by image / category | done | photo upload, promo category in POS |
| REQ-M01-07 POS ID | done | machine registry; ABB prints POS ID |
| BR-05 price order | partial | list vs retail implemented; quotation price (group A) is outside this module |
| BR-16 / BR-17 | done | see rules table |

## Deferred

- Photo storage is in the database (256 KB cap); object storage is not wired.
- Quotation-price step of BR-05 belongs to group A.

## Cross-cutting: pickers, notes, lazy lists

| REQ | Status | Notes |
| --- | --- | --- |
| Searchable entity pickers | done | Price list customer (`CustomerPicker`) and items (`ProductPicker`); promo targets (picker adds removable chips) and bundle items; BOM product and materials; MO product (server-searched BOM picker) |
| Document note (หมายเหตุ) | done | Promo and price list `note` (create / update, audited diff), MO note shown on the MO paper. Migration `0640_document_notes.sql` |
| Lazy lists | done | Promos, price lists, price list items (20 at a time in the editor), MOs, BOMs, product photos: `LoadMore` |

Tests: `apps/server/test/notes-pickers.test.ts`; e2e `e2e/retail.spec.ts` uses the pickers.
