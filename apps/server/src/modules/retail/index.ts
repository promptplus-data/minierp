/**
 * "retail" module group (Agent C): M15 promotions (discount + bundle in POS), M16 production (BOM / MO), held POS bills,
 * customer price lists (BR-05), product images and POS machines (REQ-M01-07). Routes: packages/contracts/src/modules/retail.ts.
 * The POS sale itself stays in services/sales.ts, which calls ./pricing (promo / bundle / price list) and ./devices (POS ID).
 */
import { z } from 'zod';
import {
  Approval, BomInput, BomListQuery, HeldListQuery, HoldReq, MoCancelReq, MoCloseReq, MoCreateReq, MoListQuery, MoOutputReq, MoReportQuery, MoSuggestReq,
  PosDeviceInput, PosDeviceListQuery, PosDeviceUpdate, PosPricingQuery, PriceListInput, PriceListUpdate, PriceResolveQuery, ProductImagePut, PromoInput,
  PromoListQuery, PromoPnlQuery, PromoUpdate, pageQuery,
} from '@erp/contracts';
import { requireAny } from '../../lib/context';
import type { ErpModule } from '../types';
import { posVatMode } from './common';
import { createDevice, listDevices, updateDevice } from './devices';
import { discardHeld, holdBill, listHeld, resumeHeld } from './held';
import { getImage, listImages, putImage, removeImage } from './images';
import { createPriceList, getPriceList, listPriceLists, updatePriceList } from './pricelists';
import { posPricing, resolveSalePrice } from './pricing';
import { activateBom, cancelMo, closeMo, createMo, getMo, listBoms, listMos, moReport, recordOutput, saveBom, suggestMo } from './production';
import { activatePromo, checkPromo, closePromo, createPromo, getPromo, listPromos, promoPnl, updatePromo } from './promos';

const param = <K extends string>(req: { params: unknown }, k: K): string => (req.params as Record<K, string>)[k];

