/**
 * API contract for the "sales" module group (Agent A): M08 quotation / sales order / delivery order / B2B tax
 * invoice / credit approval, M10 AR (billing notes, receipts, WHT, aging, statement), M09 projects.
 * Every name is prefixed (Sales*, Ar*) because it is re-exported from '@erp/contracts'.
 * Money and quantities are decimal strings. Lists are cursor paged (NFR-12).
 */
import { z } from 'zod';
import { Approval, Dec, DecNN, DocCoupon, DocCouponIn, Discount, PaymentMethod, SalesDoc, pageQuery, type RouteEditions } from '../core';

const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

// ---------- shared building blocks ----------
/** Payment terms, the 4 PEAK types plus cash (REQ-M03-11). */
export const SalesTerm = z.discriminatedUnion('t', [
  z.object({ t: z.literal('cash') }),
  z.object({ t: z.literal('days'), x: z.number().int().min(0).max(365) }),
  z.object({ t: z.literal('nextDay'), x: z.number().int().min(1).max(31) }),
  z.object({ t: z.literal('eom') }),
  z.object({ t: z.literal('eonm') }),
]);
export type SalesTerm = z.infer<typeof SalesTerm>;
export const SalesVatMode = z.enum(['inc', 'exc', 'none']);
export const SalesLineVat = z.enum(['v7', 'exempt']);
export const SalesTotals = z.object({ gross: Dec, lineDisc: Dec, billDisc: Dec, base7: Dec, exempt: Dec, vat: Dec, total: Dec });
export type SalesTotals = z.infer<typeof SalesTotals>;
export const SalesParty = z.object({ id: z.string().nullable(), code: z.string().nullable(), name: z.string(), taxId: z.string().nullable(), branch: z.string().nullable(), phone: z.string().nullable() });
export type SalesParty = z.infer<typeof SalesParty>;
export const SalesUserRef = z.object({ id: z.string(), name: z.string(), phone: z.string().nullable() });
export const SalesVoided = z.object({ by: z.string(), at: z.string(), reason: z.string() });
export const SalesDocRef = z.object({ no: z.string(), date: z.string(), status: z.enum(['active', 'void']) });
export const SalesPageQuery = pageQuery.extend({ customerId: z.string().optional(), status: z.string().optional() });
export type SalesPageQuery = z.infer<typeof SalesPageQuery>;

// ---------- settings (REQ-M08-08 bank accounts, validity) ----------
export const SalesBankAccount = z.object({ bank: z.string().min(1), branch: z.string().default(''), account: z.string().min(1), name: z.string().min(1) });
export const SalesBelowCostApprover = z.enum(['owner', 'owner_or_manager', 'none']);
export const SalesSettings = z.object({
  quoteValidDays: z.number().int(), defaultCreditLimit: Dec, banks: z.array(SalesBankAccount),
  /** BR-16: who approves a below-cost sale (owner only may change it). */
  belowCostApprover: SalesBelowCostApprover.default('owner'),
  shop: z.object({ name: z.string(), taxId: z.string(), branch: z.string(), address: z.string(), phone: z.string(), vatRegistered: z.boolean(), b2bVatMode: z.enum(['inc', 'exc']) }),
});
export type SalesSettings = z.infer<typeof SalesSettings>;
export const SalesSettingsUpdate = z.object({ quoteValidDays: z.number().int().min(1).max(365).optional(), defaultCreditLimit: DecNN.optional(), banks: z.array(SalesBankAccount).max(6).optional(),
  belowCostApprover: SalesBelowCostApprover.optional() });

// ---------- price (BR-05) and credit (BR-08) helpers ----------
export const SalesPriceQuery = z.object({
  customerId: z.string().optional(), productId: z.string(), unitIdx: z.coerce.number().int().min(0).default(0),
  qty: Dec.default('1'), vatMode: SalesVatMode.optional(), date: ISODate.optional(),
  /** 'quote': BR-05 for a quotation (no quotation step); default 'order' (a valid quotation price comes first). */
  doc: z.enum(['quote', 'order']).default('order'), warehouseId: z.string().optional(),
});
/** Manager PIN for a price below the BR-05 price or a discount over the role cap (pos.discCap); the reason is required. */
export const SalesPriceApproval = Approval.extend({ reason: z.string().min(1).max(300) });
/** Approval recorded on a document. */
export const SalesApprovalNote = z.object({ by: z.string(), detail: z.string() });
/** Cost and profit, only for users with data.cost (owner / manager / accounting). Before VAT. */
export const SalesProfit = z.object({ cost: Dec, revenue: Dec, profit: Dec, marginPct: Dec });

