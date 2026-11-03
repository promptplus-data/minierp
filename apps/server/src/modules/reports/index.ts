/**
 * "reports" module group: M11 reports + home dashboard, M12 accounting export (PEAK / FlowAccount / Express).
 * Routes: packages/contracts/src/modules/reports.ts. Rules → tests: ./README.md.
 */
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ExportGlUpdate, ExportRunReq, ReportMonthQuery, ReportRangeQuery, ReportSalesQuery, ReportStockQuery, ReportVatQuery, pageQuery,
} from '@erp/contracts';
import { money, sum } from '@erp/core';
import { requirePerm } from '../../lib/context';
import type { ErpModule } from '../types';
import { dashboard } from './dashboard';
import { createRun, getFile, getGl, getRun, listRuns, updateGl } from './export';
import { costsReport, costsSheet, promotionsReport } from './extra';
import { sendFile } from './files';
import { salesReport, salesSheet } from './sales';
import { stockReport, stockSheet } from './stock';
import { vatReport, vatSheet } from './vat';

const params = (req: FastifyRequest) => req.params as Record<string, string>;

export const reportsModule: ErpModule = async (app, { deps, authed }) => {
  // ---------- M11-04 home ----------
  app.get('/api/reports/dashboard', authed(async (tx, ctx) => dashboard(tx, deps, ctx)));

  // ---------- M11-01 sales and gross profit ----------
  app.get('/api/reports/sales', authed(async (tx, ctx, req, reply) => {
    requirePerm(ctx, 'rep.view', { readOnly: true });
    const q = ReportSalesQuery.parse(req.query);
    if (q.format === 'json') return salesReport(tx, ctx, q);
    const r = await salesReport(tx, ctx, q, true);
    return sendFile(reply, q.format, `sales-${q.by}-${q.from}_${q.to}`, salesSheet(r), 'ยอดขาย');
  }));

  // ---------- M11-02 stock ----------
  app.get('/api/reports/stock', authed(async (tx, ctx, req, reply) => {
    requirePerm(ctx, 'rep.view', { readOnly: true });
    const q = ReportStockQuery.parse(req.query);
    if (q.format === 'json') return stockReport(tx, deps, ctx, q);
    const r = await stockReport(tx, deps, ctx, q, true);
    return sendFile(reply, q.format, `stock-${r.asOf}`, stockSheet(r), 'สต็อก');
  }));

  // ---------- M11-03 VAT ----------
  app.get('/api/reports/vat', authed(async (tx, ctx, req, reply) => {
    requirePerm(ctx, 'rep.view', { readOnly: true });
    const q = ReportVatQuery.parse(req.query);
    if (q.format === 'json') return vatReport(tx, q);
    const r = await vatReport(tx, q, true);
    return sendFile(reply, q.format, `vat-${q.kind}-${q.month}`, vatSheet(r), q.kind === 'sales' ? 'ภาษีขาย' : 'ภาษีซื้อ');
  }));

  // ---------- M11-06 internal cost ----------
  app.get('/api/reports/costs', authed(async (tx, ctx, req, reply) => {
    requirePerm(ctx, 'rep.view', { readOnly: true });
    const q = ReportMonthQuery.parse(req.query);
    const r = await costsReport(tx, ctx, q.month);
    return q.format === 'json' ? r : sendFile(reply, q.format, `costs-${q.month}`, costsSheet(r), 'ต้นทุนภายใน');
  }));

  // ---------- M11-07 promotions ----------
  app.get('/api/reports/promotions', authed(async (tx, ctx, req, reply) => {
    requirePerm(ctx, 'rep.view', { readOnly: true });
    const q = ReportRangeQuery.parse(req.query);
    const r = await promotionsReport(tx, ctx, q.from, q.to);
    if (q.format === 'json') return r;
    return sendFile(reply, q.format, `promotions-${q.from}_${q.to}`, [
      ['โปรโมชั่น', 'จำนวนบิล', 'ชุดที่ขาย', 'ยอดขาย', 'ส่วนลดที่ให้', 'ต้นทุน FIFO', 'กำไรขั้นต้น', 'ยอดขายช่วงก่อนโปร', 'กำไรช่วงก่อนโปร'],
      ...r.rows.map((x) => [x.label, x.bills, x.sets, x.sales, x.discount, x.cogs ?? '', x.gp ?? '', x.before?.sales ?? '', x.before?.gp ?? '']),
    ], 'โปรโมชั่น');
  }));

  // ---------- M11-05 SCG Family coupons: cloud only (OQ-A2) ----------
  if (process.env.EDITION === 'cloud') {
    if (deps.edition === 'cloud') {
      app.get('/api/reports/coupons', authed(async (tx, ctx, req, reply) => {
        requirePerm(ctx, 'rep.view', { readOnly: true });
        const q = ReportRangeQuery.parse(req.query);
        const { couponsReport } = await import('./coupons');
        const r = await couponsReport(tx, q.from, q.to);
        if (q.format === 'json') return r;
        return sendFile(reply, q.format, `coupons-${q.from}_${q.to}`, [
          ['เลขบิล', 'วันที่', 'SCG Family ID', 'รหัสคูปอง', 'มูลค่า', 'เลขอ้างอิงการตัด'],
          ...r.rows.map((x) => [x.billNo, x.date, x.memberId, x.couponCode, x.amount, x.redeemRef]),
          ['', '', '', 'รวม', money(sum(r.rows.map((x) => x.amount))), ''],
        ], 'คูปอง');
      }));
    }
  }

  // ---------- M12 accounting export ----------
  app.get('/api/acct-export/gl', authed(async (tx, ctx) => {
    requirePerm(ctx, 'data.export', { readOnly: true });
    return getGl(tx);
  }));
  app.patch('/api/acct-export/gl', authed(async (tx, ctx, req) => updateGl(tx, ctx, ExportGlUpdate.parse(req.body))));
  app.post('/api/acct-export/runs', authed(async (tx, ctx, req, reply) => {
    reply.status(201);
    return createRun(tx, deps, ctx, ExportRunReq.parse(req.body));
  }));
  app.get('/api/acct-export/runs', authed(async (tx, ctx, req) => listRuns(tx, ctx, pageQuery.parse(req.query))));
  app.get('/api/acct-export/runs/:id', authed(async (tx, ctx, req) => getRun(tx, ctx, params(req).id!)));
  app.get('/api/acct-export/runs/:id/files/:seq', authed(async (tx, ctx, req, reply) => {
    const f = await getFile(tx, ctx, params(req).id!, z.coerce.number().int().parse(params(req).seq));
    reply.header('content-type', f.contentType);
    reply.header('content-disposition', `attachment; filename="${f.name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    reply.header('cache-control', 'no-store');
    return f.content;
  }));
};
