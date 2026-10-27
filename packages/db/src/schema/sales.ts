/**
 * Drizzle table definitions for the "sales" module group, owned by Agent A (sales): M08 quotation/SO/DO/invoice/credit approval, M10 AR (billing note, receipts, WHT, aging), M09 projects. Migrations 0100-0199.
 *
 * Every table here is created by a SQL migration in this module's range (packages/db/MIGRATIONS.md) and secured
 * there with `SELECT erp_secure_table('<table>', <is_document>);`. Use the column helpers from ./columns so the
 * conventions (tenant_id, money numeric(14,2), qty numeric(14,4), timestamptz) stay uniform. Example:
 *
 *   export const arReceipts = pgTable('ar_receipts', { id: id(), tenantId: tenantId(), no: text('no').notNull(), total: money('total').notNull(), createdAt: createdAt() });
 */
export {};