// ---------- customer address book / salespeople (pickers) ----------
export const CustomerAddress = z.object({ id: z.string(), kind: z.enum(['saved', 'customer', 'project']), label: z.string(), address: z.string() });
export type CustomerAddress = z.infer<typeof CustomerAddress>;
export const CustomerAddressReq = z.object({ address: z.string().trim().min(1).max(300), label: z.string().max(80).default('') });
export const SalesPerson = z.object({ id: z.string(), name: z.string(), phone: z.string().nullable(), role: z.string() });
export type SalesPerson = z.infer<typeof SalesPerson>;
export const SalesPriceSource = z.enum(['quote', 'customerList', 'groupList', 'promo', 'retail']);
export type SalesPriceSource = z.infer<typeof SalesPriceSource>;
/** BR-05 price for one line. `unitCost` / `listPrice` per the document's VAT basis; unitCost only for data.cost users. */
export const SalesPrice = z.object({ unitPrice: Dec, source: SalesPriceSource, ref: z.string().nullable(), retailPrice: Dec });
/**
 * POST /api/sales/line-check: live below-cost / profit check of the lines being edited (server is the authority).
 * Everyone gets belowCost per line; unitCost / profit only come back for data.cost users.
 */
export const SalesLineCheckReq = z.object({
  vatMode: SalesVatMode.default('exc'), billDiscount: DecNN.default('0'), warehouseId: z.string().optional(),
  lines: z.array(z.object({ productId: z.string().optional(), unitIdx: z.number().int().min(0).default(0), qty: Dec, unitPrice: DecNN, discount: Discount.optional() })).max(200),
});
export const SalesLineCheck = z.object({
  lines: z.array(z.object({ belowCost: z.boolean(), unitCost: Dec.nullable(), profit: Dec.nullable() })),
  profit: z.object({ cost: Dec, revenue: Dec, profit: Dec, marginPct: Dec }).nullable(),
});
export type SalesLineCheck = z.infer<typeof SalesLineCheck>;
export type SalesPrice = z.infer<typeof SalesPrice>;

// ---------- price lists (BR-05 steps 2 and 3) ----------
export const SalesPriceListItem = z.object({ productId: z.string(), unitIdx: z.number().int().min(0).default(0), minQty: DecNN.default('0'), price: DecNN });
export const SalesPriceListReq = z.object({
  code: z.string().max(30).optional(), name: z.string().min(1).max(120), kind: z.enum(['customer', 'group']),
  customerId: z.string().optional(), group: z.enum(['retail', 'whole', 'contr']).optional(), vatIncluded: z.boolean().default(true),
  validFrom: ISODate.nullable().optional(), validTo: ISODate.nullable().optional(), active: z.boolean().default(true),
  items: z.array(SalesPriceListItem).max(500),
});
export type SalesPriceListReq = z.infer<typeof SalesPriceListReq>;
export const SalesPriceList = z.object({
  id: z.string(), code: z.string(), name: z.string(), kind: z.enum(['customer', 'group']), customer: z.object({ id: z.string(), name: z.string() }).nullable(),
  group: z.enum(['retail', 'whole', 'contr']).nullable(), vatIncluded: z.boolean(), validFrom: z.string().nullable(), validTo: z.string().nullable(), active: z.boolean(),
  items: z.array(SalesPriceListItem.extend({ sku: z.string(), name: z.string(), unitName: z.string() })), updatedAt: z.string(),
});
export type SalesPriceList = z.infer<typeof SalesPriceList>;
export const SalesPriceListSummary = SalesPriceList.omit({ items: true }).extend({ itemCount: z.number().int() });
export type SalesPriceListSummary = z.infer<typeof SalesPriceListSummary>;
export const SalesCustomerCredit = z.object({
  customerId: z.string(), term: SalesTerm, limit: Dec, balance: Dec, available: Dec.nullable(),
  overdue: z.array(z.object({ no: z.string(), dueDate: z.string(), balance: Dec, days: z.number().int() })),
});
export type SalesCustomerCredit = z.infer<typeof SalesCustomerCredit>;

