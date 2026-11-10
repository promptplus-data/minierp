/**
 * API contract for the "admin" module group — Agent D (admin): M17 HR/payroll/leave, M14 SCG Admin, M19-07/09/10/11.
 * Every name is prefixed (Hr*, Adm*, License*, Backup*, Share*, Support*) because it is re-exported from '@erp/contracts'.
 * Keep the cloud-integration names of the other team out of this file (scripts/check-onprem.mjs).
 */
import { z } from 'zod';
import { Dec, DecNN, Role, pageQuery, type RouteEditions } from '../core';

const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const Period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM');

// =====================================================================================================
// M17 HR
// =====================================================================================================
export const HrEmpType = z.enum(['monthly', 'daily', 'parttime', 'external', 'owner']);
export type HrEmpType = z.infer<typeof HrEmpType>;
export const HrLeaveType = z.enum(['sick', 'personal', 'vacation', 'maternity', 'other', 'unpaid']);
export type HrLeaveType = z.infer<typeof HrLeaveType>;
export const HrLeaveEnt = z.object({
  sick: z.number().min(0).max(366), personal: z.number().min(0).max(366), vacation: z.number().min(0).max(366),
  maternity: z.number().min(0).max(366), other: z.number().min(0).max(366),
});
export type HrLeaveEnt = z.infer<typeof HrLeaveEnt>;

export const HrEmployee = z.object({
  id: z.string(), code: z.string(), name: z.string(), position: z.string(), type: HrEmpType, startDate: z.string(),
  // pay fields are null when the caller lacks hr.salary
  salary: Dec.nullable(), dailyRate: Dec.nullable(), commissionPct: Dec.nullable(), sso: z.boolean(),
  bankAccount: z.string(), nationalId: z.string(), phone: z.string(), leaveEnt: HrLeaveEnt,
  status: z.enum(['active', 'resigned']), resignedAt: z.string().nullable(), resignReason: z.string().nullable(),
  user: z.object({ id: z.string(), username: z.string(), role: Role, status: z.string() }).nullable(),
});
export type HrEmployee = z.infer<typeof HrEmployee>;
export const HrEmployeeQuery = pageQuery.extend({ status: z.enum(['active', 'resigned', 'all']).default('all') });

const HrEmployeeFields = z.object({
  code: z.string().trim().max(20).optional(), name: z.string().trim().min(1), position: z.string().default(''),
  type: HrEmpType.default('monthly'), startDate: YMD,
  salary: DecNN.default('0'), dailyRate: DecNN.default('0'), commissionPct: DecNN.default('0'), sso: z.boolean().default(true),
  bankAccount: z.string().default(''), nationalId: z.string().default(''), phone: z.string().default(''),
  leaveEnt: HrLeaveEnt.optional(),
});
/** REQ-M17-01 + REQ-M01-10: the login user is created together with the employee (or not at all). */
export const HrEmployeeCreate = HrEmployeeFields.extend({
  user: z.object({
    username: z.string().regex(/^[a-z0-9._]{3,20}$/, 'a-z 0-9 . _ 3-20'),
    role: Role.exclude(['owner']),
    password: z.string().min(4).optional(), // omitted: a temporary password is generated and returned once
    pin: z.string().regex(/^\d{4,6}$/).optional(),
  }).optional(),
});
export const HrEmployeeUpdate = HrEmployeeFields.partial().extend({ role: Role.exclude(['owner']).optional() });
export const HrEmployeeCreated = z.object({ employee: HrEmployee, tempPassword: z.string().nullable() });
export const HrResignReq = z.object({ date: YMD, reason: z.string().min(1) });

export const HrSettings = z.object({ ssoRate: Dec, ssoCap: Dec, ssoFloor: Dec });
export const HrSettingsUpdate = z.object({ ssoRate: DecNN.optional(), ssoCap: DecNN.optional(), ssoFloor: DecNN.optional() });

