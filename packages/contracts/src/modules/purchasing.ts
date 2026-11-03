/**
 * API contract for the "purchasing" module group (Agent B): M18 AP (bills, payment vouchers, vendor returns),
 * M04 Import Hub, stock count / ledger / reorder, M05 GR-overdue alert (BR-10), M19-08 delivery-file import
 * ("นำเข้าไฟล์ใบส่งของ", both editions). Money and quantities are decimal strings.
 */
import { z } from 'zod';
import { Dec, DecNN, pageQuery, type RouteEditions } from '../core';

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
/** Query-string boolean: only 'true' / '1' are true (z.coerce.boolean would turn 'false' into true). */
const QBool = z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]).transform((v) => v === true || v === 'true' || v === '1');

// ---------- settings (BR-19) ----------
export const PurchasingSettings = z.object({ billDiscountMode: z.enum(['sep', 'alloc']) });
export type PurchasingSettings = z.infer<typeof PurchasingSettings>;

// ---------- GR overdue alert (BR-10) and dashboard ----------
export const GrAlert = z.object({
  days: z.number().int(), count: z.number().int(),
  items: z.array(z.object({ id: z.string(), dnNo: z.string().nullable(), dealer: z.string().nullable(), receivedOn: Ymd, ageDays: z.number().int() })),
});
export type GrAlert = z.infer<typeof GrAlert>;

export const PurchasingDashboard = z.object({
  draftCount: z.number().int(), overdueDrafts: z.number().int(),
  belowReorder: z.number().int(),
  apDue7: z.object({ count: z.number().int(), amount: Dec }),
  apOverdue: z.object({ count: z.number().int(), amount: Dec }),
});

// ---------- goods receipts (confirmed) ----------
export const GrSummary = z.object({
  id: z.string(), no: z.string(), date: Ymd, vendorId: z.string().nullable(), vendorName: z.string().nullable(),
  vendorInvoiceNo: z.string().nullable(), deliveryNo: z.string().nullable(), warehouseId: z.string(), total: Dec.nullable(),
  apBillNo: z.string().nullable(), itemsPreview: z.string(), createdBy: z.string(), returnable: z.boolean(),
});
export type GrSummary = z.infer<typeof GrSummary>;
export const GrLineView = z.object({
  id: z.string(), lineNo: z.number().int(), productId: z.string(), name: z.string(), warehouseId: z.string(),
  unitIdx: z.number().int(), unitName: z.string(), unitFactor: Dec, qty: Dec, returnedQty: Dec, unitPrice: Dec.nullable(), amount: Dec.nullable(),
});
export const GrDetail = GrSummary.extend({ lines: z.array(GrLineView), billDiscount: Dec.nullable() });
export type GrDetail = z.infer<typeof GrDetail>;
export const GrListQuery = pageQuery.extend({ returnable: QBool.optional() });

// ---------- AP (M18) ----------
export const ApBill = z.object({
  id: z.string(), no: z.string(), source: z.enum(['gr', 'opening']), vendorId: z.string(), vendorName: z.string(),
  vendorInvoiceNo: z.string(), grNo: z.string().nullable(), date: Ymd, dueDate: Ymd, termLabel: z.string(),
  base: Dec, discount: Dec, discountMode: z.enum(['sep', 'alloc']), vat: Dec, total: Dec, paid: Dec, returned: Dec, balance: Dec,
  overdueDays: z.number().int(), createdBy: z.string(),
});
export type ApBill = z.infer<typeof ApBill>;
export const ApBillQuery = pageQuery.extend({ vendorId: z.string().optional(), status: z.enum(['open', 'all']).default('all') });
export const ApAging = z.object({
  asOf: Ymd,
  buckets: z.object({ current: Dec, d1_30: Dec, d31_60: Dec, over60: Dec }),
  total: Dec,
  dueSoon: z.object({ days: z.number().int(), count: z.number().int(), amount: Dec }),
  vendors: z.array(z.object({ vendorId: z.string(), vendorName: z.string(), balance: Dec, bills: z.number().int() })),
  purchaseDiscountMonth: Dec,
});
export type ApAging = z.infer<typeof ApAging>;