// ---------- lines ----------
/** A document line. Quotations may omit productId and type name / unit / vat instead (free text, REQ-M08-09). */
export const SalesLineIn = z.object({
  productId: z.string().optional(), unitIdx: z.number().int().min(0).default(0),
  name: z.string().max(300).optional(), unitName: z.string().max(40).optional(), vat: SalesLineVat.optional(),
  qty: Dec, unitPrice: DecNN, discount: Discount.optional(),
});
export type SalesLineIn = z.infer<typeof SalesLineIn>;
export const SalesLine = z.object({
  id: z.string(), lineNo: z.number().int(), productId: z.string().nullable(), unitIdx: z.number().int().nullable(), sku: z.string().nullable(),
  name: z.string(), unitName: z.string(), qty: Dec, unitPrice: Dec, discount: Discount.nullable(), discAmt: Dec, net: Dec, vat: SalesLineVat, free: z.boolean(),
  /** BR-05 price when saved (document VAT basis) and where it came from. */
  listPrice: Dec.nullable().default(null), priceSource: z.string().nullable().default(null), priceRef: z.string().nullable().default(null),
  /** FIFO unit cost per line unit and the line profit before VAT: data.cost users only (null otherwise). */
  unitCost: Dec.nullable().default(null), profit: Dec.nullable().default(null),
});
export type SalesLine = z.infer<typeof SalesLine>;

// ---------- quotations (REQ-M08-01/08/09) ----------
export const SalesQuoteStatus = z.enum(['draft', 'sent', 'accepted', 'lost', 'expired', 'void']);
export type SalesQuoteStatus = z.infer<typeof SalesQuoteStatus>;
export const SalesQuoteReq = z.object({
  customerId: z.string(), date: ISODate.optional(), validUntil: ISODate.optional(), attn: z.string().max(200).default(''),
  vatMode: SalesVatMode.optional(), term: SalesTerm.optional(), salespersonId: z.string().optional(), note: z.string().max(1000).default(''),
  billDiscount: DecNN.default('0'), lines: z.array(SalesLineIn).min(1).max(200), status: z.enum(['draft', 'sent']).default('draft'),
  belowCostApproval: Approval.optional(), priceApproval: SalesPriceApproval.optional(),
});
export type SalesQuoteReq = z.infer<typeof SalesQuoteReq>;
export const SalesQuoteStatusReq = z.object({ status: z.enum(['draft', 'sent', 'accepted', 'lost']) });
export const SalesQuote = z.object({
  id: z.string(), no: z.string(), date: z.string(), validUntil: z.string(), customer: SalesParty, attn: z.string(), vatMode: SalesVatMode, term: SalesTerm,
  salesperson: SalesUserRef.nullable(), note: z.string(), billDiscount: Dec, lines: z.array(SalesLine), totals: SalesTotals,
  status: SalesQuoteStatus, revision: z.number().int(), orders: z.array(SalesDocRef), editable: z.boolean(),
  belowCostApproval: SalesApprovalNote.nullable().default(null), priceApproval: SalesApprovalNote.nullable().default(null), profit: SalesProfit.nullable().default(null),
  createdBy: z.string(), voided: SalesVoided.nullable(),
  /** Purchase orders (ใบสั่งซื้อ) made from this document; status open / partial / received / closed / void. */
  purchaseOrders: z.array(z.object({ no: z.string(), status: z.string() })).default([]),
});
export type SalesQuote = z.infer<typeof SalesQuote>;
export const SalesQuoteSummary = z.object({
  id: z.string(), no: z.string(), date: z.string(), validUntil: z.string(), customer: z.object({ id: z.string(), name: z.string() }),
  total: Dec, status: SalesQuoteStatus, revision: z.number().int(), freeLines: z.number().int(), createdBy: z.string(),
});
export type SalesQuoteSummary = z.infer<typeof SalesQuoteSummary>;