export const HrLeave = z.object({
  id: z.string(), no: z.string(), employeeId: z.string(), employeeName: z.string(), type: HrLeaveType,
  fromDate: z.string(), toDate: z.string(), halfDay: z.boolean(), days: Dec, reason: z.string(), note: z.string().default(''),
  overDays: Dec, deduct: z.boolean(), status: z.enum(['pending', 'approved', 'rejected']),
  requestedBy: z.string(), decidedBy: z.string().nullable(), decidedAt: z.string().nullable(), createdAt: z.string(),
});
export type HrLeave = z.infer<typeof HrLeave>;
export const HrLeaveQuery = pageQuery.extend({ status: z.enum(['pending', 'approved', 'rejected']).optional(), employeeId: z.string().optional() });
export const HrLeaveCreate = z.object({
  employeeId: z.string().optional(), // default: the caller's own employee record
  type: HrLeaveType, fromDate: YMD, toDate: YMD, halfDay: z.boolean().default(false), reason: z.string().default(''), note: z.string().max(500).optional(),
  deduct: z.boolean().default(false), // over-entitlement days are deducted from pay
});
export const HrLeaveDecide = z.object({ deduct: z.boolean().optional(), note: z.string().optional() });
export const HrLeaveBalanceRow = z.object({
  employeeId: z.string(), code: z.string(), name: z.string(), position: z.string(),
  balances: z.array(z.object({ type: HrLeaveType, entitled: z.number(), used: Dec, remaining: Dec })),
  unpaid: Dec,
});
export const HrLeaveCreated = z.object({ leave: HrLeave, warning: z.string().nullable() });

export const HrPayrollStatus = z.enum(['draft', 'approved', 'paid']);
export const HrPayrollLine = z.object({
  id: z.string(), employeeId: z.string(), code: z.string(), name: z.string(), position: z.string(), type: HrEmpType, bankAccount: z.string(),
  pay: z.enum(['monthly', 'daily']), rate: Dec, commissionPct: Dec, ssoEnrolled: z.boolean(),
  days: Dec, ot: Dec, allowance: Dec, advance: Dec, taxOverride: Dec.nullable(), unpaidDays: Dec, commissionBase: Dec,
  base: Dec, commission: Dec, unpaidAmt: Dec, gross: Dec, sso: Dec, tax: Dec, net: Dec,
});
export type HrPayrollLine = z.infer<typeof HrPayrollLine>;
export const HrPayrollTotals = z.object({ base: Dec, ot: Dec, allowance: Dec, commission: Dec, unpaidAmt: Dec, gross: Dec, sso: Dec, tax: Dec, advance: Dec, net: Dec, employerSso: Dec });
export const HrPayrollRun = z.object({
  id: z.string(), period: z.string(), status: HrPayrollStatus, ssoRate: Dec, ssoCap: Dec, ssoFloor: Dec,
  createdBy: z.string(), createdAt: z.string(), approvedBy: z.string().nullable(), approvedAt: z.string().nullable(),
  paidBy: z.string().nullable(), paidAt: z.string().nullable(), payDate: z.string().nullable(),
  note: z.string().default(''),
  /** Payslips are published to employees (and openable) once the run is paid. */
  published: z.boolean().default(false),
  totals: HrPayrollTotals, lines: z.array(HrPayrollLine),
});
export type HrPayrollRun = z.infer<typeof HrPayrollRun>;
export const HrPayrollSummary = HrPayrollRun.omit({ lines: true }).extend({ headcount: z.number() });
export const HrPayrollCreate = z.object({ period: Period, note: z.string().max(500).optional() });
export const HrPayrollUpdate = z.object({ note: z.string().max(500) });
export const HrPayslipPeriodQuery = z.object({ period: Period.optional(), limit: z.coerce.number().int().min(1).max(60).default(24) });
export const HrPayslipPeriods = z.object({
  employeeId: z.string().nullable(),
  items: z.array(z.object({ period: z.string(), exists: z.boolean(), status: HrPayrollStatus.nullable(), published: z.boolean(), payDate: z.string().nullable() })),
});
export type HrPayslipPeriods = z.infer<typeof HrPayslipPeriods>;
export const HrPayrollLineUpdate = z.object({
  days: DecNN.optional(), ot: DecNN.optional(), allowance: DecNN.optional(), advance: DecNN.optional(), tax: DecNN.nullable().optional(),
});
export const HrPayrollPay = z.object({ payDate: YMD.optional() });

