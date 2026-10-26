/**
 * Drizzle schema. Source of truth for the generated migrations in ../migrations.
 * Hand-written SQL (RLS policies, triggers, pg_trgm, grants) lives in the custom
 * migration `0001_rls_triggers.sql`.
 *
 * Conventions
 * - Every table has tenant_id (BR-14 / M19); RLS policies filter on app.tenant_id.
 * - Money numeric(14,2), quantities and unit costs numeric(14,4). Drizzle returns them as strings.
 * - Documents are never deleted (BR-03/BR-22); void is a status flag.
 */
import { sql } from 'drizzle-orm';
import {
  bigint, boolean, check, date, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () => uuid('tenant_id').notNull();
const money = (name: string) => numeric(name, { precision: 14, scale: 2 });
const qty = (name: string) => numeric(name, { precision: 14, scale: 4 });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable('tenants', {
  id: id(),
  /** Shop code used to pick the tenant at login when a username exists in several tenants. */
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  taxId: text('tax_id').notNull().default(''),
  branch: text('branch').notNull().default('สำนักงานใหญ่'),
  address: text('address').notNull().default(''),
  phone: text('phone').notNull().default(''),
  vatRegistered: boolean('vat_registered').notNull().default(true),
  b2bVatMode: text('b2b_vat_mode').notNull().default('exc'),
  /** Per document type numbering pattern overrides, e.g. {"QT":"QO-{YYYY}{MM}{DD}{NN}"}. */
  docPatterns: jsonb('doc_patterns').notNull().default({}),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: id(),
  tenantId: tenantId(),
  username: text('username').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  passwordHash: text('password_hash').notNull(),
  pinHash: text('pin_hash'),
  /** BR-18: users are never deleted, only resigned. */
  status: text('status').notNull().default('active'),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  /** Failed approval PINs (counted in their own committed transaction); approvals lock for 15 min at 5. */
  pinFailed: integer('pin_failed').notNull().default(0),
  pinLockedUntil: timestamp('pin_locked_until', { withTimezone: true }),
  phone: text('phone'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('users_tenant_username').on(t.tenantId, t.username),
  check('users_status', sql`${t.status} in ('active','resigned')`),
]);

export const warehouses = pgTable('warehouses', {
  id: id(),
  tenantId: tenantId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  isPos: boolean('is_pos').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('warehouses_tenant_code').on(t.tenantId, t.code)]);

export const products = pgTable('products', {
  id: id(),
  tenantId: tenantId(),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  barcode: text('barcode'),
  category: text('category').notNull().default(''),
  isScg: boolean('is_scg').notNull().default(false),
  kind: text('kind').notNull().default('stock'),
  vat: text('vat').notNull().default('v7'),
  price: money('price').notNull(),
  /** Standard / moving-average cost per base unit (shown when the caller has data.cost). */
  cost: qty('cost').notNull().default('0'),
  /** [{name, factor, price?}] — index 0 is the base unit (factor 1). */
  units: jsonb('units').notNull(),
  reorderPoint: qty('reorder_point').notNull().default('0'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('products_tenant_sku').on(t.tenantId, t.sku),
  check('products_kind', sql`${t.kind} in ('stock','service')`),
  check('products_vat', sql`${t.vat} in ('v7','exempt')`),
]);

export const customers = pgTable('customers', {
  id: id(),
  tenantId: tenantId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  taxId: text('tax_id'),
  branch: text('branch'),
  phone: text('phone'),
  group: text('grp').notNull().default('retail'),
  creditLimit: money('credit_limit').notNull().default('0'),
  term: jsonb('term').notNull().default({ t: 'cash' }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('customers_tenant_code').on(t.tenantId, t.code)]);

export const vendors = pgTable('vendors', {
  id: id(),
  tenantId: tenantId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  taxId: text('tax_id'),
  branch: text('branch'),
  phone: text('phone'),
  term: jsonb('term').notNull().default({ t: 'cash' }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('vendors_tenant_code').on(t.tenantId, t.code)]);

/** BR-04: one row per counter bucket, locked and incremented inside the document's transaction. */
export const docCounters = pgTable('doc_counters', {
  tenantId: tenantId(),
  type: text('type').notNull(),
  period: text('period').notNull(),
  device: text('device').notNull().default(''),
  seq: integer('seq').notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.type, t.period, t.device] })]);

export const shifts = pgTable('shifts', {
  id: id(),
  tenantId: tenantId(),
  no: text('no').notNull(),
  userId: uuid('user_id').notNull(),
  deviceId: text('device_id').notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  float: money('float').notNull(),
  /** Frozen at close (Z report); null while open. */
  summary: jsonb('summary'),
  counted: money('counted'),
  expected: money('expected'),
  diff: money('diff'),
  note: text('note'),
}, (t) => [
  uniqueIndex('shifts_tenant_no').on(t.tenantId, t.no),
  // at most one open shift per user
  uniqueIndex('shifts_one_open_per_user').on(t.tenantId, t.userId).where(sql`${t.closedAt} is null`),
]);

export const shiftMoves = pgTable('shift_moves', {
  id: id(),
  tenantId: tenantId(),
  shiftId: uuid('shift_id').notNull(),
  type: text('type').notNull(),
  amount: money('amount').notNull(),
  note: text('note').notNull(),
  userId: uuid('user_id').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('shift_moves_type', sql`${t.type} in ('in','out')`), check('shift_moves_amount', sql`${t.amount} > 0`)]);

/** Sales documents: ABB, INV, RC (non-VAT receipt), CN (return / credit note). */
export const docs = pgTable('docs', {
  id: id(),
  tenantId: tenantId(),
  no: text('no').notNull(),
  type: text('type').notNull(),
  date: date('date').notNull(),
  customerId: uuid('customer_id'),
  customerName: text('customer_name').notNull(),
  customerPhone: text('customer_phone'),
  vatMode: text('vat_mode').notNull(),
  warehouseId: uuid('warehouse_id'),
  shiftId: uuid('shift_id'),
  deviceId: text('device_id'),
  gross: money('gross').notNull(),
  lineDisc: money('line_disc').notNull(),
  billDisc: money('bill_disc').notNull(),
  base7: money('base7').notNull(),
  exempt: money('exempt').notNull(),
  vat: money('vat').notNull(),
  total: money('total').notNull(),
  /** Outstanding receivable (credit sales). Credit refunds reduce it. */
  arBalance: money('ar_balance').notNull().default('0'),
  payments: jsonb('payments').notNull().default([]),
  status: text('status').notNull().default('active'),
  voidBy: uuid('void_by'),
  voidAt: timestamp('void_at', { withTimezone: true }),
  voidReason: text('void_reason'),
  createdBy: uuid('created_by').notNull(),
  refDocId: uuid('ref_doc_id'),
  refNo: text('ref_no'),
  idempotencyKey: uuid('idempotency_key'),
  memberId: text('member_id'),
  /** Returns: refund method, item condition, reason. */
  refund: text('refund'),
  condition: text('condition'),
  reason: text('reason'),
  /** Lower-cased haystack for the returns bill picker (pg_trgm GIN index). */
  searchText: text('search_text').notNull().default(''),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('docs_tenant_no').on(t.tenantId, t.no),
  uniqueIndex('docs_tenant_idem').on(t.tenantId, t.idempotencyKey),
  index('docs_tenant_created').on(t.tenantId, t.createdAt, t.id),
  index('docs_ref').on(t.tenantId, t.refDocId),
  index('docs_shift').on(t.tenantId, t.shiftId),
  check('docs_status', sql`${t.status} in ('active','void')`),
  check('docs_vat_mode', sql`${t.vatMode} in ('inc','exc','none')`),
]);

export const docLines = pgTable('doc_lines', {
  id: id(),
  tenantId: tenantId(),
  docId: uuid('doc_id').notNull(),
  lineNo: integer('line_no').notNull(),
  productId: uuid('product_id').notNull(),
  name: text('name').notNull(),
  unitName: text('unit_name').notNull(),
  unitFactor: qty('unit_factor').notNull(),
  qty: qty('qty').notNull(),
  baseQty: qty('base_qty').notNull(),
  unitPrice: qty('unit_price').notNull(),
  discount: money('discount').notNull(),
  net: money('net').notNull(),
  /** Net after the bill-discount share; what a return refunds per unit. */
  netAfterBill: money('net_after_bill').notNull(),
  vat: text('vat').notNull(),
  returnedQty: qty('returned_qty').notNull().default('0'),
  /** FIFO cost of goods (sum over stock_move_lots); null for services. */
  cogs: money('cogs'),
  /** Returns: the sold line this CN line refers to. */
  srcLineId: uuid('src_line_id'),
}, (t) => [
  index('doc_lines_doc').on(t.tenantId, t.docId),
  check('doc_lines_returned', sql`${t.returnedQty} >= 0 and ${t.returnedQty} <= ${t.qty}`),
]);

/** Inventory documents: GR (receipt), TR (transfer), ADJ (issue / approved adjustment). */
export const stockDocs = pgTable('stock_docs', {
  id: id(),
  tenantId: tenantId(),
  no: text('no').notNull(),
  type: text('type').notNull(),
  date: date('date').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  toWarehouseId: uuid('to_warehouse_id'),
  vendorId: uuid('vendor_id'),
  vendorInvoiceNo: text('vendor_invoice_no'),
  deliveryNo: text('delivery_no'),
  reason: text('reason'),
  lines: jsonb('lines').notNull(),
  total: money('total'),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('stock_docs_tenant_no').on(t.tenantId, t.no),
  uniqueIndex('stock_docs_vendor_invoice').on(t.tenantId, t.vendorId, t.vendorInvoiceNo),
]);

/** BR-21: FIFO lots. remaining >= 0 is the last line of defence for BR-07. */
export const stockLots = pgTable('stock_lots', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: tenantId(),
  productId: uuid('product_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  qtyIn: qty('qty_in').notNull(),
  remaining: qty('remaining').notNull(),
  unitCost: qty('unit_cost').notNull(),
  ref: text('ref').notNull(),
  sourceLotId: bigint('source_lot_id', { mode: 'number' }),
  createdAt: createdAt(),
}, (t) => [
  index('stock_lots_pw').on(t.tenantId, t.productId, t.warehouseId, t.receivedAt, t.id),
  check('stock_lots_remaining_nonneg', sql`${t.remaining} >= 0`),
  check('stock_lots_remaining_le_in', sql`${t.remaining} <= ${t.qtyIn}`),
]);

/** Stock ledger: signed qty per product / warehouse per document. */
export const stockMoves = pgTable('stock_moves', {
  id: id(),
  tenantId: tenantId(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  docType: text('doc_type').notNull(),
  docNo: text('doc_no').notNull(),
  docId: uuid('doc_id').notNull(),
  docLineId: uuid('doc_line_id'),
  productId: uuid('product_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  qty: qty('qty').notNull(),
  cost: money('cost').notNull(),
  note: text('note').notNull().default(''),
  userId: uuid('user_id').notNull(),
}, (t) => [index('stock_moves_doc').on(t.tenantId, t.docId), index('stock_moves_line').on(t.tenantId, t.docLineId)]);

/** BR-21: which lot / qty / unit cost each move consumed or restored. */
export const stockMoveLots = pgTable('stock_move_lots', {
  id: id(),
  tenantId: tenantId(),
  moveId: uuid('move_id').notNull(),
  lotId: bigint('lot_id', { mode: 'number' }).notNull(),
  qty: qty('qty').notNull(),
  unitCost: qty('unit_cost').notNull(),
}, (t) => [index('stock_move_lots_move').on(t.tenantId, t.moveId)]);

export const adjustRequests = pgTable('adjust_requests', {
  id: id(),
  tenantId: tenantId(),
  no: text('no').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  lines: jsonb('lines').notNull(),
  reason: text('reason').notNull(),
  status: text('status').notNull().default('pending'),
  requestedBy: uuid('requested_by').notNull(),
  decidedBy: uuid('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  resultDocNo: text('result_doc_no'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('adjust_requests_tenant_no').on(t.tenantId, t.no),
  check('adjust_requests_status', sql`${t.status} in ('pending','approved','rejected')`),
]);

/** On-prem client pairing (GET /pair?code=). */
export const pairingCodes = pgTable('pairing_codes', {
  id: id(),
  tenantId: tenantId(),
  code: text('code').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [index('pairing_codes_code').on(t.code)]);

export const devices = pgTable('devices', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  pairedAt: timestamp('paired_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

/** BR-18: append-only, hash-chained per tenant (trigger fills prev_hash / hash). */
export const auditLog = pgTable('audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: tenantId(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  userId: uuid('user_id'),
  userName: text('user_name').notNull(),
  action: text('action').notNull(),
  object: text('object').notNull(),
  ref: text('ref'),
  detail: text('detail').notNull().default(''),
  /** Position in this tenant's hash chain (assigned by the trigger under a per-tenant lock). */
  chainSeq: bigint('chain_seq', { mode: 'number' }),
  prevHash: text('prev_hash'),
  hash: text('hash'),
}, (t) => [index('audit_log_tenant_id').on(t.tenantId, t.id)]);

/** Tables that carry tenant_id and get the RLS policy (kept in sync with 0001_rls_triggers.sql). */
export const TENANT_TABLES = [
  'users', 'warehouses', 'products', 'customers', 'vendors', 'doc_counters', 'shifts', 'shift_moves', 'docs', 'doc_lines',
  'stock_docs', 'stock_lots', 'stock_moves', 'stock_move_lots', 'adjust_requests', 'pairing_codes', 'devices', 'audit_log',
] as const;
