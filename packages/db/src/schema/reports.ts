/**
 * Drizzle table definitions for the "reports" module group, owned by Agent E (reports): M11 reports, M12 PEAK/FlowAccount/Express export. Migrations 0500-0599.
 *
 * Every table here is created by a SQL migration in this module's range (packages/db/MIGRATIONS.md) and secured
 * there with `SELECT erp_secure_table('<table>', <is_document>);`. Use the column helpers from ./columns so the
 * conventions (tenant_id, money numeric(14,2), qty numeric(14,4), timestamptz) stay uniform. Example:
 *
 *   export const arReceipts = pgTable('ar_receipts', { id: id(), tenantId: tenantId(), no: text('no').notNull(), total: money('total').notNull(), createdAt: createdAt() });
 */
export {};