/** Printable payslip (REQ-M17-03). */
export const HrPayslip = z.object({
  no: z.string(), period: z.string(), periodLabel: z.string(), status: HrPayrollStatus, payDate: z.string().nullable(),
  shop: z.object({ name: z.string(), taxId: z.string(), branch: z.string(), address: z.string(), phone: z.string() }),
  employee: z.object({ id: z.string(), code: z.string(), name: z.string(), position: z.string(), type: HrEmpType, bankAccount: z.string() }),
  earnings: z.array(z.object({ label: z.string(), amount: Dec })),
  deductions: z.array(z.object({ label: z.string(), amount: Dec })),
  gross: Dec, totalDeductions: Dec, net: Dec, netText: z.string(),
});
export type HrPayslip = z.infer<typeof HrPayslip>;
export const HrLabourCostQuery = z.object({ from: Period.optional(), to: Period.optional() });
export const HrLabourCostRow = z.object({ period: z.string(), status: HrPayrollStatus, headcount: z.number(), gross: Dec, employerSso: Dec, total: Dec });
export const HrMe = z.object({ employee: HrEmployee.nullable(), canManage: z.boolean() });

// =====================================================================================================
// M19-11 license (on-prem verification; issuing is SCG Admin below)
// =====================================================================================================
export const LicenseType = z.enum(['expiring', 'lifetime']);
export const LicensePayload = z.object({
  v: z.literal(1), licenseId: z.string(), shopName: z.string(), taxId: z.string(), edition: z.enum(['onprem', 'cloud']),
  type: LicenseType, expiresAt: YMD.nullable(), issuedAt: z.string(),
});
export type LicensePayload = z.infer<typeof LicensePayload>;
export const LicenseStatus = z.object({
  state: z.enum(['none', 'valid', 'expiring', 'expired']),
  readOnly: z.boolean(), required: z.boolean(), daysLeft: z.number().nullable(),
  license: LicensePayload.nullable(), installedAt: z.string().nullable(),
});
export type LicenseStatus = z.infer<typeof LicenseStatus>;
export const LicenseInstall = z.object({ key: z.string().min(20) });

// =====================================================================================================
// M19-07 export (on-prem) / import (SCG Admin)
// =====================================================================================================
export const ShopExportReq = z.object({ passphrase: z.string().min(8) });

// =====================================================================================================
// M19-09 cloud backup (on-prem)
// =====================================================================================================
export const BackupProvider = z.enum(['s3', 'gdrive', 'onedrive']);
export type BackupProvider = z.infer<typeof BackupProvider>;
export const BackupS3Settings = z.object({
  endpoint: z.string().url().optional(), region: z.string().min(1).default('ap-southeast-1'), bucket: z.string().min(1),
  prefix: z.string().default('scg-erp/'), accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1).optional(),
  forcePathStyle: z.boolean().default(true),
});
export const BackupConfig = z.object({
  enabled: z.boolean(), provider: BackupProvider.nullable(), schedule: z.enum(['off', 'daily']),
  // secrets are never returned: only whether they are set
  s3: BackupS3Settings.omit({ secretAccessKey: true }).extend({ hasSecret: z.boolean() }).nullable(),
  oauth: z.object({ connected: z.boolean(), account: z.string().nullable() }).nullable(),
  hasPassphrase: z.boolean(), lastSuccessAt: z.string().nullable(), lastFailureAt: z.string().nullable(),
  lastError: z.string().nullable(), lastFile: z.string().nullable(),
  oauthClientConfigured: z.object({ gdrive: z.boolean(), onedrive: z.boolean() }),
});
export type BackupConfig = z.infer<typeof BackupConfig>;
export const BackupConfigSave = z.object({
  enabled: z.boolean(), provider: BackupProvider.nullable(), schedule: z.enum(['off', 'daily']).default('daily'),
  s3: BackupS3Settings.optional(), passphrase: z.string().min(8).optional(),
});
export const BackupOauthStart = z.object({ provider: z.enum(['gdrive', 'onedrive']) });
export const BackupOauthStarted = z.object({ userCode: z.string(), verificationUrl: z.string(), expiresIn: z.number(), interval: z.number() });
export const BackupOauthPolled = z.object({ status: z.enum(['pending', 'connected', 'expired', 'denied']) });
export const BackupRun = z.object({ id: z.string(), at: z.string(), provider: z.string(), trigger: z.string(), fileName: z.string().nullable(), bytes: z.number().nullable(), status: z.enum(['ok', 'failed']), error: z.string().nullable() });
export const BackupFile = z.object({ name: z.string(), size: z.number().nullable(), modifiedAt: z.string().nullable() });
/** Restore on a new machine (setup screen only): pick a destination, list its backups, restore one. */
export const BackupRestoreTarget = z.object({ provider: z.literal('s3'), s3: BackupS3Settings.required({ secretAccessKey: true }) });
export const BackupRestoreReq = BackupRestoreTarget.extend({ file: z.string().min(1), passphrase: z.string().min(8) });