export const ApPaymentMethod = z.enum(['transfer', 'cheque', 'cash']);
export const ApPaymentReq = z.object({
  vendorId: z.string(), method: ApPaymentMethod, ref: z.string().optional(), whtRate: z.union([z.literal(0), z.literal(1), z.literal(3)]).default(0),
  allocations: z.array(z.object({ billId: z.string(), amount: DecNN })).min(1), note: z.string().optional(),
});
export const ApPayment = z.object({
  id: z.string(), no: z.string(), date: Ymd, vendorId: z.string(), vendorName: z.string(), method: ApPaymentMethod, ref: z.string().nullable(),
  amount: Dec, whtRate: Dec, wht: Dec, net: Dec, note: z.string().nullable(), createdBy: z.string(),
  bills: z.array(z.object({ billId: z.string(), billNo: z.string(), vendorInvoiceNo: z.string(), amount: Dec })),
});
export type ApPayment = z.infer<typeof ApPayment>;

export const VendorReturnReq = z.object({
  grNo: z.string(), lines: z.array(z.object({ grLineId: z.string(), qty: DecNN })).min(1),
  reason: z.string().min(1), vendorCnNo: z.string().optional(),
});
export const VendorReturn = z.object({
  id: z.string(), no: z.string(), date: Ymd, vendorId: z.string(), vendorName: z.string(), grNo: z.string(), apBillNo: z.string().nullable(),
  reason: z.string(), vendorCnNo: z.string().nullable(), base: Dec, vat: Dec, total: Dec, apApplied: Dec, unapplied: Dec, cogs: Dec.nullable(), createdBy: z.string(),
  lines: z.array(z.object({ productId: z.string(), name: z.string(), unitName: z.string(), qty: Dec, unitPrice: Dec, amount: Dec })),
});
export type VendorReturn = z.infer<typeof VendorReturn>;
export const PurchaseDiscount = z.object({ billNo: z.string(), grNo: z.string().nullable(), date: Ymd, vendorName: z.string(), amount: Dec, createdBy: z.string() });

// ---------- file imports (shared) ----------
/** File upload in JSON: base64 of the raw bytes (CSV or XLSX), ≤ 10 MB. */
export const ImportFile = z.object({
  fileName: z.string().min(1), contentBase64: z.string().min(1),
  encoding: z.enum(['auto', 'utf8', 'tis620']).default('auto'),
});
export const RowStatus = z.enum(['ok', 'warn', 'error', 'exists']);
export type RowStatus = z.infer<typeof RowStatus>;

