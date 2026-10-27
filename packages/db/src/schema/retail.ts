/**
 * Drizzle table definitions for the "retail" module group, owned by Agent C (retail): M15 promotions (discount + bundle in POS), M16 production (BOM/MO), held bills, customer price lists. Migrations 0300-0399.
 *
 * Every table here is created by a SQL migration in this module's range (packages/db/MIGRATIONS.md) and secured
 * there with `SELECT erp_secure_table('<table>', <is_document>);`. Use the column helpers from ./columns so the
 * conventions (tenant_id, money numeric(14,2), qty numeric(14,4), timestamptz) stay uniform. Example:
 *
 *   export const arReceipts = pgTable('ar_receipts', { id: id(), tenantId: tenantId(), no: text('no').notNull(), total: money('total').notNull(), createdAt: createdAt() });
 */
export {};