// =====================================================================================================
// M19-10 sales summary share (on-prem sender, cloud receiver)
// =====================================================================================================
export const ShareRange = z.object({ from: YMD, to: YMD });
export const ShareDay = z.object({
  date: z.string(),
  scg: z.array(z.object({ sku: z.string(), name: z.string(), unit: z.string(), qty: Dec, amount: Dec })),
  otherAmount: Dec, total: Dec,
});
/** Exactly what leaves the shop: no customer, user or document data. */
export const SharePayload = z.object({
  v: z.literal(1), shop: z.object({ name: z.string(), taxId: z.string() }), from: z.string(), to: z.string(),
  days: z.array(ShareDay), totals: z.object({ scgQty: Dec, scgAmount: Dec, otherAmount: Dec, total: Dec }),
});
export type SharePayload = z.infer<typeof SharePayload>;
/** Destination comes from the server environment (SCG_SHARE_URL); the license key identifies the shop to SCG. */
export const ShareConfig = z.object({ receiverUrl: z.string().nullable(), licensed: z.boolean(), licenseId: z.string().nullable() });
export const ShareSent = z.object({ id: z.string(), from: z.string(), to: z.string(), status: z.enum(['sent', 'failed']), error: z.string().nullable(), receiptId: z.string().nullable(), sentAt: z.string(), sentBy: z.string(), total: Dec });
export const ShareReceived = z.object({ receiptId: z.string() });

// =====================================================================================================
// M14-05 support access consent (cloud shop side)
// =====================================================================================================
export const SupportGrant = z.object({ id: z.string(), grantedBy: z.string(), note: z.string(), expiresAt: z.string(), revokedAt: z.string().nullable(), createdAt: z.string(), active: z.boolean() });
export const SupportGrantCreate = z.object({ days: z.number().int().min(1).max(30), note: z.string().default('') });

// =====================================================================================================
// M02 terms of use and consent (BR-15). Legal text is a placeholder until OQ-04 (PDPA) is answered.
// =====================================================================================================
export const TermsConsent = z.object({ id: z.string(), label: z.string(), required: z.boolean() });
export const TermsAcceptance = z.object({
  version: z.string(), signerName: z.string(), signerTitle: z.string(), consents: z.record(z.boolean()), acceptedBy: z.string(),
  acceptedAt: z.string(), ip: z.string().nullable(),
});
export type TermsAcceptance = z.infer<typeof TermsAcceptance>;
export const TermsStatus = z.object({
  required: z.boolean(), accepted: z.boolean(), canAccept: z.boolean(),
  current: z.object({ version: z.string(), title: z.string(), body: z.array(z.string()), consents: z.array(TermsConsent), placeholder: z.boolean() }),
  acceptance: TermsAcceptance.nullable(), history: z.array(TermsAcceptance),
});
export type TermsStatus = z.infer<typeof TermsStatus>;
export const TermsAccept = z.object({
  version: z.string(), signerName: z.string().trim().min(1), signerTitle: z.string().default(''), consents: z.record(z.boolean()),
});

