/**
 * "purchasing" module group (Agent B): M18 AP (bills from goods receipts, payment vouchers, vendor returns),
 * M04 Import Hub, stock count / ledger / reorder (M06), M05 GR-overdue alert (BR-10), M19-08 delivery-file import.
 * Every route exists on both editions. Routes and rules → tests: ./README.md.
 */
import { z } from 'zod';
import {
  ApBillQuery, ApPaymentReq, DeliveryCommitReq, DeliveryPreviewReq, GrDraftConfirmReq, GrDraftCreateProductReq, GrDraftQuery, GrDraftUpdate,
  GrListQuery, ImportCommitReq, ImportKind, ImportPreviewReq, ImportTemplateQuery, LedgerQuery, PurchasingSettings, StockCountEntryReq,
  StockCountOpenReq, StockCountQuery, VendorReturnReq, pageQuery,
} from '@erp/contracts';
import { requireAny } from '../../lib/context';
import type { ErpModule } from '../types';
import * as ap from './ap';
import * as dl from './delivery';
import * as hub from './importhub';
import * as sx from './stockx';

/** Uploads travel as base64 JSON: a 10 MB file is ~13.4 MB of body. */
const UPLOAD = { bodyLimit: 15 * 1024 * 1024 };
type P = { id: string; no: string; lineId: string; kind: string };
const params = (req: { params: unknown }) => req.params as P;