// ---------- sales orders (REQ-M08-02/03/10, BR-08, BR-16, BR-23) ----------
export const SalesOrderLineIn = z.object({
  productId: z.string(), unitIdx: z.number().int().min(0).default(0), qty: Dec, unitPrice: DecNN, discount: Discount.optional(),
  /** The quotation line this order line comes from (free-text lines are mapped to productId here). */
  quoteLineId: z.string().optional(),
});
export type SalesOrderLineIn = z.infer<typeof SalesOrderLineIn>;
export const SalesInstallmentIn = z.object({ pct: DecNN, label: z.string().max(120).default(''), dueDate: ISODate.optional() });
export const SalesProjectTemplate = z.enum(['30/40/30', '50/50', '100%', 'custom']);
export const SalesNewProject = z.object({
  name: z.string().min(1).max(200), site: z.string().max(300).default(''), contact: z.string().max(200).default(''),
  template: SalesProjectTemplate.default('30/40/30'), installments: z.array(SalesInstallmentIn).min(1).max(24).optional(), startDate: ISODate.optional(),
  note: z.string().max(1000).default(''),
});
export const SalesOrderReq = z.object({
  customerId: z.string(), quoteNo: z.string().optional(), date: ISODate.optional(), vatMode: SalesVatMode.optional(), term: SalesTerm.optional(),
  salespersonId: z.string().optional(), warehouseId: z.string().optional(), shipTo: z.string().max(300).default(''), note: z.string().max(1000).default(''),
  billDiscount: DecNN.default('0'), lines: z.array(SalesOrderLineIn).min(1).max(200),
  project: z.discriminatedUnion('mode', [SalesNewProject.extend({ mode: z.literal('new') }), z.object({ mode: z.literal('existing'), projectId: z.string() })]).optional(),
  creditApproval: Approval.optional(),   // BR-08: over the credit limit or overdue bills
  belowCostApproval: Approval.optional(), // BR-16: owner only
  priceApproval: SalesPriceApproval.optional(), // price below BR-05 / discount over the role cap
  coupon: DocCouponIn.optional(), // member coupon (cloud only); value recomputed by the server
});
export type SalesOrderReq = z.infer<typeof SalesOrderReq>;
export const SalesDlvStatus = z.enum(['open', 'partial', 'delivered']);
export const SalesOrderLine = SalesLine.extend({ productId: z.string(), unitIdx: z.number().int(), baseQty: Dec, netAfterBill: Dec, deliveredQty: Dec, remainingQty: Dec, quoteLineId: z.string().nullable() });
export const SalesOrder = z.object({
  id: z.string(), no: z.string(), date: z.string(), customer: SalesParty, quoteNo: z.string().nullable(),
  project: z.object({ id: z.string(), no: z.string(), name: z.string(), isMain: z.boolean() }).nullable(),
  warehouseId: z.string().nullable(), vatMode: SalesVatMode, term: SalesTerm, salesperson: SalesUserRef.nullable(), shipTo: z.string(), note: z.string(),
  billDiscount: Dec, lines: z.array(SalesOrderLine), totals: SalesTotals, dlvStatus: SalesDlvStatus, status: z.enum(['active', 'void']),
  creditApproval: z.object({ by: z.string(), detail: z.string() }).nullable(), belowCostApproval: z.object({ by: z.string(), detail: z.string() }).nullable(),
  deliveries: z.array(SalesDocRef.extend({ invoiceNo: z.string().nullable() })), invoices: z.array(SalesDocRef),
  priceApproval: SalesApprovalNote.nullable().default(null), profit: SalesProfit.nullable().default(null),
  createdBy: z.string(), voided: SalesVoided.nullable(),
  /** Purchase orders (ใบสั่งซื้อ) made from this document; status open / partial / received / closed / void. */
  purchaseOrders: z.array(z.object({ no: z.string(), status: z.string() })).default([]),
  coupon: DocCoupon.nullable().optional(), // member coupon (cloud only); totals.total is after it
});
export type SalesOrder = z.infer<typeof SalesOrder>;
export const SalesOrderSummary = z.object({
  id: z.string(), no: z.string(), date: z.string(), customer: z.object({ id: z.string(), name: z.string() }), total: Dec, dlvStatus: SalesDlvStatus,
  status: z.enum(['active', 'void']), quoteNo: z.string().nullable(), projectName: z.string().nullable(), itemsPreview: z.string(), createdBy: z.string(),
});
export type SalesOrderSummary = z.infer<typeof SalesOrderSummary>;

// ---------- delivery orders (REQ-M08-04/10, M09-02) ----------
export const SalesDeliveryReq = z.object({
  soNo: z.string().optional(), invoiceNo: z.string().optional(), date: ISODate.optional(), warehouseId: z.string().optional(),
  shipTo: z.string().max(300).default(''), vehicle: z.string().max(120).default(''), note: z.string().max(500).default(''),
  /** srcLineId = sales order line id or invoice line id; qty in that line's unit. */
  lines: z.array(z.object({ srcLineId: z.string(), qty: Dec })).min(1).max(200),
}).refine((x) => !!x.soNo !== !!x.invoiceNo, { message: 'give exactly one of soNo / invoiceNo' });
export type SalesDeliveryReq = z.infer<typeof SalesDeliveryReq>;
export const SalesDelivery = z.object({
  id: z.string(), no: z.string(), date: z.string(), customer: SalesParty, soNo: z.string().nullable(), invoiceNo: z.string().nullable(),
  project: z.object({ id: z.string(), no: z.string(), name: z.string(), site: z.string() }).nullable(),
  warehouse: z.object({ id: z.string(), name: z.string() }).nullable(), cutsStock: z.boolean(), shipTo: z.string(), vehicle: z.string(), note: z.string(),
  lines: z.array(z.object({ id: z.string(), productId: z.string(), name: z.string(), unitName: z.string(), qty: Dec, unitPrice: Dec, value: Dec, cogs: Dec.nullable() })),
  total: Dec, invoiceNos: z.array(z.string()), status: z.enum(['active', 'void']), createdBy: z.string(), voided: SalesVoided.nullable(),
});
export type SalesDelivery = z.infer<typeof SalesDelivery>;
export const SalesDeliverySummary = z.object({
  id: z.string(), no: z.string(), date: z.string(), customer: z.object({ id: z.string().nullable(), name: z.string() }), soNo: z.string().nullable(),
  invoiceNo: z.string().nullable(), billedBy: z.string().nullable(), projectName: z.string().nullable(), total: Dec, status: z.enum(['active', 'void']), itemsPreview: z.string(),
  /** From a cash sales order (ขายเงินสด): its invoice is paid on the spot. */
  cashSale: z.boolean().default(false),
});
export type SalesDeliverySummary = z.infer<typeof SalesDeliverySummary>;
/** GET /api/sales/delivery-sources: sales orders and goods-left invoices that still have something to deliver. */
export const SalesDeliverySource = z.object({
  kind: z.enum(['SO', 'INV']), no: z.string(), date: z.string(), customer: z.object({ id: z.string().nullable(), name: z.string() }), shipTo: z.string(),
  project: z.object({ id: z.string(), name: z.string(), site: z.string() }).nullable(), warehouseId: z.string().nullable(),
  lines: z.array(z.object({ id: z.string(), productId: z.string(), name: z.string(), unitName: z.string(), qty: Dec, delivered: Dec, remaining: Dec })),
});
export type SalesDeliverySource = z.infer<typeof SalesDeliverySource>;