// ---------- delivery-file import (M19-08) ----------
export const DELIVERY_FIELDS = ['product_code', 'product_name', 'qty', 'unit', 'unit_price', 'dn_no', 'po_no', 'delivery_date', 'dealer_name', 'vat_flag', 'invoice_no', 'line_discount'] as const;
export const DeliveryField = z.enum(DELIVERY_FIELDS);
export const DeliveryMapping = z.record(DeliveryField, z.number().int().min(0));
export const DeliveryPreviewReq = ImportFile.extend({
  mapping: DeliveryMapping.optional(), vendorId: z.string().optional(), vatFlagDefault: z.enum(['inc', 'exc', 'none']).optional(),
});
export const DeliveryRow = z.object({
  rowNo: z.number().int(), cells: z.array(z.string()), status: RowStatus, messages: z.array(z.string()),
  productCode: z.string(), productName: z.string(), qty: Dec.nullable(), unit: z.string(), unitPrice: Dec.nullable(), dnNo: z.string().nullable(),
  match: z.object({ productId: z.string(), unitIdx: z.number().int().nullable(), via: z.enum(['alias', 'sku', 'barcode']) }).nullable(),
});
export const DeliveryGroup = z.object({
  dnNo: z.string().nullable(), poNo: z.string().nullable(), deliveryDate: Ymd.nullable(), dealerName: z.string().nullable(), vendorId: z.string().nullable(),
  lines: z.number().int(), unmatched: z.number().int(), errors: z.number().int(),
  duplicate: z.object({ kind: z.enum(['received', 'draft']), ref: z.string(), date: Ymd }).nullable(),
});
export const DeliveryPreview = z.object({
  headers: z.array(z.string()), encoding: z.enum(['utf8', 'tis620', 'xlsx']), delimiter: z.string().nullable(), signature: z.string(),
  mapping: DeliveryMapping, profileId: z.string().nullable(), profileName: z.string().nullable(), missingRequired: z.array(DeliveryField),
  rows: z.array(DeliveryRow), groups: z.array(DeliveryGroup), fileImportedAt: z.string().nullable(),
  counts: z.object({ ok: z.number().int(), warn: z.number().int(), error: z.number().int() }),
});
export type DeliveryPreview = z.infer<typeof DeliveryPreview>;
export const DeliveryCommitReq = DeliveryPreviewReq.extend({
  mapping: DeliveryMapping, warehouseId: z.string().optional(), saveProfile: z.boolean().default(true), profileName: z.string().optional(),
  forceDnNos: z.array(z.string()).default([]), forceReason: z.string().optional(),
});
export const DeliveryCommitRes = z.object({
  batchNo: z.string(), drafts: z.array(z.object({ id: z.string(), dnNo: z.string().nullable(), lines: z.number().int(), unmatched: z.number().int() })),
  skipped: z.array(z.object({ dnNo: z.string().nullable(), reason: z.string() })), errorRows: z.number().int(),
});

export const GrDraftLine = z.object({
  id: z.string(), lineNo: z.number().int(), rowNo: z.number().int(), externalCode: z.string(), externalName: z.string(), unitText: z.string(),
  qty: Dec, unitPrice: Dec, lineDiscount: Dec, productId: z.string().nullable(), unitIdx: z.number().int().nullable(),
  receivedQty: Dec, damagedQty: Dec, unitCost: Dec.nullable(), warnings: z.array(z.string()),
});
export const GrDraft = z.object({
  id: z.string(), dnNo: z.string().nullable(), poNo: z.string().nullable(), invoiceNo: z.string().nullable(), dealerName: z.string().nullable(),
  vendorId: z.string().nullable(), warehouseId: z.string().nullable(), deliveryDate: Ymd.nullable(), receivedOn: Ymd, ageDays: z.number().int(),
  vatFlag: z.enum(['inc', 'exc', 'none']), status: z.enum(['draft', 'confirmed', 'cancelled']), confirmedNo: z.string().nullable(),
  unmatched: z.number().int(), lines: z.array(GrDraftLine), createdBy: z.string(),
});
export type GrDraft = z.infer<typeof GrDraft>;
export const GrDraftSummary = GrDraft.omit({ lines: true }).extend({ lineCount: z.number().int() });
export const GrDraftQuery = pageQuery.extend({ status: z.enum(['draft', 'confirmed', 'cancelled']).default('draft') });
export const GrDraftUpdate = z.object({
  vendorId: z.string().nullable().optional(), warehouseId: z.string().nullable().optional(), invoiceNo: z.string().nullable().optional(), dnNo: z.string().nullable().optional(),
  lines: z.array(z.object({ lineId: z.string(), productId: z.string().nullable().optional(), unitIdx: z.number().int().min(0).nullable().optional(), receivedQty: DecNN.optional(), damagedQty: DecNN.optional() })).optional(),
});
export const GrDraftCreateProductReq = z.object({
  sku: z.string().min(1), name: z.string().min(1), unitName: z.string().min(1), price: DecNN.default('0'), category: z.string().default(''),
});
export const GrDraftConfirmReq = z.object({
  vendorInvoiceNo: z.string().min(1), deliveryNo: z.string().min(1), billDiscount: DecNN.default('0'), shortReason: z.string().optional(),
});
export const GrDraftConfirmRes = z.object({ grNo: z.string(), apBillNo: z.string().nullable() });

