/**
 * Drizzle table definitions for the "reports" module group (M11 reports, M12 accounting export).
 * Created by migrations/0500_reports_export.sql; keep in sync.
 */
import { boolean, customType, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, tenantId } from './columns';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

/** Shop GL mapping used by every export (one row per tenant; missing = defaults). */
export const reportGlMap = pgTable('report_gl_map', {
  tenantId: uuid('tenant_id').primaryKey(),
  sale: text('sale').notNull().default('410101'),
  buy: text('buy').notNull().default('114102'),
  cogs: text('cogs').notNull().default('510103'),
  pdisc: text('pdisc').notNull().default('510104'),
  ar: text('ar').notNull().default('113101'),
  ap: text('ap').notNull().default('212101'),
  vatOut: text('vat_out').notNull().default('215101'),
  vatIn: text('vat_in').notNull().default('115101'),
  cash: text('cash').notNull().default('111101'),
  coupon: text('coupon').notNull().default('410901'),
  deposit: text('deposit').notNull().default('217101'),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Export history (REQ-M12-04). Never deleted. */
export const exportRuns = pgTable('export_runs', {
  id: id(),
  tenantId: tenantId(),
  template: text('template').notNull(),
  dataset: text('dataset').notNull(),
  format: text('format').notNull().default('csv'),
  dateFrom: date('date_from'),
  dateTo: date('date_to'),
  onlyNew: boolean('only_new').notNull().default(false),
  rows: integer('rows').notNull(),
  docs: integer('docs').notNull().default(0),
  files: integer('files').notNull(),
  warnings: jsonb('warnings').notNull().default([]),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
}, (t) => [index('export_runs_tenant_created').on(t.tenantId, t.createdAt, t.id)]);

export const exportFiles = pgTable('export_files', {
  id: id(),
  tenantId: tenantId(),
  runId: uuid('run_id').notNull(),
  seq: integer('seq').notNull(),
  name: text('name').notNull(),
  contentType: text('content_type').notNull(),
  rows: integer('rows').notNull(),
  content: bytea('content').notNull(),
}, (t) => [unique().on(t.runId, t.seq)]);

export const exportRunDocs = pgTable('export_run_docs', {
  tenantId: tenantId(),
  runId: uuid('run_id').notNull(),
  source: text('source').notNull(),
  docId: uuid('doc_id').notNull(),
  docNo: text('doc_no').notNull(),
}, (t) => [primaryKey({ columns: [t.runId, t.source, t.docId] })]);