// ---------- B2B tax invoices (REQ-M08-05, M08-10) ----------
const InvoiceCommon = {
  date: ISODate.optional(), attn: z.string().max(200).default(''), note: z.string().max(1000).default(''),
  /** Present and summing to the total = cash sale (paid now). Absent / empty = credit sale (receivable). */
  payments: z.array(z.object({ method: PaymentMethod, amount: DecNN })).max(6).optional(),
  /** Paid now in full by this method (cash / transfer / QR พร้อมเพย์ / card); required for a cash sales order. */
  payMethod: PaymentMethod.optional(),
  creditApproval: Approval.optional(),
};
export const SalesInvoiceReq = z.discriminatedUnion('source', [
  z.object({ source: z.literal('delivery'), deliveryNos: z.array(z.string()).min(1).max(50), ...InvoiceCommon }),
  z.object({
    source: z.literal('direct'), customerId: z.string(), vatMode: SalesVatMode.optional(), term: SalesTerm.optional(), salespersonId: z.string().optional(),
    warehouseId: z.string(), lines: z.array(SalesOrderLineIn.omit({ quoteLineId: true })).min(1).max(200), billDiscount: DecNN.default('0'),
    /** The customer leaves the goods at the shop: stock is cut now, the goods go out later on a delivery order. */
    goodsLeft: z.boolean().default(false), belowCostApproval: Approval.optional(), priceApproval: SalesPriceApproval.optional(), ...InvoiceCommon,
  }),
]);
export type SalesInvoiceReq = z.infer<typeof SalesInvoiceReq>;
export const SalesInvoiceSource = z.enum(['delivery', 'direct', 'installment', 'deposit', 'forfeit', 'abb', 'pos']);
/** A full tax invoice issued later for a POS abbreviated invoice: the ABB is voided and the INV refers to it (BR-03). */
export const SalesAbbInvoiceReq = z.object({ abbNo: z.string().min(1), customerId: z.string() });
export const SalesInvoice = z.object({
  doc: SalesDoc, customer: SalesParty, kind: z.enum(['credit', 'cash']), source: SalesInvoiceSource, term: SalesTerm, dueDate: z.string(),
  arBalance: Dec, settled: Dec, credited: Dec, goodsLeft: z.boolean(), soNo: z.string().nullable(),
  project: z.object({ id: z.string(), no: z.string(), name: z.string() }).nullable(),
  installment: z.object({ n: z.number().int(), label: z.string(), pct: Dec }).nullable(),
  grossAmount: Dec.nullable(), depositDeduct: Dec, depositType: z.enum(['guarantee', 'advance']).nullable(),
  textLines: z.array(z.object({ name: z.string(), amount: Dec })), attn: z.string(), note: z.string(), salesperson: SalesUserRef.nullable(),
  deliveries: z.array(z.string()), laterDeliveries: z.array(SalesDocRef), billingNotes: z.array(SalesDocRef),
  receipts: z.array(SalesDocRef.extend({ settled: Dec, wht: Dec })), creditNotes: z.array(SalesDocRef.extend({ total: Dec, refund: z.string().nullable() })),
  /** goods-left invoices: quantity still at the shop per invoice line id. */
  undelivered: z.record(Dec),
});
export type SalesInvoice = z.infer<typeof SalesInvoice>;
export const SalesInvoiceSummary = z.object({
  id: z.string(), no: z.string(), date: z.string(), customer: z.object({ id: z.string().nullable(), name: z.string() }), total: Dec, arBalance: Dec,
  kind: z.enum(['credit', 'cash']), source: SalesInvoiceSource, dueDate: z.string(), overdueDays: z.number().int(), status: z.enum(['active', 'void']), projectName: z.string().nullable(),
});
export type SalesInvoiceSummary = z.infer<typeof SalesInvoiceSummary>;
export const SalesCreditNoteSummary = z.object({
  id: z.string(), no: z.string(), date: z.string(), customer: z.object({ id: z.string().nullable(), name: z.string() }), total: Dec, vat: Dec,
  refNo: z.string().nullable(), refund: z.string().nullable(), reason: z.string().nullable(), status: z.enum(['active', 'void']),
});
export type SalesCreditNoteSummary = z.infer<typeof SalesCreditNoteSummary>;

