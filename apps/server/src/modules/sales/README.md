# Module group A: sales (M08 B2B, M09 projects, M10 AR)

Files: `quotes.ts orders.ts deliveries.ts invoices.ts receivables.ts projects.ts pricing.ts common.ts` (server),
`packages/core/src/ar.ts` + project/price-list rules (pure rules), `packages/db/src/seedSales.ts` (demo data),
`apps/web/src/modules/sales/*` (screens), `e2e/sales.spec.ts`.

## Routes
| Area | Routes |
| --- | --- |
| Quotations | `GET/POST /api/sales/quotations`, `GET/PATCH /quotations/:no`, `POST /:no/status`, `POST /:no/void` |
| Orders | `GET/POST /api/sales/orders`, `GET /orders/:no`, `POST /orders/:no/void` |
| Deliveries | `GET/POST /api/sales/deliveries`, `GET /deliveries/:no`, `POST /:no/void`, `GET /delivery-sources` |
| Invoices | `GET/POST /api/sales/invoices`, `GET /invoices/:no`, `POST /invoices/from-abb`, `GET /credit-notes` |
| Pricing / credit | `GET /api/sales/price?doc=quote\|order`, `POST /api/sales/line-check`, price-lists CRUD, `GET /customers/:id/credit`, `GET/PATCH /settings` |
| Pickers | `GET/POST /api/sales/customers/:id/addresses` (ship-to address book), `GET /api/sales/salespeople` |
| Projects | `GET/POST /api/sales/projects`, `GET /:id`, `POST /:id/installments`, `/:id/installments/:iid/bill`, `/:id/deposits`, `/:id/void`; `POST /api/sales/deposits/:no/(forfeit|refund|void)` |
| AR | `GET/POST /api/ar/billing-notes`, `/:no`, `/:no/void`; `GET/POST /api/ar/receipts`, `/:no`, `/:no/void`; `GET /api/ar/aging`, `/due-soon`, `/invoices`, `/statement` |

## Rules to tests (apps/server/test/sales)
| Rule | Test file |
| --- | --- |
| BR-05 price resolution, free-text lines, revisions, expiry | quotes-orders |
| QT → SO → partial DOs (FIFO stock before/after) → INV → BN → RC; price/discount approval with reason; QT below-cost approval carried to SO; line check; address book; notes | b2b-flow |
| BR-08 credit limit / overdue need PIN approval (recorded), BR-16 below cost owner only | quotes-orders |
| BR-07 / BR-21 partial delivery FIFO, over-delivery, last delivery exact remainder | deliveries-invoices |
| BR-22 void downstream first, BR-04 numbers kept on void | quotes-orders, deliveries-invoices, receivables |
| Cash vs credit invoice, ABB to full tax invoice, credit-note refund as credit | deliveries-invoices |
| WHT on pre-VAT base, partial / multi-invoice receipts, aging buckets, statement, BR-14 isolation | receivables |
| Project templates (30/40/30, 50/50, 100), deposits, forfeit, variation order | projects |
| Idempotent demo seed | seed |

Web e2e `e2e/sales-flow.spec.ts`: customer quick-create from the SO form, partial Thai search, stock on the SO line,
below-cost red line + manager (price) and owner (below cost) PINs, cost/profit for the owner, notes, QT → SO → DO → INV with stock cut.

Web e2e (both editions, 1300 and 390 px screenshots `e2e/screenshots/sales-<edition>-*.png`): QT with free-text line to SO,
two partial DOs, one INV; credit approval PIN; billing note + receipt with 3 % WHT; project 50/50 to 30/40/30, deposit,
installment bill, variation order; void blocked by downstream documents.

## REQ coverage
| REQ | Status | Note |
| --- | --- | --- |
| M08-01 quotation, price per BR-05 | done | QT: customer list → group list → B2B promo → retail (same core `resolvePrice` as POS); source + list price stored per line and shown |
| BR-05 / BR-16 price control on QT / SO / direct INV | done | price below the BR-05 price needs `pos.price` or a manager PIN + reason; discount over `pos.discCap` needs the PIN; below cost needs the owner (OWNER_ONLY, as POS); a QT below-cost approval carries to an unchanged SO line; all audited |
| cost / profit on QT / SO | done | per line and document, `data.cost` only (owner / manager / accounting); others see "ต่ำกว่าทุน" only |
| searchable pickers, address book, quick-create customer | done | SearchSelect for customer / product / warehouse / salesperson / ship-to / sale type / DO source / SO to project; `customer_addresses` (RLS) |
| notes on QT, SO, DO, INV, BN, RC, deposit, project | done | `sales_invoices.note` for B2B INV (not `docs`); printed |
| lazy lists | done | B2B tabs, AR tabs, projects, sales docs, unbilled DOs: 20 rows + load more |
| M08-02 QT to SO without re-keying | done | quoted prices carried; QT ↔ SO linked both ways |
| M08-03 credit limit approval | done | PIN, no self-approval via `lib/approval.ts` |
| M08-04 partial delivery | done | |
| M08-05 full tax invoice from deliveries | done | several DOs per invoice; also from an ABB |
| M08-06 returns and credit note | partial | returns screen is the existing POS module; credit-note refund as AR credit added here, list shown in sales |
| M08-07 SCG Family ID and coupons on B2B bills | not done | cloud-only integration (OQ-A2), out of scope with other module integrations |
| M08-08 printable quotation | done | |
| M08-09 free-text lines | done | must be mapped to a product before SO |
| M08-10 SO without quotation, delivery from direct invoice | done | |
| M08-11 order to Prompt Plus | not done | out of scope by instruction |
| M08-12 void with downstream first | done | |
| M09-01 .. M09-08 projects, deposits, installments, forfeit, variation | done | |
| M10-01 billing note | done | printable |
| M10-02 multi-invoice / partial receipt | done | |
| M10-03 WHT 1 / 3 % or amount, 50 ทวิ no. | done | |
| M10-04 aging | done | |
| M10-05 due-soon home card | partial | endpoint plus cards on the AR screen; the shared home page card is not edited (shared file) |
| M10-06 due date by term | done | `dueDate` from core |