export const ImportProfile = z.object({
  id: z.string(), kind: z.string(), name: z.string(), mapping: z.record(z.number().int()), encoding: z.string().nullable(), vendorId: z.string().nullable(), updatedAt: z.string(),
});
export const ProductAlias = z.object({ id: z.string(), vendorId: z.string().nullable(), externalCode: z.string(), productId: z.string(), productName: z.string(), unitMap: z.record(z.number().int()), updatedAt: z.string() });

// ---------- Import Hub (M04) ----------
export const IMPORT_KINDS = ['products', 'customers', 'vendors', 'opening_stock', 'opening_ar', 'opening_ap'] as const;
export const ImportKind = z.enum(IMPORT_KINDS);
export type ImportKind = z.infer<typeof ImportKind>;
export const ImportMode = z.enum(['onboarding', 'ongoing']);
export const ImportPreviewReq = ImportFile.extend({
  kind: ImportKind, mode: ImportMode.default('onboarding'), source: z.string().default('Excel template'), mapping: z.record(z.number().int().min(0)).optional(),
});
export const ImportRow = z.object({ rowNo: z.number().int(), cells: z.array(z.string()), status: RowStatus, messages: z.array(z.string()), key: z.string() });
export const ImportPreview = z.object({
  kind: ImportKind, headers: z.array(z.string()), fields: z.array(z.object({ key: z.string(), label: z.string(), required: z.boolean() })),
  mapping: z.record(z.number().int()), missingRequired: z.array(z.string()), rows: z.array(ImportRow),
  counts: z.object({ ok: z.number().int(), warn: z.number().int(), error: z.number().int(), exists: z.number().int() }),
  fileImportedAt: z.string().nullable(), profileName: z.string().nullable(),
});
export type ImportPreview = z.infer<typeof ImportPreview>;
export const ImportCommitReq = ImportPreviewReq.extend({
  mapping: z.record(z.number().int().min(0)), onlyValid: z.boolean().default(true), updateExisting: z.boolean().default(false), saveMapping: z.boolean().default(true),
});
export const ImportBatch = z.object({
  id: z.string(), no: z.string(), kind: z.string(), mode: z.string(), source: z.string(), fileName: z.string(), rowsTotal: z.number().int(),
  rowsCreated: z.number().int(), rowsUpdated: z.number().int(), rowsSkipped: z.number().int(), rowsError: z.number().int(), createdBy: z.string(), createdAt: z.string(),
});
export type ImportBatch = z.infer<typeof ImportBatch>;
export const ImportTemplateQuery = z.object({ format: z.enum(['csv', 'xlsx']).default('csv') });

// ---------- stock count (M06-05/06, BR-09) ----------
export const StockCountOpenReq = z.object({ warehouseId: z.string(), category: z.string().optional(), note: z.string().optional() });
export const StockCountEntryReq = z.object({ productId: z.string(), qty: DecNN, mode: z.enum(['set', 'add']).default('set') });
export const StockCountSummary = z.object({
  id: z.string(), no: z.string(), warehouseId: z.string(), category: z.string().nullable(), status: z.enum(['counting', 'submitted', 'cancelled']),
  openedBy: z.string(), openedAt: z.string(), submittedAt: z.string().nullable(), adjustRequestNo: z.string().nullable(),
  lines: z.number().int(), counted: z.number().int(),
});
export const StockCountLine = z.object({
  productId: z.string(), sku: z.string(), name: z.string(), unitName: z.string(), barcode: z.string().nullable(),
  /** Hidden (null) while counting unless the caller has inv.seeSys and asked for it (BR-09). */
  systemQty: Dec.nullable(), movedQty: Dec.nullable(), countedQty: Dec.nullable(), variance: Dec.nullable(),
  countedBy: z.string().nullable(),
});
export const StockCount = StockCountSummary.extend({ systemHidden: z.boolean(), items: z.array(StockCountLine) });
export type StockCount = z.infer<typeof StockCount>;
export const StockCountQuery = pageQuery.extend({ showSystem: QBool.optional() });