// ---------- projects (M09) ----------
export const SalesProjectReq = SalesNewProject.extend({ soNo: z.string() });
/** Edit a project's header (name, site, contact, note). Money, orders and installments change through their own actions. */
export const SalesProjectEditReq = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  site: z.string().max(500).optional(),
  contact: z.string().max(200).optional(),
  note: z.string().max(2000).optional(),
}).refine((x) => Object.values(x).some((v) => v !== undefined), { message: 'Nothing to change' });
export type SalesProjectEditReq = z.infer<typeof SalesProjectEditReq>;
export const SalesInstallmentsReq = z.object({ rows: z.array(SalesInstallmentIn.extend({ id: z.string().optional(), dueDate: ISODate })).min(1).max(24) });
export const SalesDepositType = z.enum(['guarantee', 'advance']);
export const SalesDepositReq = z.object({ type: SalesDepositType, amount: DecNN, method: PaymentMethod, date: ISODate.optional(), note: z.string().max(500).default('') });
export const SalesDepositActionReq = z.object({ method: PaymentMethod.optional(), approval: Approval.optional(), reason: z.string().max(300).default('') });
export const SalesInstallment = z.object({
  id: z.string(), n: z.number().int(), label: z.string(), pct: Dec, dueDate: z.string(), status: z.enum(['open', 'billed']),
  invoiceNo: z.string().nullable(), gross: Dec, deduct: Dec, net: Dec,
});
export const SalesDeposit = z.object({
  id: z.string(), no: z.string(), date: z.string(), type: SalesDepositType, amount: Dec, method: z.string(), applied: Dec, remaining: Dec,
  status: z.enum(['active', 'forfeited', 'refunded', 'void']), invoiceNo: z.string().nullable(), forfeitNo: z.string().nullable(),
  refund: z.object({ amount: Dec, method: z.string(), date: z.string(), by: z.string() }).nullable(), note: z.string().default(''),
});
export type SalesDeposit = z.infer<typeof SalesDeposit>;
export const SalesProjectFigures = z.object({ value: Dec, delivered: Dec, billed: Dec, collected: Dec, outstanding: Dec, unbilled: Dec });
export const SalesProject = z.object({
  id: z.string(), no: z.string(), name: z.string(), customer: SalesParty, site: z.string(), contact: z.string(), template: z.string(), note: z.string().default(''),
  status: z.enum(['active', 'void']), mainSoNo: z.string().nullable(), figures: SalesProjectFigures,
  orders: z.array(SalesDocRef.extend({ total: Dec, dlvStatus: SalesDlvStatus, isMain: z.boolean() })),
  installments: z.array(SalesInstallment), deposits: z.array(SalesDeposit),
  deliveries: z.array(SalesDocRef.extend({ soNo: z.string().nullable(), total: Dec, itemsPreview: z.string(), vehicle: z.string() })),
  invoices: z.array(SalesDocRef.extend({ total: Dec, arBalance: Dec, source: SalesInvoiceSource })),
  createdBy: z.string(), createdAt: z.string(), voided: SalesVoided.nullable(),
});
export type SalesProject = z.infer<typeof SalesProject>;
export const SalesProjectSummary = z.object({
  id: z.string(), no: z.string(), name: z.string(), customer: z.object({ id: z.string(), name: z.string() }), site: z.string(),
  status: z.enum(['active', 'void']), figures: SalesProjectFigures, createdAt: z.string(),
});
export type SalesProjectSummary = z.infer<typeof SalesProjectSummary>;

