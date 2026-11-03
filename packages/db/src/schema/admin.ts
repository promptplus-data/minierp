/**
 * Drizzle table definitions for the "admin" module group (Agent D): M17 HR/payroll/leave, M02 terms, M14 SCG Admin,
 * M19-07/09/10/11. Typing only: the tables are created by migrations 0400–0404 (keep in sync). Shop tables carry
 * tenant_id and are secured with erp_secure_table(); the platform tables (platform_admins, platform_audit,
 * central_*, license_registry, sales_share_inbox) are global and readable only in SCG Admin context (0401/0402).
 * Columns added to core tables: tenants.adm_status, adm_status_reason, adm_edition, adm_region, adm_customer_code,
 * adm_terms_required; products.adm_central_id, adm_srp, adm_price_custom.
 */
import { bigint, boolean, date, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, money, tenantId } from './columns';

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const admSettings = pgTable('adm_settings', {
  tenantId: uuid('tenant_id').primaryKey(),
  ssoRate: numeric('sso_rate', { precision: 6, scale: 4 }).notNull(),
  ssoCap: money('sso_cap').notNull(),
  ssoFloor: money('sso_floor').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const employees = pgTable('employees', {
  id: id(), tenantId: tenantId(),
  code: text('code').notNull(), name: text('name').notNull(), position: text('position').notNull().default(''),
  empType: text('emp_type').notNull().default('monthly'), startDate: date('start_date').notNull(),
  salary: money('salary').notNull(), dailyRate: money('daily_rate').notNull(), commissionPct: numeric('commission_pct', { precision: 6, scale: 2 }).notNull(),
  sso: boolean('sso').notNull().default(true), bankAccount: text('bank_account').notNull().default(''), nationalId: text('national_id').notNull().default(''),
  phone: text('phone').notNull().default(''), leaveEnt: jsonb('leave_ent').notNull(),
  status: text('status').notNull().default('active'), resignedAt: date('resigned_at'), resignReason: text('resign_reason'),
  userId: uuid('user_id'), createdBy: uuid('created_by'), createdAt: createdAt(), updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const leaveRequests = pgTable('leave_requests', {
  id: id(), tenantId: tenantId(), no: text('no').notNull(), employeeId: uuid('employee_id').notNull(), leaveType: text('leave_type').notNull(),
  fromDate: date('from_date').notNull(), toDate: date('to_date').notNull(), halfDay: boolean('half_day').notNull().default(false),
  days: numeric('days', { precision: 6, scale: 1 }).notNull(), reason: text('reason').notNull().default(''),
  overDays: numeric('over_days', { precision: 6, scale: 1 }).notNull().default('0'), deduct: boolean('deduct').notNull().default(false),
  status: text('status').notNull().default('pending'), requestedBy: uuid('requested_by').notNull(), decidedBy: uuid('decided_by'),
  decidedAt: ts('decided_at'), decideNote: text('decide_note'), createdAt: createdAt(),
});

export const payrollRuns = pgTable('payroll_runs', {
  id: id(), tenantId: tenantId(), period: text('period').notNull(), status: text('status').notNull().default('draft'),
  ssoRate: numeric('sso_rate', { precision: 6, scale: 4 }).notNull(), ssoCap: money('sso_cap').notNull(), ssoFloor: money('sso_floor').notNull(),
  createdBy: uuid('created_by').notNull(), createdAt: createdAt(), approvedBy: uuid('approved_by'), approvedAt: ts('approved_at'),
  paidBy: uuid('paid_by'), paidAt: ts('paid_at'), payDate: date('pay_date'),
});

export const payrollLines = pgTable('payroll_lines', {
  id: id(), tenantId: tenantId(), runId: uuid('run_id').notNull(), employeeId: uuid('employee_id').notNull(),
  empCode: text('emp_code').notNull(), empName: text('emp_name').notNull(), empPosition: text('emp_position').notNull(), empType: text('emp_type').notNull(),
  bankAccount: text('bank_account').notNull(), pay: text('pay').notNull(), rate: money('rate').notNull(),
  commissionPct: numeric('commission_pct', { precision: 6, scale: 2 }).notNull(), ssoEnrolled: boolean('sso_enrolled').notNull(),
  days: numeric('days', { precision: 6, scale: 1 }).notNull(), ot: money('ot').notNull(), allowance: money('allowance').notNull(), advance: money('advance').notNull(),
  taxOverride: money('tax_override'), unpaidDays: numeric('unpaid_days', { precision: 6, scale: 1 }).notNull(), commissionBase: money('commission_base').notNull(),
  base: money('base').notNull(), commission: money('commission').notNull(), unpaidAmt: money('unpaid_amt').notNull(), gross: money('gross').notNull(),
  sso: money('sso').notNull(), tax: money('tax').notNull(), net: money('net').notNull(),
});

export const termsAcceptances = pgTable('terms_acceptances', {
  id: id(), tenantId: tenantId(), version: text('version').notNull(), signerName: text('signer_name').notNull(), signerTitle: text('signer_title').notNull(),
  consents: jsonb('consents').notNull(), acceptedBy: uuid('accepted_by').notNull(), ip: text('ip'), acceptedAt: ts('accepted_at').notNull().defaultNow(),
});

export const licenses = pgTable('licenses', {
  id: id(), tenantId: tenantId(), licenseId: text('license_id').notNull(), licenseKey: text('license_key').notNull(), shopName: text('shop_name').notNull(),
  taxId: text('tax_id').notNull(), edition: text('edition').notNull(), keyType: text('key_type').notNull(), expiresAt: date('expires_at'),
  issuedAt: ts('issued_at').notNull(), installedAt: ts('installed_at').notNull().defaultNow(), installedBy: uuid('installed_by'),
});

export const salesShares = pgTable('sales_shares', {
  id: id(), tenantId: tenantId(), fromDate: date('from_date').notNull(), toDate: date('to_date').notNull(), payload: jsonb('payload').notNull(),
  status: text('status').notNull(), error: text('error'), receiptId: text('receipt_id'), sentBy: uuid('sent_by').notNull(), sentAt: ts('sent_at').notNull().defaultNow(),
});

export const backupConfig = pgTable('backup_config', {
  tenantId: uuid('tenant_id').primaryKey(), enabled: boolean('enabled').notNull().default(false), provider: text('provider'),
  settings: jsonb('settings').notNull(), keySalt: text('key_salt'), derivedKey: text('derived_key'), schedule: text('schedule').notNull().default('daily'),
  lastSuccessAt: ts('last_success_at'), lastFailureAt: ts('last_failure_at'), lastError: text('last_error'), lastFile: text('last_file'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const backupRuns = pgTable('backup_runs', {
  id: id(), tenantId: tenantId(), at: ts('at').notNull().defaultNow(), provider: text('provider').notNull(), trigger: text('trigger').notNull(),
  fileName: text('file_name'), bytes: bigint('bytes', { mode: 'number' }), status: text('status').notNull(), error: text('error'), userId: uuid('user_id'),
});

export const supportGrants = pgTable('support_grants', {
  id: id(), tenantId: tenantId(), grantedBy: uuid('granted_by').notNull(), note: text('note').notNull().default(''), expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'), revokedBy: uuid('revoked_by'), createdAt: createdAt(),
});

// ---------- global SCG Admin tables (no tenant_id; platform context only) ----------
export const platformAdmins = pgTable('platform_admins', {
  id: id(), username: text('username').notNull().unique(), name: text('name').notNull(), role: text('role').notNull(), passwordHash: text('password_hash').notNull(),
  status: text('status').notNull().default('active'), failedLogins: integer('failed_logins').notNull().default(0), lockedAt: ts('locked_at'),
  lastLoginAt: ts('last_login_at'), createdAt: createdAt(),
});

export const platformAudit = pgTable('platform_audit', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(), at: ts('at').notNull().defaultNow(), adminId: uuid('admin_id'),
  adminName: text('admin_name').notNull(), action: text('action').notNull(), object: text('object').notNull(), ref: text('ref'), detail: text('detail').notNull().default(''),
});

export const centralProducts = pgTable('central_products', {
  id: id(), sku: text('sku').notNull().unique(), name: text('name').notNull(), category: text('category').notNull().default(''), units: jsonb('units').notNull(),
  barcode: text('barcode'), imageUrl: text('image_url'), vat: text('vat').notNull().default('v7'), active: boolean('active').notNull().default(true),
  createdBy: text('created_by').notNull(), createdAt: createdAt(), updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const centralPrices = pgTable('central_prices', {
  id: id(), productId: uuid('product_id').notNull(), retail: money('retail').notNull(), wholesale: money('wholesale').notNull(),
  effectiveFrom: date('effective_from').notNull(), pushedAt: ts('pushed_at'), createdBy: text('created_by').notNull(), createdAt: createdAt(),
});

export const centralPushes = pgTable('central_pushes', {
  id: id(), at: ts('at').notNull().defaultNow(), what: text('what').notNull(), products: integer('products').notNull(), shops: integer('shops').notNull(),
  target: text('target').notNull(), byName: text('by_name').notNull(),
});

export const licenseRegistry = pgTable('license_registry', {
  licenseId: text('license_id').primaryKey(), licenseKey: text('license_key').notNull(), shopName: text('shop_name').notNull(), taxId: text('tax_id').notNull(),
  edition: text('edition').notNull(), keyType: text('key_type').notNull(), expiresAt: date('expires_at'), issuedAt: ts('issued_at').notNull(),
  region: text('region').notNull().default(''), note: text('note').notNull().default(''), issuedBy: text('issued_by').notNull(),
  revokedAt: ts('revoked_at'), revokedBy: text('revoked_by'),
});

export const salesShareInbox = pgTable('sales_share_inbox', {
  id: id(), licenseId: text('license_id').notNull(), shopName: text('shop_name').notNull(), taxId: text('tax_id').notNull(),
  fromDate: date('from_date').notNull(), toDate: date('to_date').notNull(), payload: jsonb('payload').notNull(), total: money('total').notNull(),
  receivedAt: ts('received_at').notNull().defaultNow(),
});