// ---------- ledger and reorder (M06-01) ----------
export const LedgerQuery = pageQuery.extend({ productId: z.string().optional(), warehouseId: z.string().optional(), from: Ymd.optional(), to: Ymd.optional() });
export const LedgerEntry = z.object({
  id: z.string(), at: z.string(), docType: z.string(), docNo: z.string(), productId: z.string(), sku: z.string(), name: z.string(), unitName: z.string(),
  warehouseId: z.string(), qty: Dec, unitCost: Dec.nullable(), balance: Dec, note: z.string(), user: z.string(),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;
export const ReorderItem = z.object({ productId: z.string(), sku: z.string(), name: z.string(), unitName: z.string(), category: z.string(), qty: Dec, reorderPoint: Dec, shortBy: Dec });

export const purchasingRoutes = {
  purchasingSettings: 'GET /api/purchasing/settings',
  purchasingSettingsUpdate: 'PATCH /api/purchasing/settings',
  purchasingDashboard: 'GET /api/purchasing/dashboard',
  grAlerts: 'GET /api/purchasing/gr-alerts',
  grReceipts: 'GET /api/purchasing/receipts',
  grReceipt: 'GET /api/purchasing/receipts/:no',

  apBills: 'GET /api/ap/bills',
  apAging: 'GET /api/ap/aging',
  apPayments: 'GET /api/ap/payments',
  apPaymentCreate: 'POST /api/ap/payments',
  apPayment: 'GET /api/ap/payments/:no',
  vendorReturns: 'GET /api/ap/vendor-returns',
  vendorReturnCreate: 'POST /api/ap/vendor-returns',
  vendorReturn: 'GET /api/ap/vendor-returns/:no',
  purchaseDiscounts: 'GET /api/ap/purchase-discounts',

  deliveryPreview: 'POST /api/delivery-imports/preview',
  deliveryCommit: 'POST /api/delivery-imports/commit',
  grDrafts: 'GET /api/gr-drafts',
  grDraft: 'GET /api/gr-drafts/:id',
  grDraftUpdate: 'PATCH /api/gr-drafts/:id',
  grDraftCreateProduct: 'POST /api/gr-drafts/:id/lines/:lineId/product',
  grDraftConfirm: 'POST /api/gr-drafts/:id/confirm',
  grDraftCancel: 'POST /api/gr-drafts/:id/cancel',
  importProfiles: 'GET /api/import/profiles',
  importProfileDisable: 'POST /api/import/profiles/:id/disable',
  productAliases: 'GET /api/import/aliases',
  productAliasDisable: 'POST /api/import/aliases/:id/disable',

  importTemplate: 'GET /api/import/templates/:kind',
  importPreview: 'POST /api/import/preview',
  importCommit: 'POST /api/import/commit',
  importBatches: 'GET /api/import/batches',

  stockCounts: 'GET /api/stock-counts',
  stockCountOpen: 'POST /api/stock-counts',
  stockCount: 'GET /api/stock-counts/:id',
  stockCountEntry: 'POST /api/stock-counts/:id/entries',
  stockCountSubmit: 'POST /api/stock-counts/:id/submit',
  stockCountCancel: 'POST /api/stock-counts/:id/cancel',

  stockLedger: 'GET /api/stock/ledger',
  stockReorder: 'GET /api/stock/reorder',
} as const;

/** Every purchasing route exists on both editions (the delivery-file import is the on-prem way to receive SCG goods). */
export const purchasingRouteEditions: RouteEditions<typeof purchasingRoutes> = {};