// ---------- AR (M10) ----------
export const ArBucket = z.enum(['notDue', 'd1_30', 'd31_60', 'd61_90', 'over90']);
export const ArBuckets = z.object({ notDue: Dec, d1_30: Dec, d31_60: Dec, d61_90: Dec, over90: Dec });
export const ArAgingQuery = pageQuery.extend({ asOf: ISODate.optional() });
export const ArAgingRow = z.object({
  customer: z.object({ id: z.string(), code: z.string(), name: z.string() }), term: SalesTerm, limit: Dec, balance: Dec, buckets: ArBuckets, invoices: z.number().int(), overdue: z.number().int(),
});
export const ArAging = z.object({ asOf: z.string(), totals: ArBuckets.extend({ total: Dec }), items: z.array(ArAgingRow), nextCursor: z.string().nullable() });
export type ArAging = z.infer<typeof ArAging>;
export const ArInvoicesQuery = pageQuery.extend({
  customerId: z.string().optional(), bucket: ArBucket.optional(), asOf: ISODate.optional(),
  /** true: only invoices not in an active billing note (picker for a new billing note). */
  unbilled: z.coerce.boolean().optional(),
});
export const ArOpenInvoice = z.object({
  id: z.string(), no: z.string(), date: z.string(), dueDate: z.string(), customer: z.object({ id: z.string(), name: z.string() }),
  total: Dec, vat: Dec, arBalance: Dec, overdueDays: z.number().int(), bucket: ArBucket, billingNoteNo: z.string().nullable(), projectName: z.string().nullable(),
});
export type ArOpenInvoice = z.infer<typeof ArOpenInvoice>;
export const ArDueSoon = z.object({
  asOf: z.string(), days: z.number().int(),
  dueSoon: z.object({ customers: z.number().int(), invoices: z.number().int(), amount: Dec }),
  overdue: z.object({ customers: z.number().int(), invoices: z.number().int(), amount: Dec }),
});
export const ArStatementQuery = z.object({ customerId: z.string(), from: ISODate.optional(), to: ISODate.optional() });
export const ArStatement = z.object({
  customer: SalesParty, from: z.string(), to: z.string(), opening: Dec, closing: Dec,
  lines: z.array(z.object({ date: z.string(), no: z.string(), kind: z.enum(['INV', 'CN', 'RC', 'WHT', 'VOID']), ref: z.string().nullable(), debit: Dec, credit: Dec, balance: Dec, note: z.string() })),
  open: z.array(ArOpenInvoice),
});
export type ArStatement = z.infer<typeof ArStatement>;

export const ArBillingNoteReq = z.object({ customerId: z.string(), invoiceNos: z.array(z.string()).min(1).max(100), date: ISODate.optional(), collectDate: ISODate.optional(), note: z.string().max(500).default('') });
export const ArBillingNote = z.object({
  id: z.string(), no: z.string(), date: z.string(), customer: SalesParty, collectDate: z.string().nullable(), note: z.string(),
  lines: z.array(z.object({ invoiceNo: z.string(), invoiceDate: z.string(), dueDate: z.string(), invoiceTotal: Dec, amount: Dec })),
  total: Dec, status: z.enum(['active', 'void']), createdBy: z.string(), voided: SalesVoided.nullable(),
});
export type ArBillingNote = z.infer<typeof ArBillingNote>;
export const ArBillingNoteSummary = z.object({
  id: z.string(), no: z.string(), date: z.string(), customer: z.object({ id: z.string(), name: z.string() }), collectDate: z.string().nullable(),
  total: Dec, count: z.number().int(), status: z.enum(['active', 'void']),
});
export type ArBillingNoteSummary = z.infer<typeof ArBillingNoteSummary>;

export const ArReceiptMethod = z.enum(['cash', 'transfer', 'cheque', 'promptpay', 'card']);
export const ArWht = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('rate'), rate: z.enum(['1', '3']) }),
  z.object({ mode: z.literal('amount'), amount: DecNN }),
]);
export const ArReceiptReq = z.object({
  customerId: z.string(), date: ISODate.optional(), method: ArReceiptMethod,
  cheque: z.object({ no: z.string().min(1), bank: z.string().min(1), date: ISODate }).optional(),
  /** amount = what this receipt cuts from the invoice's balance (cash + WHT share). */
  lines: z.array(z.object({ invoiceNo: z.string(), amount: DecNN })).min(1).max(100),
  wht: ArWht.default({ mode: 'none' }), whtCertNo: z.string().max(40).optional(), note: z.string().max(500).default(''),
});
export type ArReceiptReq = z.infer<typeof ArReceiptReq>;
export const ArReceipt = z.object({
  id: z.string(), no: z.string(), date: z.string(), customer: SalesParty, method: ArReceiptMethod,
  cheque: z.object({ no: z.string(), bank: z.string(), date: z.string() }).nullable(),
  lines: z.array(z.object({ invoiceNo: z.string(), invoiceDate: z.string(), invoiceTotal: Dec, settled: Dec, whtBase: Dec, wht: Dec })),
  settled: Dec, whtRate: Dec.nullable(), wht: Dec, whtCertNo: z.string().nullable(), cash: Dec, note: z.string(),
  status: z.enum(['active', 'void']), createdBy: z.string(), voided: SalesVoided.nullable(),
});
export type ArReceipt = z.infer<typeof ArReceipt>;
export const ArReceiptSummary = z.object({
  id: z.string(), no: z.string(), date: z.string(), customer: z.object({ id: z.string(), name: z.string() }), method: ArReceiptMethod,
  settled: Dec, wht: Dec, cash: Dec, invoices: z.string(), status: z.enum(['active', 'void']),
});
export type ArReceiptSummary = z.infer<typeof ArReceiptSummary>;