// =====================================================================================================
// M14 SCG Admin (cloud)
// =====================================================================================================
export const AdmRole = z.enum(['super', 'master', 'onboarding', 'support', 'analyst']);
export type AdmRole = z.infer<typeof AdmRole>;
export const AdmUser = z.object({ id: z.string(), username: z.string(), name: z.string(), role: AdmRole, status: z.enum(['active', 'disabled']), lastLoginAt: z.string().nullable() });
export type AdmUser = z.infer<typeof AdmUser>;
export const AdmLoginReq = z.object({ username: z.string().min(1), password: z.string().min(1) });
export const AdmLoginRes = z.object({ token: z.string(), admin: AdmUser });
export const AdmUserCreate = z.object({ username: z.string().regex(/^[a-z0-9._]{3,30}$/), name: z.string().min(1), role: AdmRole, password: z.string().min(8) });
/** PATCH /api/adm/admins/:id (super only): edit name / role, set active or disabled, reset the password. At least one field. */
export const AdmUserUpdate = z.object({
  name: z.string().trim().min(1).optional(), role: AdmRole.optional(), status: z.enum(['active', 'disabled']).optional(), password: z.string().min(8).optional(),
}).refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to change' });
export type AdmUserUpdate = z.infer<typeof AdmUserUpdate>;

export const AdmTenant = z.object({
  id: z.string(), code: z.string(), name: z.string(), taxId: z.string(), vatRegistered: z.boolean(), edition: z.enum(['cloud', 'onprem']),
  region: z.string(), customerCode: z.string(), status: z.enum(['active', 'suspended']), statusReason: z.string().nullable(),
  createdAt: z.string(), users: z.number(), bills30d: z.number(), lastBillAt: z.string().nullable(), salesMonth: Dec,
});
export type AdmTenant = z.infer<typeof AdmTenant>;
export const AdmTenantQuery = pageQuery.extend({ status: z.enum(['active', 'suspended']).optional() });
export const AdmTenantCreate = z.object({
  code: z.string().regex(/^[a-z0-9-]{3,30}$/, 'a-z 0-9 - 3-30'), name: z.string().min(1),
  taxId: z.string().regex(/^\d{13}$/, '13 digits'), branch: z.string().default('สำนักงานใหญ่'), vatRegistered: z.boolean(),
  region: z.string().default(''), customerCode: z.string().default(''),
  address: z.string().default(''), phone: z.string().default(''),
  owner: z.object({ username: z.string().regex(/^[a-z0-9._]{3,20}$/), name: z.string().min(1), password: z.string().min(6), pin: z.string().regex(/^\d{4,6}$/) }),
});
export const AdmReason = z.object({ reason: z.string().min(1) });
export const AdmTenantImport = z.object({
  code: z.string().regex(/^[a-z0-9-]{3,30}$/), region: z.string().default(''), passphrase: z.string().min(8),
  file: z.string().min(10), // the exported file's text
});
/** After import every table's row count and the sum of every numeric column match the file, and the audit chain verifies. */
export const AdmImportResult = z.object({
  tenant: AdmTenant, tables: z.record(z.number()),
  verified: z.object({ tables: z.number(), rows: z.number(), numericColumns: z.number(), auditChainOk: z.boolean() }),
});
export const AdmSupportView = z.object({
  shop: z.object({ code: z.string(), name: z.string(), taxId: z.string(), vatRegistered: z.boolean() }),
  grant: z.object({ expiresAt: z.string(), grantedBy: z.string() }),
  users: z.array(z.object({ username: z.string(), name: z.string(), role: Role, status: z.string(), locked: z.boolean() })),
  counts: z.record(z.number()),
  recentDocs: z.array(z.object({ no: z.string(), type: z.string(), date: z.string(), total: Dec, status: z.string() })),
  recentAudit: z.array(z.object({ at: z.string(), user: z.string(), action: z.string(), object: z.string(), ref: z.string().nullable() })),
});

export const AdmKpi = z.object({
  asOf: z.string(),
  total: z.number(), byEdition: z.object({ cloud: z.number(), onprem: z.number() }),
  active30: z.number(), active30ByEdition: z.object({ cloud: z.number(), onprem: z.number() }),
  newPerMonth: z.array(z.object({ month: z.string(), cloud: z.number(), onprem: z.number() })),
  byRegion: z.array(z.object({ region: z.string(), total: z.number(), active30: z.number() })),
  suspended: z.number(),
});
export type AdmKpi = z.infer<typeof AdmKpi>;

