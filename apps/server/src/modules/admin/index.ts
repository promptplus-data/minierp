/**
 * "admin" module group (Agent D): M17 HR/payroll/leave, M02 terms, M19-11 license, M19-07 export, M19-09 cloud backup,
 * M19-10 sales-summary share (on-prem) and M14 SCG Admin + the summary receiver and support consent (cloud).
 * Routes: packages/contracts/src/modules/admin.ts. Rules and tests: ./README.md.
 */
import { z } from 'zod';
import {
  AdmAuditEntry, AdmCentralPriceReq, AdmCentralUpsert, AdmLicenseIssue, AdmLoginReq, AdmPushReq, AdmReason, AdmShareQuery, AdmTenantCreate,
  AdmTenantImport, AdmTenantQuery, AdmUserCreate, AdmUserUpdate, BackupConfigSave, BackupOauthStart, BackupRestoreReq, BackupRestoreTarget, HrEmployeeCreate,
  HrEmployeeQuery, HrEmployeeUpdate, HrLabourCostQuery, HrLeaveCreate, HrLeaveDecide, HrLeaveQuery, HrPayrollCreate, HrPayrollLineUpdate,
  HrPayrollPay, HrResignReq, HrSettingsUpdate, LicenseInstall, ShareRange, ShopExportReq, SupportGrantCreate, TermsAccept, pageQuery,
} from '@erp/contracts';
import { writeAudit } from '../../lib/audit';
import { can, requirePerm } from '../../lib/context';
import { E } from '../../lib/errors';
import { FailureLimiter } from '../../lib/limiter';
import { isLoopback } from '../../lib/net';
import { needsSetup } from '../../services/setup';
import type { ErpModule } from '../types';
import * as adm from './adm';
import { getBackupConfig, listBackupFiles, listBackupRuns, oauthPoll, oauthStart, requireOwner, restoreBackup, restoreFiles, runBackup, saveBackupConfig, startBackupScheduler } from './backup';
import { deriveKey, sealBox } from './box';
import * as hr from './hr';
import { installLicense, licenseGuard, licenseStatus } from './license';
import { bootstrapAdmin, createAdmin, listAdmins, updateAdmin, admLogin, makeAdmAuthed, toAdmUser } from './platform';
import { buildSharePayload, sendShare, shareConfig, shareHistory } from './share';
import { createGrant, listGrants, revokeGrant } from './support';
import { acceptTerms, shopStatusGuard, termsStatus } from './terms';
import { exportShop } from './transfer';
import { transports } from './transports';

const id = (req: { params: unknown }) => (req.params as { id: string }).id;
const period = (req: { params: unknown }) => (req.params as { period: string }).period;
/** Allowed while the license is expired (read-only mode): license entry, export, backup, summary share, terms. */
const RO_OK = { config: { readOnlyOk: true } };

