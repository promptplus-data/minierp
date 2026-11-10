/**
 * Drizzle table definitions for the "purchasing" module group (Agent B): M18 AP, payment vouchers, vendor returns,
 * GR lines, M04 Import Hub, M19-08 delivery-file drafts, stock counts. Created by migrations/0200_purchasing.sql
 * (typing only; keep in sync with the SQL).
 */
import { bigint, boolean, date, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, money, qty, tenantId } from './columns';

export const purchasingSettings = pgTable('purchasing_settings', {
  tenantId: uuid('tenant_id').primaryKey(),
  billDiscountMode: text('bill_discount_mode').notNull().default('sep'),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const grLines = pgTable('gr_lines', {
  id: id(), tenantId: tenantId(),
  grDocId: uuid('gr_doc_id').notNull(), grNo: text('gr_no').notNull(), lineNo: integer('line_no').notNull(),
  productId: uuid('product_id').notNull(), warehouseId: uuid('warehouse_id').notNull(),
  unitIdx: integer('unit_idx').notNull(), unitName: text('unit_name').notNull(), unitFactor: qty('unit_factor').notNull(),
  qty: qty('qty').notNull(), baseQty: qty('base_qty').notNull(), unitPrice: qty('unit_price').notNull(), amount: money('amount').notNull(),
  lotUnitCost: qty('lot_unit_cost').notNull(), lotId: bigint('lot_id', { mode: 'number' }).notNull(),
  returnedBaseQty: qty('returned_base_qty').notNull().default('0'),
});

export const apBills = pgTable('ap_bills', {
  id: id(), tenantId: tenantId(), no: text('no').notNull(), source: text('source').notNull(),
  vendorId: uuid('vendor_id').notNull(), vendorInvoiceNo: text('vendor_invoice_no').notNull(),
  grDocId: uuid('gr_doc_id'), grNo: text('gr_no'), date: date('date').notNull(), dueDate: date('due_date').notNull(),
  base: money('base').notNull(), discount: money('discount').notNull().default('0'), discountMode: text('discount_mode').notNull().default('sep'),
  vat: money('vat').notNull().default('0'), total: money('total').notNull(), paid: money('paid').notNull().default('0'), returned: money('returned').notNull().default('0'),
  status: text('status').notNull().default('active'), createdBy: uuid('created_by').notNull(), createdAt: createdAt(),
  note: text('note').notNull().default(''), // 0640
});

export const apPayments = pgTable('ap_payments', {
  id: id(), tenantId: tenantId(), no: text('no').notNull(), date: date('date').notNull(), vendorId: uuid('vendor_id').notNull(),
  method: text('method').notNull(), ref: text('ref'), amount: money('amount').notNull(), whtRate: numeric('wht_rate', { precision: 5, scale: 2 }).notNull().default('0'),
  wht: money('wht').notNull().default('0'), net: money('net').notNull(), note: text('note'), status: text('status').notNull().default('active'),
  createdBy: uuid('created_by').notNull(), createdAt: createdAt(),
});

export const apPaymentAllocs = pgTable('ap_payment_allocs', {
  id: id(), tenantId: tenantId(), paymentId: uuid('payment_id').notNull(), billId: uuid('bill_id').notNull(), amount: money('amount').notNull(),
});

export const vendorReturns = pgTable('vendor_returns', {
  id: id(), tenantId: tenantId(), no: text('no').notNull(), date: date('date').notNull(), vendorId: uuid('vendor_id').notNull(),
  grDocId: uuid('gr_doc_id').notNull(), grNo: text('gr_no').notNull(), apBillId: uuid('ap_bill_id'), reason: text('reason').notNull(), vendorCnNo: text('vendor_cn_no'),
  base: money('base').notNull(), vat: money('vat').notNull(), total: money('total').notNull(), apApplied: money('ap_applied').notNull(), unapplied: money('unapplied').notNull().default('0'),
  cogs: money('cogs').notNull(), createdBy: uuid('created_by').notNull(), createdAt: createdAt(),
  note: text('note').notNull().default(''), // 0640
});

export const vendorReturnLines = pgTable('vendor_return_lines', {
  id: id(), tenantId: tenantId(), returnId: uuid('return_id').notNull(), grLineId: uuid('gr_line_id').notNull(), productId: uuid('product_id').notNull(),
  qty: qty('qty').notNull(), baseQty: qty('base_qty').notNull(), unitPrice: qty('unit_price').notNull(), amount: money('amount').notNull(), cogs: money('cogs').notNull(),
});

export const importProfiles = pgTable('import_profiles', {
  id: id(), tenantId: tenantId(), kind: text('kind').notNull(), name: text('name').notNull(), headerSignature: text('header_signature').notNull(),
  mapping: jsonb('mapping').notNull(), encoding: text('encoding'), delimiter: text('delimiter'), vatFlagDefault: text('vat_flag_default'), vendorId: uuid('vendor_id'),
  active: boolean('active').notNull().default(true), createdBy: uuid('created_by').notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const productCodeAliases = pgTable('product_code_aliases', {
  id: id(), tenantId: tenantId(), vendorId: uuid('vendor_id'), externalCode: text('external_code').notNull(), productId: uuid('product_id').notNull(),
  unitMap: jsonb('unit_map').notNull().default({}), active: boolean('active').notNull().default(true), createdBy: uuid('created_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const importBatches = pgTable('import_batches', {
  id: id(), tenantId: tenantId(), no: text('no').notNull(), kind: text('kind').notNull(), mode: text('mode').notNull(), source: text('source').notNull(),
  fileName: text('file_name').notNull(), fileSha256: text('file_sha256').notNull(), rowsTotal: integer('rows_total').notNull(),
  rowsCreated: integer('rows_created').notNull().default(0), rowsUpdated: integer('rows_updated').notNull().default(0),
  rowsSkipped: integer('rows_skipped').notNull().default(0), rowsError: integer('rows_error').notNull().default(0),
  createdBy: uuid('created_by').notNull(), createdAt: createdAt(),
  note: text('note').notNull().default(''), // 0640
});

export const importKeys = pgTable('import_keys', {
  tenantId: tenantId(), kind: text('kind').notNull(), key: text('key').notNull(), batchId: uuid('batch_id').notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.kind, t.key] })]);

export const arOpeningBalances = pgTable('ar_opening_balances', {
  id: id(), tenantId: tenantId(), customerId: uuid('customer_id').notNull(), docNo: text('doc_no').notNull(), date: date('date').notNull(),
  dueDate: date('due_date').notNull(), amount: money('amount').notNull(), balance: money('balance').notNull(), batchId: uuid('batch_id').notNull(), createdAt: createdAt(),
});

export const grDrafts = pgTable('gr_drafts', {
  id: id(), tenantId: tenantId(), batchId: uuid('batch_id'), dnNo: text('dn_no'), poNo: text('po_no'), invoiceNo: text('invoice_no'), dealerName: text('dealer_name'),
  vendorId: uuid('vendor_id'), warehouseId: uuid('warehouse_id'), deliveryDate: date('delivery_date'), receivedOn: date('received_on').notNull(),
  vatFlag: text('vat_flag').notNull().default('exc'), status: text('status').notNull().default('draft'), confirmedDocId: uuid('confirmed_doc_id'), confirmedNo: text('confirmed_no'),
  shortReason: text('short_reason'), forceReason: text('force_reason'), createdBy: uuid('created_by').notNull(), createdAt: createdAt(),
});

export const grDraftLines = pgTable('gr_draft_lines', {
  id: id(), tenantId: tenantId(), draftId: uuid('draft_id').notNull(), lineNo: integer('line_no').notNull(), rowNo: integer('row_no').notNull(),
  externalCode: text('external_code').notNull(), externalName: text('external_name').notNull(), unitText: text('unit_text').notNull(),
  qty: qty('qty').notNull(), unitPrice: qty('unit_price').notNull(), lineDiscount: money('line_discount').notNull().default('0'),
  productId: uuid('product_id'), unitIdx: integer('unit_idx'), receivedQty: qty('received_qty'), damagedQty: qty('damaged_qty').notNull().default('0'),
  warnings: jsonb('warnings').notNull().default([]),
});

export const stockCounts = pgTable('stock_counts', {
  id: id(), tenantId: tenantId(), no: text('no').notNull(), warehouseId: uuid('warehouse_id').notNull(), category: text('category'),
  status: text('status').notNull().default('counting'), openedBy: uuid('opened_by').notNull(), openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  submittedBy: uuid('submitted_by'), submittedAt: timestamp('submitted_at', { withTimezone: true }), adjustRequestId: uuid('adjust_request_id'), adjustRequestNo: text('adjust_request_no'),
  note: text('note'), round: integer('round').notNull().default(1),
});

export const stockCountLines = pgTable('stock_count_lines', {
  id: id(), tenantId: tenantId(), countId: uuid('count_id').notNull(), productId: uuid('product_id').notNull(), systemQty: qty('system_qty').notNull(),
  countedQty: qty('counted_qty'), movedQty: qty('moved_qty'), countedBy: uuid('counted_by'), countedAt: timestamp('counted_at', { withTimezone: true }),
  state: text('state').notNull().default('counting'), round: integer('round').notNull().default(1), prevCountedQty: qty('prev_counted_qty'), adjustRequestId: uuid('adjust_request_id'),
});