export const AdmUnit = z.object({ name: z.string().min(1), factor: Dec });
export const AdmCentralProduct = z.object({
  id: z.string(), sku: z.string(), name: z.string(), category: z.string(), units: z.array(AdmUnit).min(1), barcode: z.string().nullable(),
  imageUrl: z.string().nullable(), vat: z.enum(['v7', 'exempt']), active: z.boolean(),
  price: z.object({ retail: Dec, wholesale: Dec, effectiveFrom: z.string() }).nullable(),       // in effect today
  nextPrice: z.object({ retail: Dec, wholesale: Dec, effectiveFrom: z.string() }).nullable(),   // scheduled
});
export type AdmCentralProduct = z.infer<typeof AdmCentralProduct>;
export const AdmCentralUpsert = z.object({
  sku: z.string().trim().min(1), name: z.string().trim().min(1), category: z.string().default(''), units: z.array(AdmUnit).min(1),
  barcode: z.string().nullable().default(null), imageUrl: z.string().nullable().default(null), vat: z.enum(['v7', 'exempt']).default('v7'),
  active: z.boolean().default(true),
});
export const AdmCentralPriceReq = z.object({ retail: DecNN, wholesale: DecNN.default('0'), effectiveFrom: YMD });
export const AdmPushReq = z.object({ productIds: z.array(z.string()).optional(), tenantIds: z.array(z.string()).optional() });
export const AdmPushResult = z.object({ shops: z.number(), products: z.number(), created: z.number(), updated: z.number(), priceApplied: z.number() });
export const AdmPush = z.object({ id: z.string(), at: z.string(), what: z.string(), products: z.number(), shops: z.number(), target: z.string(), by: z.string() });

export const AdmLicenseIssue = z.object({
  shopName: z.string().min(1), taxId: z.string().regex(/^\d{13}$/, '13 digits'), type: LicenseType,
  expiresAt: YMD.nullable().default(null), region: z.string().default(''), note: z.string().default(''),
});
export const AdmLicense = z.object({
  licenseId: z.string(), key: z.string(), shopName: z.string(), taxId: z.string(), edition: z.string(), type: LicenseType,
  expiresAt: z.string().nullable(), issuedAt: z.string(), region: z.string(), note: z.string(), issuedBy: z.string(),
  revokedAt: z.string().nullable(), lastShareAt: z.string().nullable(),
});
export const AdmShare = z.object({ id: z.string(), licenseId: z.string(), shopName: z.string(), taxId: z.string(), from: z.string(), to: z.string(), total: Dec, receivedAt: z.string(), payload: SharePayload });
export const AdmShareQuery = pageQuery.extend({ licenseId: z.string().optional() });
export const AdmAuditEntry = z.object({ id: z.string(), at: z.string(), admin: z.string(), action: z.string(), object: z.string(), ref: z.string().nullable(), detail: z.string() });