export const adminModule: ErpModule = async (app, { deps, authed }) => {
  deps.tenantGuards.push(shopStatusGuard);
  if (deps.edition === 'onprem') deps.tenantGuards.push(licenseGuard(deps));

  // ================================================================ M17 HR (both editions)
  app.get('/api/hr/me', authed(async (tx, ctx) => ({ employee: await hr.myEmployee(tx, ctx), canManage: can(ctx, 'hr.manage') === 1 })));
  app.get('/api/hr/employees', authed(async (tx, ctx, req) => hr.listEmployees(tx, ctx, HrEmployeeQuery.parse(req.query))));
  app.post('/api/hr/employees', authed(async (tx, ctx, req, reply) => {
    reply.status(201);
    return hr.createEmployee(tx, ctx, HrEmployeeCreate.parse(req.body), deps.today());
  }));
  app.get('/api/hr/employees/:id', authed(async (tx, ctx, req) => hr.getEmployee(tx, ctx, id(req))));
  app.patch('/api/hr/employees/:id', authed(async (tx, ctx, req) => hr.updateEmployee(tx, ctx, id(req), HrEmployeeUpdate.parse(req.body))));
  app.post('/api/hr/employees/:id/resign', authed(async (tx, ctx, req) => hr.resignEmployee(tx, ctx, id(req), HrResignReq.parse(req.body))));
  app.post('/api/hr/employees/:id/rehire', authed(async (tx, ctx, req) => hr.rehireEmployee(tx, ctx, id(req))));
  app.get('/api/hr/settings', authed(async (tx, ctx) => {
    requirePerm(ctx, 'hr.salary');
    return hr.hrSettings(tx, ctx.tenantId);
  }));
  app.patch('/api/hr/settings', authed(async (tx, ctx, req) => hr.updateHrSettings(tx, ctx, HrSettingsUpdate.parse(req.body))));
  app.get('/api/hr/leaves', authed(async (tx, ctx, req) => hr.listLeaves(tx, ctx, HrLeaveQuery.parse(req.query))));
  app.post('/api/hr/leaves', authed(async (tx, ctx, req, reply) => {
    reply.status(201);
    return hr.createLeave(tx, ctx, HrLeaveCreate.parse(req.body), deps.today());
  }));
  app.post('/api/hr/leaves/:id/approve', authed(async (tx, ctx, req) => hr.decideLeave(tx, ctx, id(req), true, HrLeaveDecide.parse(req.body ?? {}))));
  app.post('/api/hr/leaves/:id/reject', authed(async (tx, ctx, req) => hr.decideLeave(tx, ctx, id(req), false, HrLeaveDecide.parse(req.body ?? {}))));
  app.get('/api/hr/leave-balances', authed(async (tx, ctx, req) => {
    const year = z.coerce.number().int().min(2000).max(2100).default(Number(deps.today().slice(0, 4))).parse((req.query as { year?: string }).year);
    return { year, items: await hr.leaveBalanceRows(tx, ctx, year) };
  }));
  app.get('/api/hr/payroll', authed(async (tx, ctx, req) => hr.listRuns(tx, ctx, pageQuery.parse(req.query))));
  app.post('/api/hr/payroll', authed(async (tx, ctx, req, reply) => {
    reply.status(201);
    return hr.createRun(tx, ctx, HrPayrollCreate.parse(req.body).period);
  }));
  app.get('/api/hr/payroll/:period', authed(async (tx, ctx, req) => hr.getRun(tx, ctx, period(req))));
  app.patch('/api/hr/payroll/:period/lines/:lineId', authed(async (tx, ctx, req) =>
    hr.updateLine(tx, ctx, period(req), (req.params as { lineId: string }).lineId, HrPayrollLineUpdate.parse(req.body))));
  app.post('/api/hr/payroll/:period/recalc', authed(async (tx, ctx, req) => hr.recalcRun(tx, ctx, period(req))));
  app.post('/api/hr/payroll/:period/approve', authed(async (tx, ctx, req) => hr.transitionRun(tx, ctx, period(req), 'approved', deps.today())));
  app.post('/api/hr/payroll/:period/reopen', authed(async (tx, ctx, req) => hr.transitionRun(tx, ctx, period(req), 'draft', deps.today())));
  app.post('/api/hr/payroll/:period/pay', authed(async (tx, ctx, req) =>
    hr.transitionRun(tx, ctx, period(req), 'paid', deps.today(), HrPayrollPay.parse(req.body ?? {}).payDate)));
  app.get('/api/hr/payroll/:period/slips', authed(async (tx, ctx, req) =>
    ({ items: await hr.payslips(tx, ctx, period(req), (req.query as { employeeId?: string }).employeeId) })));
  app.get('/api/hr/labour-cost', authed(async (tx, ctx, req) => hr.labourCostRows(tx, ctx, HrLabourCostQuery.parse(req.query))));

  // ================================================================ M02 terms (both editions)
  app.get('/api/terms', authed(async (tx, ctx) => termsStatus(tx, ctx)));
  app.post('/api/terms/accept', RO_OK, authed(async (tx, ctx, req) => acceptTerms(tx, ctx, TermsAccept.parse(req.body), req.ip ?? null)));

  // ================================================================ on-prem: license, export, backup, sales summary
  if (deps.edition === 'onprem') {
    app.get('/api/license', authed(async (tx) => licenseStatus(tx, deps.today())));
    app.post('/api/license', RO_OK, authed(async (tx, ctx, req) => {
      requireOwner(ctx, 'enter the license key');
      await installLicense(tx, ctx, LicenseInstall.parse(req.body).key);
      return licenseStatus(tx, deps.today());
    }));

    // REQ-M19-07: whole shop as one passphrase-encrypted file (owner only: it contains every record of the shop).
    app.post('/api/system/export', RO_OK, authed(async (tx, ctx, req, reply) => {
      requireOwner(ctx, 'export the whole shop');
      const { passphrase } = ShopExportReq.parse(req.body);
      const data = await exportShop(tx, ctx.tenantId);
      const now = new Date();
      const file = sealBox('shop-export', { shopName: data.source.name, taxId: data.source.taxId, createdAt: now.toISOString() }, data, deriveKey(passphrase));
      const rows = Object.values(data.tables).reduce((n, t) => n + t.length, 0);
      await writeAudit(tx, ctx, [{ action: 'export', object: 'tenant', ref: data.source.code, detail: `ส่งออกข้อมูลทั้งร้าน ${Object.keys(data.tables).length} ตาราง ${rows} แถว (เข้ารหัส)` }]);
      reply.header('content-type', 'application/json; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="${data.source.code}-${now.toISOString().slice(0, 10)}.scgshop"`);
      return file;
    }));

    app.get('/api/backup/config', authed(async (tx, ctx) => getBackupConfig(tx, ctx)));
    app.post('/api/backup/config', RO_OK, authed(async (tx, ctx, req) => saveBackupConfig(tx, ctx, BackupConfigSave.parse(req.body))));
    // Google Drive / OneDrive: device-code OAuth (oauth.ts). Not configured until SCG registers the OAuth apps.
    app.post('/api/backup/oauth/start', RO_OK, authed(async (tx, ctx, req) => oauthStart(tx, ctx, BackupOauthStart.parse(req.body).provider)));
    app.post('/api/backup/oauth/poll', RO_OK, authed(async (tx, ctx, req) => oauthPoll(tx, ctx, BackupOauthStart.parse(req.body).provider)));
    app.post('/api/backup/run', RO_OK, authed(async (tx, ctx) => {
      requireOwner(ctx, 'run a backup');
      return runBackup(tx, ctx, 'manual', transports.backup);
    }));
    app.get('/api/backup/runs', authed(async (tx, ctx, req) => listBackupRuns(tx, ctx, pageQuery.parse(req.query))));
    app.get('/api/backup/files', authed(async (tx, ctx) => listBackupFiles(tx, ctx, transports.backup)));
    // Restore wizard on a fresh machine: like /api/setup, only from the main machine and only while there is no shop.
    const restoreGate = async (ip: string) => {
      if (!isLoopback(ip)) throw E.forbidden('Restore on the main machine itself (https://localhost)');
      if (!(await needsSetup(deps.pool))) throw E.conflict('This machine already has a shop; restore only works on a new installation', { reason: 'NOT_EMPTY' });
    };
    const restoreLimiter = new FailureLimiter({ max: 10, windowMs: 10 * 60_000, maxEntries: 10_000 });
    app.post('/api/backup/restore/files', async (req) => {
      await restoreGate(req.ip);
      return restoreFiles(BackupRestoreTarget.parse(req.body), transports.backup);
    });
    app.post('/api/backup/restore', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
      await restoreGate(req.ip);
      if (restoreLimiter.blocked(req.ip)) throw E.forbidden('Too many failed attempts; wait 10 minutes', { reason: 'RATE_LIMITED' });
      try {
        const out = await restoreBackup(deps.pool, BackupRestoreReq.parse(req.body), transports.backup);
        reply.status(201);
        return out;
      } catch (err) {
        restoreLimiter.fail(req.ip);
        throw err;
      }
    });

    app.get('/api/share/config', authed(async (tx, ctx) => shareConfig(tx, ctx)));
    app.get('/api/share/preview', authed(async (tx, ctx, req) => {
      const r = ShareRange.parse(req.query);
      return buildSharePayload(tx, ctx, r.from, r.to, deps.today());
    }));
    app.post('/api/share/send', RO_OK, authed(async (tx, ctx, req) => {
      const r = ShareRange.parse(req.body);
      return sendShare(tx, ctx, r.from, r.to, deps.today(), transports.share);
    }));
    app.get('/api/share/history', authed(async (tx, ctx, req) => shareHistory(tx, ctx, pageQuery.parse(req.query))));

    if (deps.backgroundJobs) {
      const stop = startBackupScheduler(deps.pool, app.log, transports.backup);
      app.addHook('onClose', async () => stop());
    }
  }

  // ================================================================ cloud: receiver, support consent, SCG Admin
  if (process.env.EDITION === 'cloud') {
    if (deps.edition === 'cloud') {
      const receiveLimiter = new FailureLimiter({ max: 30, windowMs: 10 * 60_000, maxEntries: 10_000 });
      app.post('/api/scg/sales-summary', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
        if (receiveLimiter.blocked(req.ip)) throw E.forbidden('Too many failed attempts', { reason: 'RATE_LIMITED' });
        try {
          const out = await adm.receiveShare(deps.pool, (req.body ?? {}) as { key?: unknown; payload?: unknown });
          reply.status(201);
          return out;
        } catch (err) {
          receiveLimiter.fail(req.ip);
          throw err;
        }
      });

      app.get('/api/support-grants', authed(async (tx, ctx) => listGrants(tx, ctx)));
      app.post('/api/support-grants', authed(async (tx, ctx, req, reply) => {
        reply.status(201);
        return createGrant(tx, ctx, SupportGrantCreate.parse(req.body));
      }));
      app.post('/api/support-grants/:id/revoke', authed(async (tx, ctx, req) => revokeGrant(tx, ctx, id(req))));

      await bootstrapAdmin(deps.pool);
      const admAuthed = makeAdmAuthed(deps.pool);
      const loginLimiter = new FailureLimiter({ max: 10, windowMs: 10 * 60_000, maxEntries: 10_000 });
      app.post('/api/adm/auth/login', async (req) => {
        if (loginLimiter.blocked(req.ip)) throw E.forbidden('Too many failed attempts; wait 10 minutes', { reason: 'RATE_LIMITED' });
        try {
          return await admLogin(app, deps.pool, AdmLoginReq.parse(req.body));
        } catch (err) {
          loginLimiter.fail(req.ip);
          throw err;
        }
      });
      app.get('/api/adm/auth/me', admAuthed(async (tx, a) =>
        toAdmUser((await tx.query<Parameters<typeof toAdmUser>[0]>(`select id, username, name, role, status, last_login_at from platform_admins where id = $1`, [a.adminId])).rows[0]!)));
      app.get('/api/adm/admins', admAuthed(async (tx, a) => listAdmins(tx, a)));
      app.post('/api/adm/admins', admAuthed(async (tx, a, req, reply) => {
        reply.status(201);
        return createAdmin(tx, a, AdmUserCreate.parse(req.body));
      }));
      app.patch('/api/adm/admins/:id', admAuthed(async (tx, a, req) => updateAdmin(tx, a, id(req), AdmUserUpdate.parse(req.body))));

      app.get('/api/adm/tenants', admAuthed(async (tx, _a, req) => adm.listTenants(tx, AdmTenantQuery.parse(req.query))));
      // Shop writes run in the shop's own transaction, so these handlers use the pool rather than the platform tx.
      app.post('/api/adm/tenants', admAuthed(async (_tx, a, req, reply) => {
        reply.status(201);
        return adm.createTenant(deps.pool, a, AdmTenantCreate.parse(req.body));
      }));
      app.post('/api/adm/tenants/:id/suspend', admAuthed(async (_tx, a, req) => adm.setTenantStatus(deps.pool, a, id(req), 'suspended', AdmReason.parse(req.body).reason)));
      app.post('/api/adm/tenants/:id/resume', admAuthed(async (_tx, a, req) => adm.setTenantStatus(deps.pool, a, id(req), 'active', AdmReason.parse(req.body).reason)));
      app.post('/api/adm/tenants/import', { bodyLimit: 512 * 1024 * 1024 }, admAuthed(async (_tx, a, req, reply) => {
        reply.status(201);
        return adm.importTenant(deps.pool, a, AdmTenantImport.parse(req.body));
      }));
      app.post('/api/adm/tenants/:id/support', admAuthed(async (_tx, a, req) => adm.supportView(deps.pool, a, id(req))));
      app.get('/api/adm/kpi', admAuthed(async (tx) => adm.kpi(tx, deps.today())));

      app.get('/api/adm/central-products', admAuthed(async (tx, _a, req) => adm.listCentral(tx, deps.today(), pageQuery.parse(req.query))));
      app.post('/api/adm/central-products', admAuthed(async (tx, a, req, reply) => {
        reply.status(201);
        return adm.upsertCentral(tx, a, deps.today(), null, AdmCentralUpsert.parse(req.body));
      }));
      app.patch('/api/adm/central-products/:id', admAuthed(async (tx, a, req) => adm.upsertCentral(tx, a, deps.today(), id(req), AdmCentralUpsert.parse(req.body))));
      app.post('/api/adm/central-products/:id/prices', admAuthed(async (tx, a, req) => adm.addCentralPrice(tx, a, deps.today(), id(req), AdmCentralPriceReq.parse(req.body))));
      app.post('/api/adm/central-push', admAuthed(async (_tx, a, req) => adm.pushCentral(deps.pool, a, deps.today(), AdmPushReq.parse(req.body ?? {}))));
      app.get('/api/adm/central-push', admAuthed(async (tx, _a, req) => adm.listPushes(tx, pageQuery.parse(req.query))));

      app.get('/api/adm/licenses', admAuthed(async (tx, _a, req) => adm.listLicenses(tx, pageQuery.parse(req.query))));
      app.post('/api/adm/licenses', admAuthed(async (tx, a, req, reply) => {
        reply.status(201);
        return adm.issueLicense(tx, a, deps.today(), AdmLicenseIssue.parse(req.body));
      }));
      app.post('/api/adm/licenses/:id/revoke', admAuthed(async (tx, a, req) => adm.revokeLicense(tx, a, id(req), AdmReason.parse(req.body).reason)));
      app.get('/api/adm/sales-shares', admAuthed(async (tx, _a, req) => adm.listShares(tx, AdmShareQuery.parse(req.query))));
      app.get('/api/adm/audit', admAuthed(async (tx, a, req) => {
        const out = await adm.listAdmAudit(tx, a, pageQuery.parse(req.query));
        return { ...out, items: out.items.map((x) => AdmAuditEntry.parse(x)) };
      }));
    }
  }
};
