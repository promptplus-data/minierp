/**
 * Drizzle table definitions for the "admin" module group, owned by Agent D (admin): M17 HR/payroll/leave, M14 SCG Admin, M19-07 export/import, M19-09 cloud backup, M19-10 sales-summary share, M19-11 license verification. Migrations 0400-0499.
 *
 * Every table here is created by a SQL migration in this module's range (packages/db/MIGRATIONS.md) and secured
 * there with `SELECT erp_secure_table('<table>', <is_document>);`. Use the column helpers from ./columns so the
 * conventions (tenant_id, money numeric(14,2), qty numeric(14,4), timestamptz) stay uniform. Example:
 *
 *   export const arReceipts = pgTable('ar_receipts', { id: id(), tenantId: tenantId(), no: text('no').notNull(), total: money('total').notNull(), createdAt: createdAt() });
 */
export {};