// =====================================================================================================
export const adminRoutes = {
  // M17
  hrMe: 'GET /api/hr/me',
  hrEmployees: 'GET /api/hr/employees', hrEmployeeCreate: 'POST /api/hr/employees', hrEmployee: 'GET /api/hr/employees/:id',
  hrEmployeeUpdate: 'PATCH /api/hr/employees/:id', hrEmployeeResign: 'POST /api/hr/employees/:id/resign', hrEmployeeRehire: 'POST /api/hr/employees/:id/rehire',
  hrSettings: 'GET /api/hr/settings', hrSettingsUpdate: 'PATCH /api/hr/settings',
  hrLeaves: 'GET /api/hr/leaves', hrLeaveCreate: 'POST /api/hr/leaves', hrLeaveApprove: 'POST /api/hr/leaves/:id/approve', hrLeaveReject: 'POST /api/hr/leaves/:id/reject',
  hrLeaveBalances: 'GET /api/hr/leave-balances',
  hrPayrollRuns: 'GET /api/hr/payroll', hrPayrollCreate: 'POST /api/hr/payroll', hrPayroll: 'GET /api/hr/payroll/:period', hrPayrollUpdate: 'PATCH /api/hr/payroll/:period', hrPayslipPeriods: 'GET /api/hr/payslip-periods',
  hrPayrollLine: 'PATCH /api/hr/payroll/:period/lines/:lineId', hrPayrollRecalc: 'POST /api/hr/payroll/:period/recalc',
  hrPayrollApprove: 'POST /api/hr/payroll/:period/approve', hrPayrollReopen: 'POST /api/hr/payroll/:period/reopen', hrPayrollPay: 'POST /api/hr/payroll/:period/pay',
  hrPayslips: 'GET /api/hr/payroll/:period/slips', hrLabourCost: 'GET /api/hr/labour-cost',
  // M19-11 / 07 / 09 / 10 (on-prem shop side)
  licenseStatus: 'GET /api/license', licenseInstall: 'POST /api/license',
  shopExport: 'POST /api/system/export',
  backupConfig: 'GET /api/backup/config', backupConfigSave: 'POST /api/backup/config', backupOauthStart: 'POST /api/backup/oauth/start',
  backupOauthPoll: 'POST /api/backup/oauth/poll', backupRun: 'POST /api/backup/run', backupRuns: 'GET /api/backup/runs', backupFiles: 'GET /api/backup/files',
  backupRestoreFiles: 'POST /api/backup/restore/files', backupRestore: 'POST /api/backup/restore',
  shareConfig: 'GET /api/share/config', sharePreview: 'GET /api/share/preview', shareSend: 'POST /api/share/send', shareHistory: 'GET /api/share/history',
  // M02 (both editions; enforced only for shops flagged by SCG Admin)
  termsStatus: 'GET /api/terms', termsAccept: 'POST /api/terms/accept',
  // cloud: receiver, support consent, SCG Admin
  shareReceive: 'POST /api/scg/sales-summary',
  supportGrants: 'GET /api/support-grants', supportGrantCreate: 'POST /api/support-grants', supportGrantRevoke: 'POST /api/support-grants/:id/revoke',
  admLogin: 'POST /api/adm/auth/login', admMe: 'GET /api/adm/auth/me', admAdmins: 'GET /api/adm/admins', admAdminCreate: 'POST /api/adm/admins', admAdminUpdate: 'PATCH /api/adm/admins/:id',
  admTenants: 'GET /api/adm/tenants', admTenantCreate: 'POST /api/adm/tenants', admTenantSuspend: 'POST /api/adm/tenants/:id/suspend',
  admTenantResume: 'POST /api/adm/tenants/:id/resume', admTenantImport: 'POST /api/adm/tenants/import', admTenantSupport: 'POST /api/adm/tenants/:id/support',
  admKpi: 'GET /api/adm/kpi',
  admCentral: 'GET /api/adm/central-products', admCentralCreate: 'POST /api/adm/central-products', admCentralUpdate: 'PATCH /api/adm/central-products/:id',
  admCentralPrice: 'POST /api/adm/central-products/:id/prices', admCentralPush: 'POST /api/adm/central-push', admCentralPushes: 'GET /api/adm/central-push',
  admLicenses: 'GET /api/adm/licenses', admLicenseIssue: 'POST /api/adm/licenses', admLicenseRevoke: 'POST /api/adm/licenses/:id/revoke',
  admShares: 'GET /api/adm/sales-shares', admAudit: 'GET /api/adm/audit',
} as const;

const onprem = 'onprem' as const;
const cloud = 'cloud' as const;
/** Routes registered on one edition only. Unlisted routes (M17) exist on both. */
export const adminRouteEditions: RouteEditions<typeof adminRoutes> = {
  licenseStatus: onprem, licenseInstall: onprem, shopExport: onprem,
  backupConfig: onprem, backupConfigSave: onprem, backupOauthStart: onprem, backupOauthPoll: onprem, backupRun: onprem, backupRuns: onprem,
  backupFiles: onprem, backupRestoreFiles: onprem, backupRestore: onprem,
  shareConfig: onprem, sharePreview: onprem, shareSend: onprem, shareHistory: onprem,
  shareReceive: cloud, supportGrants: cloud, supportGrantCreate: cloud, supportGrantRevoke: cloud,
  admLogin: cloud, admMe: cloud, admAdmins: cloud, admAdminCreate: cloud, admAdminUpdate: cloud, admTenants: cloud, admTenantCreate: cloud, admTenantSuspend: cloud,
  admTenantResume: cloud, admTenantImport: cloud, admTenantSupport: cloud, admKpi: cloud, admCentral: cloud, admCentralCreate: cloud,
  admCentralUpdate: cloud, admCentralPrice: cloud, admCentralPush: cloud, admCentralPushes: cloud, admLicenses: cloud, admLicenseIssue: cloud,
  admLicenseRevoke: cloud, admShares: cloud, admAudit: cloud,
};
