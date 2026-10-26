/**
 * API contract shared by apps/server and apps/web.
 * Money and quantities travel as decimal strings ("145.00", "118.3400") — never JS floats.
 * Every list endpoint is cursor-paged (NFR-12): ?limit=20&cursor=<opaque>.
 */
import { z } from 'zod';

export const Dec = z.string().regex(/^-?\d+(\.\d+)?$/, 'decimal string');
export type Dec = z.infer<typeof Dec>;
/** Decimal string that may not be negative: prices, costs, discounts, payments, cash amounts. */
export const DecNN = Dec.refine((s) => !s.startsWith('-'), 'must not be negative');

// Edition, Capabilities and Meta live in ./meta so a server bundle that does not import them
// (the on-prem server) carries none of the cloud-only capability names (scripts/check-onprem.mjs).
export * from './meta';

export const pageQuery = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type PageQuery = z.infer<typeof pageQuery>;
export const page = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export type Page<T> = { items: T[]; nextCursor: string | null };

/** Error body for every non-2xx response. */
export const ApiError = z.object({
  code: z.enum(['VALIDATION', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'BELOW_COST', 'INSUFFICIENT_STOCK', 'SHIFT_REQUIRED', 'NOT_AVAILABLE_IN_EDITION', 'DOWNSTREAM_FIRST', 'INTERNAL']),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

// ---------- auth (M01) ----------
export const Role = z.enum(['owner', 'manager', 'cashier', 'sales', 'wh', 'driver', 'acct', 'extacct']);
export type Role = z.infer<typeof Role>;
export const LoginReq = z.object({
  username: z.string().min(1), password: z.string().min(1),
  tenant: z.string().optional(), // shop code; only needed (cloud) when the username exists in several shops
});
export const SessionUser = z.object({ id: z.string(), name: z.string(), role: Role, perms: z.record(z.union([z.literal(0), z.literal(1), z.literal('ro'), z.literal('apv'), z.number()])) });
export type SessionUser = z.infer<typeof SessionUser>;
export const LoginRes = z.object({ token: z.string(), user: SessionUser });
/** GET /api/users/approvers: active users whose PIN can approve (owner, manager). The UI needs their ids for `Approval`. */
export const Approver = z.object({ id: z.string(), name: z.string(), role: Role });
export type Approver = z.infer<typeof Approver>;

// ---------- master data (M03) ----------
export const ProductUnit = z.object({ name: z.string(), factor: Dec, price: DecNN.optional() });
export const Product = z.object({
  id: z.string(), sku: z.string(), name: z.string(), barcode: z.string().nullable(), category: z.string(),
  isScg: z.boolean(), kind: z.enum(['stock', 'service']), vat: z.enum(['v7', 'exempt']),
  price: DecNN, cost: Dec.nullable(), // cost hidden (null) when caller lacks data.cost
  units: z.array(ProductUnit).min(1), reorderPoint: Dec, active: z.boolean(),
});
export type Product = z.infer<typeof Product>;
export const ProductUpsert = Product.omit({ id: true, cost: true }).partial({ barcode: true, active: true });

export const Customer = z.object({
  id: z.string(), code: z.string(), name: z.string(), taxId: z.string().nullable(), branch: z.string().nullable(), phone: z.string().nullable(),
  group: z.enum(['retail', 'whole', 'contr']), creditLimit: Dec,
  term: z.discriminatedUnion('t', [z.object({ t: z.literal('cash') }), z.object({ t: z.literal('days'), x: z.number().int() }), z.object({ t: z.literal('nextDay'), x: z.number().int() }), z.object({ t: z.literal('eom') })]),
});
export type Customer = z.infer<typeof Customer>;
export const CustomerCreate = Customer.omit({ id: true }).partial({ code: true, taxId: true, branch: true, phone: true, group: true, creditLimit: true, term: true });
export const Vendor = z.object({ id: z.string(), code: z.string(), name: z.string(), taxId: z.string().nullable(), branch: z.string().nullable(), phone: z.string().nullable() });
export type Vendor = z.infer<typeof Vendor>;
export const Warehouse = z.object({ id: z.string(), name: z.string(), isPos: z.boolean(), active: z.boolean() });
export type Warehouse = z.infer<typeof Warehouse>;

// ---------- stock (M05, M06) ----------
export const StockBalance = z.object({ productId: z.string(), warehouseId: z.string(), qty: Dec });
export const StockLot = z.object({ id: z.string(), productId: z.string(), warehouseId: z.string(), receivedAt: z.string(), qty: Dec, unitCost: Dec, ref: z.string() });
export const StockLineIn = z.object({ productId: z.string(), unitIdx: z.number().int().min(0).default(0), qty: Dec });
export const ManualReceiptReq = z.object({ // REQ-M05-06 (the only GR path on onprem)
  vendorId: z.string(), vendorInvoiceNo: z.string().min(1), deliveryNo: z.string().min(1), warehouseId: z.string(),
  lines: z.array(StockLineIn.extend({ unitCost: DecNN })).min(1), billDiscount: DecNN.default('0'),
});
export const TransferReq = z.object({ fromWarehouseId: z.string(), toWarehouseId: z.string(), lines: z.array(StockLineIn).min(1), note: z.string().optional() });
export const IssueReq = z.object({ warehouseId: z.string(), lines: z.array(StockLineIn).min(1), reason: z.string().min(1) });
export const AdjustRequestReq = z.object({ warehouseId: z.string(), lines: z.array(z.object({ productId: z.string(), qtyDelta: Dec })).min(1), reason: z.string().min(1) });
export const StockShortage = z.object({ productId: z.string(), warehouseId: z.string(), need: Dec, have: Dec });
/** Response of receipts / transfers / issues / adjustment approvals. Quantities in base units. */
export const StockDoc = z.object({
  id: z.string(), no: z.string(), type: z.enum(['GR', 'TR', 'ADJ']), date: z.string(), warehouseId: z.string(), toWarehouseId: z.string().nullable(),
  lines: z.array(z.object({ productId: z.string(), qty: Dec, unitCost: Dec.nullable() })),
});
export type StockDoc = z.infer<typeof StockDoc>;
export const AdjustRequest = z.object({
  id: z.string(), no: z.string(), warehouseId: z.string(), lines: z.array(z.object({ productId: z.string(), qtyDelta: Dec })), reason: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']), requestedBy: z.string(), decidedBy: z.string().nullable(), resultDocNo: z.string().nullable(), createdAt: z.string(),
});
export const AdjustListQuery = pageQuery.extend({ status: z.enum(['pending', 'approved', 'rejected']).optional() });

// ---------- shift (M07-06) ----------
export const OpenShiftReq = z.object({ float: DecNN, deviceId: z.string() });
export const CashMoveReq = z.object({ type: z.enum(['in', 'out']), amount: DecNN, note: z.string().min(1) });
export const CloseShiftReq = z.object({ counted: DecNN, note: z.string().optional() });
export const Shift = z.object({
  id: z.string(), no: z.string(), userId: z.string(), deviceId: z.string(), openedAt: z.string(), closedAt: z.string().nullable(),
  float: Dec, cashSales: Dec, cashRefunds: Dec, cashIn: Dec, cashOut: Dec, expected: Dec, counted: Dec.nullable(), diff: Dec.nullable(),
  byMethod: z.record(Dec),
});
export type Shift = z.infer<typeof Shift>;

// ---------- sales (M07, M08) ----------
export const Discount = z.object({ kind: z.enum(['pct', 'amt']), value: DecNN })
  .refine((x) => x.kind !== 'pct' || Number(x.value) <= 100, { message: 'percent discount must be 0..100', path: ['value'] });
export const PaymentMethod = z.enum(['cash', 'transfer', 'promptpay', 'card']);
export const PosSaleReq = z.object({
  idempotencyKey: z.string().uuid(),
  shiftId: z.string(), warehouseId: z.string(),
  docKind: z.enum(['abb', 'full', 'receipt']), // receipt = non-VAT shop
  customerId: z.string().optional(),
  lines: z.array(z.object({ productId: z.string(), unitIdx: z.number().int().min(0).default(0), qty: Dec, unitPrice: DecNN, discount: Discount.optional() })).min(1),
  billDiscount: DecNN.default('0'),
  payments: z.array(z.object({ method: PaymentMethod, amount: DecNN })).min(1),
  belowCostApproval: z.object({ approverUserId: z.string(), pin: z.string() }).optional(), // BR-16 owner only
  discountApproval: z.object({ approverUserId: z.string(), pin: z.string() }).optional(),  // over role cap
});
export type PosSaleReq = z.infer<typeof PosSaleReq>;
export const DocLine = z.object({ id: z.string(), productId: z.string(), name: z.string(), unitName: z.string(), qty: Dec, unitPrice: Dec, discount: Dec, net: Dec, returnedQty: Dec, cogs: Dec.nullable() });
export const SalesDoc = z.object({
  id: z.string(), no: z.string(), type: z.enum(['ABB', 'INV', 'RC', 'CN', 'QT', 'SO', 'DO']), date: z.string(),
  customer: z.object({ id: z.string().nullable(), name: z.string(), phone: z.string().nullable() }),
  vatMode: z.enum(['inc', 'exc', 'none']), lines: z.array(DocLine),
  totals: z.object({ gross: Dec, lineDisc: Dec, billDisc: Dec, base7: Dec, exempt: Dec, vat: Dec, total: Dec }),
  payments: z.array(z.object({ method: PaymentMethod, amount: Dec })), status: z.enum(['active', 'void']),
  voided: z.object({ by: z.string(), at: z.string(), reason: z.string() }).nullable(), createdBy: z.string(), ref: z.string().nullable(),
});
export type SalesDoc = z.infer<typeof SalesDoc>;
export const DocSummary = SalesDoc.pick({ id: true, no: true, type: true, date: true, customer: true, status: true }).extend({ total: Dec, itemsPreview: z.string() });
export type DocSummary = z.infer<typeof DocSummary>;
/** PIN approval by another user (manager / owner), e.g. for a cashier's return. */
export const Approval = z.object({ approverUserId: z.string(), pin: z.string() });
export const VoidReq = z.object({ reason: z.string().min(1), approverUserId: z.string().optional(), pin: z.string().optional() });

// ---------- returns (M08-06) ----------
/** GET /returns/eligible — searchable bill picker, not a dropdown. */
export const EligibleQuery = pageQuery.extend({ days: z.enum(['7', '30', '90', 'all']).default('30') });
export const ReturnReq = z.object({
  sourceDocNo: z.string(), lines: z.array(z.object({ lineId: z.string(), qty: Dec })).min(1),
  condition: z.enum(['good', 'bad']), warehouseId: z.string().optional(), refund: z.enum(['cash', 'transfer', 'credit']), reason: z.string().min(1),
  approval: Approval.optional(), // needed when the caller's sales.return is 'apv' (cashier, sales)
});

// ---------- audit (BR-18) ----------
export const AuditEntry = z.object({ id: z.string(), at: z.string(), user: z.string(), action: z.string(), object: z.string(), ref: z.string().nullable(), detail: z.string() });

// ---------- on-prem first run (GET /api/meta needsSetup) ----------
export const SetupReq = z.object({
  shop: z.object({
    name: z.string().min(1), taxId: z.string().default(''), branch: z.string().default('สำนักงานใหญ่'), address: z.string().default(''), phone: z.string().default(''),
    vatRegistered: z.boolean(), b2bVatMode: z.enum(['inc', 'exc']).default('exc'),
  }),
  owner: z.object({ username: z.string().min(1), name: z.string().min(1), password: z.string().min(6), pin: z.string().regex(/^\d{4,6}$/) }),
});
export type SetupReq = z.infer<typeof SetupReq>;

// ---------- on-prem client pairing ----------
export const PairingCode = z.object({ code: z.string().regex(/^\d{6}$/), expiresAt: z.string() });

/** Route table — the single source of truth both apps import. */
export const routes = {
  meta: 'GET /api/meta', login: 'POST /api/auth/login', me: 'GET /api/auth/me',
  products: 'GET /api/products', productCreate: 'POST /api/products', productUpdate: 'PATCH /api/products/:id',
  customers: 'GET /api/customers', customerCreate: 'POST /api/customers', warehouses: 'GET /api/warehouses',
  stock: 'GET /api/stock', lots: 'GET /api/stock/lots', receipt: 'POST /api/stock/receipts', transfer: 'POST /api/stock/transfers', issue: 'POST /api/stock/issues',
  adjustRequest: 'POST /api/stock/adjust-requests', adjustRequests: 'GET /api/stock/adjust-requests', adjustApprove: 'POST /api/stock/adjust-requests/:id/approve',
  shiftCurrent: 'GET /api/shifts/current', shiftOpen: 'POST /api/shifts/open', shiftMove: 'POST /api/shifts/:id/cash-moves', shiftClose: 'POST /api/shifts/:id/close',
  posSale: 'POST /api/sales/pos', docs: 'GET /api/sales/docs', doc: 'GET /api/sales/docs/:no', voidDoc: 'POST /api/sales/docs/:no/void',
  returnsEligible: 'GET /api/returns/eligible', returnCreate: 'POST /api/returns',
  audit: 'GET /api/audit-log', auditVerify: 'GET /api/audit-log/verify',
  vendors: 'GET /api/vendors', approvers: 'GET /api/users/approvers', adjustReject: 'POST /api/stock/adjust-requests/:id/reject', userUnlock: 'POST /api/users/:id/unlock',
  healthz: 'GET /healthz',
  // onprem only
  pairingCode: 'POST /api/devices/pairing-code', pair: 'GET /pair', setup: 'POST /api/setup',
  // cloud only — not registered (404 NOT_AVAILABLE_IN_EDITION) on onprem
  ppIncoming: 'GET /api/promptplus/incoming', ppOrderFromDoc: 'POST /api/promptplus/orders',
} as const;