export const salesRoutes = {
  salesSettings: 'GET /api/sales/settings', salesSettingsUpdate: 'PATCH /api/sales/settings',
  salesPrice: 'GET /api/sales/price', salesCustomerCredit: 'GET /api/sales/customers/:id/credit',
  salesCustomerAddresses: 'GET /api/sales/customers/:id/addresses', salesCustomerAddressCreate: 'POST /api/sales/customers/:id/addresses',
  salesPeople: 'GET /api/sales/salespeople', salesLineCheck: 'POST /api/sales/line-check',
  salesQuotes: 'GET /api/sales/quotations', salesQuoteCreate: 'POST /api/sales/quotations', salesQuote: 'GET /api/sales/quotations/:no',
  salesQuoteUpdate: 'PATCH /api/sales/quotations/:no', salesQuoteStatus: 'POST /api/sales/quotations/:no/status', salesQuoteVoid: 'POST /api/sales/quotations/:no/void',
  salesOrders: 'GET /api/sales/orders', salesOrderCreate: 'POST /api/sales/orders', salesOrder: 'GET /api/sales/orders/:no', salesOrderVoid: 'POST /api/sales/orders/:no/void',
  salesDeliveries: 'GET /api/sales/deliveries', salesDeliveryCreate: 'POST /api/sales/deliveries', salesDelivery: 'GET /api/sales/deliveries/:no',
  salesDeliveryVoid: 'POST /api/sales/deliveries/:no/void', salesDeliverySources: 'GET /api/sales/delivery-sources',
  salesInvoices: 'GET /api/sales/invoices', salesInvoiceCreate: 'POST /api/sales/invoices', salesInvoice: 'GET /api/sales/invoices/:no',
  salesCreditNotes: 'GET /api/sales/credit-notes', salesInvoiceFromAbb: 'POST /api/sales/invoices/from-abb',
  salesPriceLists: 'GET /api/sales/price-lists', salesPriceListCreate: 'POST /api/sales/price-lists', salesPriceList: 'GET /api/sales/price-lists/:id',
  salesPriceListUpdate: 'PATCH /api/sales/price-lists/:id',
  salesProjects: 'GET /api/sales/projects', salesProjectCreate: 'POST /api/sales/projects', salesProject: 'GET /api/sales/projects/:id',
  salesProjectInstallments: 'POST /api/sales/projects/:id/installments', salesProjectBill: 'POST /api/sales/projects/:id/installments/:installmentId/bill',
  salesProjectDeposit: 'POST /api/sales/projects/:id/deposits', salesProjectVoid: 'POST /api/sales/projects/:id/void',
  salesDepositForfeit: 'POST /api/sales/deposits/:no/forfeit', salesDepositRefund: 'POST /api/sales/deposits/:no/refund', salesDepositVoid: 'POST /api/sales/deposits/:no/void',
  arAging: 'GET /api/ar/aging', arInvoices: 'GET /api/ar/invoices', arDueSoon: 'GET /api/ar/due-soon', arStatement: 'GET /api/ar/statement',
  arBillingNotes: 'GET /api/ar/billing-notes', arBillingNoteCreate: 'POST /api/ar/billing-notes', arBillingNote: 'GET /api/ar/billing-notes/:no', arBillingNoteVoid: 'POST /api/ar/billing-notes/:no/void',
  arReceipts: 'GET /api/ar/receipts', arReceiptCreate: 'POST /api/ar/receipts', arReceipt: 'GET /api/ar/receipts/:no', arReceiptVoid: 'POST /api/ar/receipts/:no/void',
} as const;

/** Routes registered on one edition only. Everything here exists on both editions (BR-24). */
export const salesRouteEditions: RouteEditions<typeof salesRoutes> = {};
