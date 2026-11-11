/**
 * API contract for the "reports" module group: M11 reports + home dashboard, M12 accounting export
 * (PEAK / FlowAccount / Express / general journal / CSV).
 * Every name exported here is re-exported from '@erp/contracts', so names carry a Report / Export prefix.
 * Report endpoints answer JSON (`format=json`, cursor-paged rows + totals over the whole period) or a file
 * download of every row (`format=csv` UTF-8 BOM, `format=xlsx`).
 */
import { z } from 'zod';
import { Dec, type RouteEditions } from '../core';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const IsoMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM');
export const ReportFormat = z.enum(['json', 'csv', 'xlsx']);
export type ReportFormat = z.infer<typeof ReportFormat>;
const reportPage = {
  format: ReportFormat.default('json'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
};

/** A data source that another module group will provide later (AP bills, payroll, promotions, ...). */
export const ReportSource = z.object({ key: z.string(), label: z.string(), available: z.boolean(), note: z.string() });
export type ReportSource = z.infer<typeof ReportSource>;

// ---------- M11-01 sales and gross profit ----------
export const ReportSalesBy = z.enum(['day', 'month', 'product', 'category', 'customer', 'seller', 'saleType']);
export type ReportSalesBy = z.infer<typeof ReportSalesBy>;
export const ReportSaleType = z.enum(['retail', 'whole', 'project']);
export const ReportSalesQuery = z.object({
  from: IsoDate, to: IsoDate, by: ReportSalesBy.default('day'), saleType: ReportSaleType.optional(), q: z.string().optional(), ...reportPage,
});
export type ReportSalesQuery = z.infer<typeof ReportSalesQuery>;
export const ReportSalesRow = z.object({
  key: z.string(), label: z.string(), sub: z.string(),
  /** Documents (bills, invoices; credit notes count separately in `returns`). */
  bills: z.number().int(), returns: z.number().int(),
  /** Base-unit quantity (product grouping only). */
  qty: Dec.nullable(),
  /** Sales ex VAT, net of credit notes. */
  net: Dec, vat: Dec, total: Dec,
  /** FIFO cost from the stock ledger; null without data.cost. */
  cogs: Dec.nullable(), gp: Dec.nullable(), gpPct: Dec.nullable(),
});
export type ReportSalesRow = z.infer<typeof ReportSalesRow>;
export const ReportSales = z.object({
  from: IsoDate, to: IsoDate, by: ReportSalesBy, rows: z.array(ReportSalesRow), totals: ReportSalesRow, nextCursor: z.string().nullable(),
  costVisible: z.boolean(), voided: z.object({ count: z.number().int(), total: Dec }), sources: z.array(ReportSource),
  /** ของแถม (ต้นทุน): FIFO cost of free lines in the period, already inside totals.cogs; null without data.cost. */
  freeGoodsCost: Dec.nullable().default(null),
});
export type ReportSales = z.infer<typeof ReportSales>;

// ---------- M11-02 stock on hand ----------
export const ReportStockQuery = z.object({
  asOf: IsoDate.optional(), warehouseId: z.string().optional(), q: z.string().optional(),
  only: z.enum(['all', 'low', 'slow']).default('all'), slowDays: z.coerce.number().int().min(1).max(3650).default(90), ...reportPage,
});
export type ReportStockQuery = z.infer<typeof ReportStockQuery>;
export const ReportStockRow = z.object({
  productId: z.string(), sku: z.string(), name: z.string(), category: z.string(), unit: z.string(),
  qty: Dec, value: Dec.nullable(), avgCost: Dec.nullable(), reorderPoint: Dec,
  lastOut: z.string().nullable(), idleDays: z.number().int().nullable(), low: z.boolean(), slow: z.boolean(),
  /** In damaged-goods warehouses (not in qty / value unless the report is filtered to that warehouse). */
  damagedQty: Dec.optional(), damagedValue: Dec.nullable().optional(),
});
export type ReportStockRow = z.infer<typeof ReportStockRow>;
export const ReportStock = z.object({
  asOf: IsoDate, slowDays: z.number().int(), rows: z.array(ReportStockRow), nextCursor: z.string().nullable(), costVisible: z.boolean(),
  totals: z.object({ products: z.number().int(), qty: Dec, value: Dec.nullable(), low: z.number().int(), slow: z.number().int(), damagedQty: Dec.optional(), damagedValue: Dec.nullable().optional() }),
});
export type ReportStock = z.infer<typeof ReportStock>;

// ---------- M11-03 VAT ----------
export const ReportVatQuery = z.object({ month: IsoMonth, kind: z.enum(['sales', 'purchase']).default('sales'), ...reportPage });
export type ReportVatQuery = z.infer<typeof ReportVatQuery>;
export const ReportVatRow = z.object({
  seq: z.number().int(), date: IsoDate, no: z.string(), name: z.string(), taxId: z.string(), branch: z.string(),
  base7: Dec, exempt: Dec, vat: Dec, total: Dec, note: z.string(),
});
export type ReportVatRow = z.infer<typeof ReportVatRow>;
export const ReportVat = z.object({
  month: IsoMonth, kind: z.enum(['sales', 'purchase']),
  shop: z.object({ name: z.string(), taxId: z.string(), branch: z.string() }),
  rows: z.array(ReportVatRow), nextCursor: z.string().nullable(),
  totals: z.object({ base7: Dec, exempt: Dec, vat: Dec, total: Dec, docs: z.number().int(), voided: z.number().int() }),
  sources: z.array(ReportSource),
});
export type ReportVat = z.infer<typeof ReportVat>;

// ---------- M11-06 internal cost, M11-07 promotions, M11-05 coupons ----------
export const ReportMonthQuery = z.object({ month: IsoMonth, format: ReportFormat.default('json') });
export const ReportCostLine = z.object({ key: z.string(), label: z.string(), amount: Dec.nullable(), count: z.number().int().nullable(), note: z.string() });
export const ReportCosts = z.object({
  month: IsoMonth, sales: Dec, cogs: Dec, gp: Dec, lines: z.array(ReportCostLine), totalCost: Dec, profitAfter: Dec, sources: z.array(ReportSource),
});
export type ReportCosts = z.infer<typeof ReportCosts>;
export const ReportRangeQuery = z.object({ from: IsoDate, to: IsoDate, format: ReportFormat.default('json') });
export const ReportPromoRow = z.object({
  key: z.string(), label: z.string(), bills: z.number().int(), sets: Dec, sales: Dec, discount: Dec, cogs: Dec.nullable(), gp: Dec.nullable(),
  before: z.object({ sales: Dec, gp: Dec.nullable() }).nullable(),
});
export const ReportPromotions = z.object({ from: IsoDate, to: IsoDate, rows: z.array(ReportPromoRow), sources: z.array(ReportSource) });
export const ReportCouponRow = z.object({ billNo: z.string(), date: IsoDate, memberId: z.string(), couponCode: z.string(), amount: Dec, redeemRef: z.string() });
export const ReportCoupons = z.object({ from: IsoDate, to: IsoDate, rows: z.array(ReportCouponRow), total: Dec, sources: z.array(ReportSource) });

// ---------- M11-04 home dashboard ----------
export const ReportDashboard = z.object({
  today: IsoDate,
  salesToday: z.object({ total: Dec, bills: z.number().int(), vat: Dec, returns: Dec }).nullable(),
  sales7d: z.array(z.object({ date: IsoDate, total: Dec })).nullable(),
  month: z.object({ sales: Dec, cogs: Dec.nullable(), gp: Dec.nullable(), stockValue: Dec.nullable() }).nullable(),
  lowStock: z.object({ count: z.number().int(), items: z.array(z.object({ productId: z.string(), name: z.string(), unit: z.string(), qty: Dec, reorderPoint: Dec, isScg: z.boolean() })) }).nullable(),
  arDue: z.object({ amount: Dec, count: z.number().int(), items: z.array(z.object({ no: z.string(), customer: z.string(), balance: Dec, dueDate: IsoDate, overdueDays: z.number().int() })) }).nullable(),
  approvals: z.object({ count: z.number().int(), items: z.array(z.object({ kind: z.string(), no: z.string(), label: z.string(), at: z.string(), path: z.string() })) }).nullable(),
  /** Goods delivered but not yet confirmed (M05). null while that source is missing on this build. */
  grPending: z.object({ count: z.number().int(), oldestDays: z.number().int() }).nullable(),
  sources: z.array(ReportSource),
});
export type ReportDashboard = z.infer<typeof ReportDashboard>;

// ---------- M12 accounting export ----------
export const ExportGl = z.object({
  sale: z.string(), buy: z.string(), cogs: z.string(), pdisc: z.string(), ar: z.string(), ap: z.string(),
  vatOut: z.string(), vatIn: z.string(), cash: z.string(), coupon: z.string(), deposit: z.string(),
});
export type ExportGl = z.infer<typeof ExportGl>;
const GlCode = z.string().trim().regex(/^[0-9A-Za-z.-]{1,20}$/, 'account code');
export const ExportGlUpdate = z.object(Object.fromEntries(Object.keys(ExportGl.shape).map((k) => [k, GlCode.optional()])) as { [K in keyof ExportGl]: z.ZodOptional<typeof GlCode> });

export const ExportTemplate = z.enum(['peak', 'flowaccount', 'express', 'generic', 'journal']);
export type ExportTemplate = z.infer<typeof ExportTemplate>;
export const ExportDataset = z.enum(['sales', 'purchase', 'receipts', 'stock', 'vatSales', 'vatPurchase', 'products', 'contacts']);
export type ExportDataset = z.infer<typeof ExportDataset>;
/** Which datasets each template can produce. */
export const EXPORT_COMBOS: Readonly<Record<ExportTemplate, readonly ExportDataset[]>> = {
  peak: ['sales', 'purchase', 'products', 'contacts'],
  flowaccount: ['sales', 'purchase'],
  express: ['sales', 'purchase'],
  generic: ['sales', 'purchase', 'receipts', 'stock', 'vatSales', 'vatPurchase'],
  journal: ['sales', 'purchase'],
};
export const ExportRunReq = z.object({
  template: ExportTemplate, dataset: ExportDataset, from: IsoDate.optional(), to: IsoDate.optional(),
  /** Only documents that no earlier export run contained (REQ-M12-04). */
  onlyNew: z.boolean().default(false),
  format: z.enum(['csv', 'xlsx']).default('csv'),
});
export type ExportRunReq = z.infer<typeof ExportRunReq>;
export const ExportFileInfo = z.object({ seq: z.number().int(), name: z.string(), rows: z.number().int() });
export const ExportRun = z.object({
  id: z.string(), template: ExportTemplate, dataset: ExportDataset, format: z.enum(['csv', 'xlsx']), from: IsoDate.nullable(), to: IsoDate.nullable(), onlyNew: z.boolean(),
  rows: z.number().int(), docs: z.number().int(), files: z.array(ExportFileInfo), warnings: z.array(z.string()),
  /** Documents in this run voided after it was exported: the accountant must fix them in the accounting program. */
  changedAfter: z.array(z.object({ no: z.string(), at: z.string() })),
  createdBy: z.string(), createdAt: z.string(),
});
export type ExportRun = z.infer<typeof ExportRun>;

export const reportsRoutes = {
  reportDashboard: 'GET /api/reports/dashboard',
  reportSales: 'GET /api/reports/sales',
  reportStock: 'GET /api/reports/stock',
  reportVat: 'GET /api/reports/vat',
  reportCosts: 'GET /api/reports/costs',
  reportPromotions: 'GET /api/reports/promotions',
  reportCoupons: 'GET /api/reports/coupons',
  exportGl: 'GET /api/acct-export/gl',
  exportGlUpdate: 'PATCH /api/acct-export/gl',
  exportRunCreate: 'POST /api/acct-export/runs',
  exportRuns: 'GET /api/acct-export/runs',
  exportRun: 'GET /api/acct-export/runs/:id',
  exportFile: 'GET /api/acct-export/runs/:id/files/:seq',
} as const;

/** SCG Family is cloud-only (OQ-A2): the coupon report exists on the cloud edition only. */
export const reportsRouteEditions: RouteEditions<typeof reportsRoutes> = { reportCoupons: 'cloud' };