export const purchasingModule: ErpModule = async (app, { deps, authed }) => {
  // ---------- settings, dashboard, GR alert ----------
  app.get('/api/purchasing/settings', authed(async (tx) => ap.getSettings(tx)));
  app.patch('/api/purchasing/settings', authed(async (tx, ctx, req) => ap.updateSettings(tx, ctx, PurchasingSettings.parse(req.body))));
  app.get('/api/purchasing/dashboard', authed(async (tx, ctx) => sx.dashboard(tx, deps, ctx)));
  // BR-10 / REQ-M05-09: computed on every read (home banner, GR menu), so no background timer is needed.
  app.get('/api/purchasing/gr-alerts', authed(async (tx) => sx.grAlerts(tx, deps)));
  app.get('/api/purchasing/receipts', authed(async (tx, ctx, req) => ap.listReceipts(tx, ctx, GrListQuery.parse(req.query))));
  app.get('/api/purchasing/receipts/:no', authed(async (tx, ctx, req) => ap.getReceipt(tx, ctx, params(req).no)));

  // ---------- AP (M18) ----------
  app.get('/api/ap/bills', authed(async (tx, ctx, req) => ap.listBills(tx, deps, ctx, ApBillQuery.parse(req.query))));
  app.get('/api/ap/bills/:no', authed(async (tx, ctx, req) => ap.getBill(tx, deps, ctx, params(req).no)));
  app.get('/api/ap/aging', authed(async (tx, ctx) => ap.aging(tx, deps, ctx)));
  app.get('/api/ap/payments', authed(async (tx, ctx, req) => ap.listPayments(tx, ctx, pageQuery.parse(req.query))));
  app.post('/api/ap/payments', authed(async (tx, ctx, req, reply) => {
    reply.status(201);
    return ap.createPayment(tx, deps, ctx, ApPaymentReq.parse(req.body));
  }));
  app.get('/api/ap/payments/:no', authed(async (tx, ctx, req) => ap.getPayment(tx, ctx, params(req).no)));
  app.get('/api/ap/vendor-returns', authed(async (tx, ctx, req) => ap.listReturns(tx, ctx, pageQuery.parse(req.query))));
  app.post('/api/ap/vendor-returns', authed(async (tx, ctx, req, reply) => {
    reply.status(201);
    return ap.createReturn(tx, deps, ctx, VendorReturnReq.parse(req.body));
  }));
  app.get('/api/ap/vendor-returns/:no', authed(async (tx, ctx, req) => ap.getReturn(tx, ctx, params(req).no)));
  app.get('/api/ap/purchase-discounts', authed(async (tx, ctx, req) => ap.purchaseDiscounts(tx, ctx, pageQuery.parse(req.query))));

  // ---------- delivery-file import (M19-08) ----------
  app.post('/api/delivery-imports/preview', UPLOAD, authed(async (tx, ctx, req) => dl.deliveryPreview(tx, deps, ctx, DeliveryPreviewReq.parse(req.body))));
  app.post('/api/delivery-imports/commit', UPLOAD, authed(async (tx, ctx, req, reply) => {
    reply.status(201);
    return dl.deliveryCommit(tx, deps, ctx, DeliveryCommitReq.parse(req.body));
  }));
  app.get('/api/gr-drafts', authed(async (tx, ctx, req) => dl.listDrafts(tx, deps, ctx, GrDraftQuery.parse(req.query))));
  app.get('/api/gr-drafts/:id', authed(async (tx, ctx, req) => dl.getDraft(tx, deps, ctx, params(req).id)));
  app.patch('/api/gr-drafts/:id', authed(async (tx, ctx, req) => dl.updateDraft(tx, deps, ctx, params(req).id, GrDraftUpdate.parse(req.body))));
  app.post('/api/gr-drafts/:id/lines/:lineId/product', authed(async (tx, ctx, req) =>
    dl.createProductForLine(tx, deps, ctx, params(req).id, params(req).lineId, GrDraftCreateProductReq.parse(req.body))));
  app.post('/api/gr-drafts/:id/confirm', authed(async (tx, ctx, req) => dl.confirmDraft(tx, deps, ctx, params(req).id, GrDraftConfirmReq.parse(req.body))));
  app.post('/api/gr-drafts/:id/cancel', authed(async (tx, ctx, req) =>
    dl.cancelDraft(tx, ctx, params(req).id, z.object({ reason: z.string().optional() }).parse(req.body ?? {}).reason)));
  app.get('/api/import/profiles', authed(async (tx, ctx, req) => dl.listProfiles(tx, ctx, pageQuery.parse(req.query))));
  app.post('/api/import/profiles/:id/disable', authed(async (tx, ctx, req) => dl.disableProfile(tx, ctx, params(req).id)));
  app.get('/api/import/aliases', authed(async (tx, ctx, req) => dl.listAliases(tx, ctx, pageQuery.parse(req.query))));
  app.post('/api/import/aliases/:id/disable', authed(async (tx, ctx, req) => dl.disableAlias(tx, ctx, params(req).id)));

  // ---------- Import Hub (M04) ----------
  app.get('/api/import/templates/:kind', authed(async (_tx, ctx, req, reply) => {
    const t = await hub.template(ctx, ImportKind.parse(params(req).kind), ImportTemplateQuery.parse(req.query).format);
    reply.header('content-type', t.type).header('content-disposition', `attachment; filename="${t.fileName}"`);
    return t.body;
  }));
  app.post('/api/import/preview', UPLOAD, authed(async (tx, ctx, req) => hub.preview(tx, deps, ctx, ImportPreviewReq.parse(req.body))));
  app.post('/api/import/commit', UPLOAD, authed(async (tx, ctx, req, reply) => {
    reply.status(201);
    return hub.commit(tx, deps, ctx, ImportCommitReq.parse(req.body));
  }));
  app.get('/api/import/batches', authed(async (tx, ctx, req) => hub.listBatches(tx, ctx, pageQuery.parse(req.query))));

  // ---------- stock count, ledger, reorder (M06) ----------
  app.get('/api/stock-counts', authed(async (tx, ctx, req) => sx.listCounts(tx, ctx, pageQuery.parse(req.query))));
  app.post('/api/stock-counts', authed(async (tx, ctx, req, reply) => {
    reply.status(201);
    return sx.openCount(tx, deps, ctx, StockCountOpenReq.parse(req.body));
  }));
  app.get('/api/stock-counts/:id', authed(async (tx, ctx, req) => sx.getCount(tx, ctx, params(req).id, StockCountQuery.parse(req.query))));
  app.post('/api/stock-counts/:id/entries', authed(async (tx, ctx, req) => sx.countEntry(tx, ctx, params(req).id, StockCountEntryReq.parse(req.body))));
  app.post('/api/stock-counts/:id/submit', authed(async (tx, ctx, req) => sx.submitCount(tx, deps, ctx, params(req).id)));
  app.post('/api/stock-counts/:id/cancel', authed(async (tx, ctx, req) => sx.cancelCount(tx, ctx, params(req).id)));
  app.get('/api/stock/ledger', authed(async (tx, ctx, req) => sx.ledger(tx, ctx, LedgerQuery.parse(req.query))));
  app.get('/api/stock/reorder', authed(async (tx, ctx, req) => {
    requireAny(ctx, ['inv.view', 'inv.receive', 'fin.ap'], { readOnly: true });
    return sx.reorder(tx, ctx, pageQuery.parse(req.query));
  }));
};