export const retailModule: ErpModule = async (app, { deps, authed }) => {
  // ---------- M15 promotions ----------
  app.get('/api/promos', authed(async (tx, ctx, req) => listPromos(tx, deps, ctx, PromoListQuery.parse(req.query))));
  app.post('/api/promos', authed(async (tx, ctx, req, reply) => {
    const p = await createPromo(tx, deps, ctx, PromoInput.parse(req.body));
    reply.status(201);
    return p;
  }));
  app.post('/api/promos/check', authed(async (tx, ctx, req) => checkPromo(tx, ctx, PromoInput.parse(req.body))));
  app.get('/api/promos/pnl', authed(async (tx, ctx, req) => promoPnl(tx, deps, ctx, PromoPnlQuery.parse(req.query))));
  app.get('/api/promos/:id', authed(async (tx, ctx, req) => getPromo(tx, deps, ctx, param(req, 'id'))));
  app.patch('/api/promos/:id', authed(async (tx, ctx, req) => updatePromo(tx, deps, ctx, param(req, 'id'), PromoUpdate.parse(req.body))));
  app.post('/api/promos/:id/close', authed(async (tx, ctx, req) =>
    closePromo(tx, deps, ctx, param(req, 'id'), z.object({ reason: z.string().max(200).optional() }).parse(req.body ?? {}).reason)));
  app.post('/api/promos/:id/activate', authed(async (tx, ctx, req) =>
    activatePromo(tx, deps, ctx, param(req, 'id'), z.object({ belowCostApproval: Approval.optional() }).parse(req.body ?? {}).belowCostApproval)));

  // ---------- POS pricing (promos, bundles, customer prices, images) ----------
  app.get('/api/pos/pricing', authed(async (tx, ctx, req) => posPricing(tx, deps, ctx, PosPricingQuery.parse(req.query))));

  // ---------- REQ-M07-08 held bills ----------
  app.get('/api/pos/held', authed(async (tx, ctx, req) => listHeld(tx, ctx, HeldListQuery.parse(req.query))));
  app.post('/api/pos/held', authed(async (tx, ctx, req, reply) => {
    const h = await holdBill(tx, ctx, HoldReq.parse(req.body));
    reply.status(201);
    return h;
  }));
  app.post('/api/pos/held/:id/resume', authed(async (tx, ctx, req) => resumeHeld(tx, ctx, param(req, 'id'))));
  app.post('/api/pos/held/:id/discard', authed(async (tx, ctx, req) => discardHeld(tx, ctx, param(req, 'id'))));

  // ---------- BR-05 price lists ----------
  app.get('/api/price-lists', authed(async (tx, ctx, req) => listPriceLists(tx, ctx, pageQuery.parse(req.query))));
  app.post('/api/price-lists', authed(async (tx, ctx, req, reply) => {
    const l = await createPriceList(tx, ctx, PriceListInput.parse(req.body));
    reply.status(201);
    return l;
  }));
  app.get('/api/price-lists/resolve', authed(async (tx, ctx, req) => {
    requireAny(ctx, ['pos.sell', 'sales.doc', 'data.master'], { readOnly: true });
    const q = PriceResolveQuery.parse(req.query);
    return resolveSalePrice(tx, { ...q, date: q.date ?? deps.today(), vatMode: await posVatMode(tx, ctx.tenantId) });
  }));
  app.get('/api/price-lists/:id', authed(async (tx, ctx, req) => getPriceList(tx, ctx, param(req, 'id'))));
  app.patch('/api/price-lists/:id', authed(async (tx, ctx, req) => updatePriceList(tx, ctx, param(req, 'id'), PriceListUpdate.parse(req.body))));

  // ---------- REQ-M07-11 product images ----------
  app.get('/api/product-images', authed(async (tx, _ctx, req) => listImages(tx, pageQuery.parse(req.query))));
  app.get('/api/product-images/:productId', authed(async (tx, _ctx, req, reply) => {
    const img = await getImage(tx, param(req, 'productId'));
    // Versioned URLs (?v=) never change content, so the browser may keep them.
    reply.header('cache-control', 'private, max-age=86400');
    return img;
  }));
  app.post('/api/product-images/:productId', { bodyLimit: 512 * 1024 }, authed(async (tx, ctx, req) =>
    putImage(tx, ctx, param(req, 'productId'), ProductImagePut.parse(req.body))));
  app.post('/api/product-images/:productId/remove', authed(async (tx, ctx, req) => removeImage(tx, ctx, param(req, 'productId'))));

  // ---------- REQ-M01-07 POS machines ----------
  app.get('/api/pos-devices', authed(async (tx, ctx, req) => listDevices(tx, ctx, PosDeviceListQuery.parse(req.query))));
  app.post('/api/pos-devices', authed(async (tx, ctx, req, reply) => {
    const dv = await createDevice(tx, ctx, PosDeviceInput.parse(req.body));
    reply.status(201);
    return dv;
  }));
  app.patch('/api/pos-devices/:id', authed(async (tx, ctx, req) => updateDevice(tx, ctx, param(req, 'id'), PosDeviceUpdate.parse(req.body))));

  // ---------- M16 production ----------
  app.get('/api/boms', authed(async (tx, ctx, req) => listBoms(tx, ctx, BomListQuery.parse(req.query))));
  app.post('/api/boms', authed(async (tx, ctx, req, reply) => {
    const b = await saveBom(tx, ctx, BomInput.parse(req.body));
    reply.status(201);
    return b;
  }));
  app.post('/api/boms/:id/activate', authed(async (tx, ctx, req) => activateBom(tx, ctx, param(req, 'id'))));
  app.get('/api/mos', authed(async (tx, ctx, req) => listMos(tx, ctx, MoListQuery.parse(req.query))));
  app.post('/api/mos/suggest', authed(async (tx, ctx, req) => suggestMo(tx, ctx, MoSuggestReq.parse(req.body))));
  app.post('/api/mos', authed(async (tx, ctx, req, reply) => {
    const m = await createMo(tx, deps, ctx, MoCreateReq.parse(req.body));
    reply.status(201);
    return m;
  }));
  app.get('/api/mos/report', authed(async (tx, ctx, req) => moReport(tx, ctx, MoReportQuery.parse(req.query))));
  app.get('/api/mos/:no', authed(async (tx, ctx, req) => getMo(tx, ctx, param(req, 'no'))));
  app.post('/api/mos/:no/outputs', authed(async (tx, ctx, req) => recordOutput(tx, ctx, param(req, 'no'), MoOutputReq.parse(req.body))));
  app.post('/api/mos/:no/close', authed(async (tx, ctx, req) => closeMo(tx, deps, ctx, param(req, 'no'), MoCloseReq.parse(req.body ?? {}))));
  app.post('/api/mos/:no/cancel', authed(async (tx, ctx, req) => cancelMo(tx, ctx, param(req, 'no'), MoCancelReq.parse(req.body).reason)));
};
