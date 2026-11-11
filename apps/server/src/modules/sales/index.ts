/**
 * "sales" module group (Agent A): M08 quotation / sales order / delivery order / B2B tax invoice / credit approval and
 * price lists, M10 receivables (billing notes, receipts, WHT, aging), M09 projects (installments, deposits).
 * Routes are listed in packages/contracts/src/modules/sales.ts (salesRoutes); every handler runs in one tenant-scoped
 * transaction (authed). Services live next to this file; tests in apps/server/test/sales/.
 */
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ArAgingQuery, ArBillingNoteReq, CustomerAddressReq, SalesLineCheckReq, ArInvoicesQuery, ArReceiptReq, ArStatementQuery, SalesAbbInvoiceReq, SalesDeliveryReq, SalesDepositActionReq, SalesDepositReq,
  SalesInstallmentsReq, SalesInvoiceReq, SalesOrderReq, SalesPageQuery, SalesPriceListReq, SalesPriceQuery, SalesProjectEditReq, SalesProjectReq, SalesQuoteReq, SalesQuoteStatusReq,
  SalesSettings, SalesSettingsUpdate, VoidReq,
} from '@erp/contracts';
import type { Tx } from '@erp/db';
import { writeAudit } from '../../lib/audit';
import { requireAny, requirePerm, type Ctx, type Deps } from '../../lib/context';
import type { ErpModule } from '../types';
import { creditInfo, loadCustomer, loadShop, resolveVatMode } from './common';
import { addCustomerAddress, customerAddresses, lineCheck, salesPeople } from './extras';
import { createDelivery, deliverySources, getDelivery, listDeliveries, voidDelivery } from './deliveries';
import { createInvoice, getInvoice, invoiceFromAbb, listCreditNotes, listInvoices } from './invoices';
import { createOrder, getOrder, listOrders, voidOrder } from './orders';
import { createPriceList, getPriceList, listPriceLists, resolveB2bPrice, updatePriceList } from './pricing';
import {
  billInstallment, createProject, editProject, forfeitDeposit, getProject, listProjects, receiveDeposit, refundDeposit, setInstallments, voidDeposit, voidProject,
} from './projects';
import { createQuote, getQuote, listQuotes, setQuoteStatus, updateQuote, voidQuote } from './quotes';
import { aging, createBillingNote, createReceipt, dueSoon, getBillingNote, getReceipt, listBillingNotes, listReceipts, openInvoices, statement, voidBillingNote, voidReceipt } from './receivables';

const param = (req: FastifyRequest, k: string) => (req.params as Record<string, string>)[k] ?? '';
const readSales = (ctx: Ctx) => requireAny(ctx, ['sales.doc', 'fin.ar', 'pos.sell', 'sales.project'], { readOnly: true });
const readAr = (ctx: Ctx) => requireAny(ctx, ['fin.ar', 'sales.doc'], { readOnly: true });
const readProjects = (ctx: Ctx) => requireAny(ctx, ['sales.project', 'fin.ar'], { readOnly: true });
const ProjectListQuery = SalesPageQuery.extend({ projectId: z.string().optional() });
const BillReq = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), note: z.string().max(500).optional() });
const ReasonReq = z.object({ reason: z.string().min(1).max(300) });

async function settings(tx: Tx, ctx: Ctx): Promise<SalesSettings> {
  const s = (await tx.query<{ quote_valid_days: number; default_credit_limit: string; bank_accounts: SalesSettings['banks'] }>(
    `select quote_valid_days, default_credit_limit::text, bank_accounts from sales_settings`)).rows[0];
  const shop = await loadShop(tx, ctx);
  return {
    quoteValidDays: s?.quote_valid_days ?? 15, defaultCreditLimit: s?.default_credit_limit ?? '50000.00', banks: s?.bank_accounts ?? [],
    shop: { name: shop.name, taxId: shop.tax_id, branch: shop.branch, address: shop.address, phone: shop.phone, vatRegistered: shop.vat_registered, b2bVatMode: shop.b2b_vat_mode },
  };
}

export const salesModule: ErpModule = async (app, { deps, authed }) => {
  const d: Deps = deps;

  // ---------- settings, price (BR-05), credit (BR-08) ----------
  app.get('/api/sales/settings', authed(async (tx, ctx) => { readSales(ctx); return settings(tx, ctx); }));
  app.patch('/api/sales/settings', authed(async (tx, ctx, req) => {
    requirePerm(ctx, 'sys.settings');
    const b = SalesSettingsUpdate.parse(req.body);
    await tx.query(
      `insert into sales_settings (tenant_id, quote_valid_days, default_credit_limit, bank_accounts) values ($1, coalesce($2, 15), coalesce($3, 50000), coalesce($4, '[]'::jsonb))
       on conflict (tenant_id) do update set quote_valid_days = coalesce($2, sales_settings.quote_valid_days), default_credit_limit = coalesce($3, sales_settings.default_credit_limit),
         bank_accounts = coalesce($4, sales_settings.bank_accounts), updated_at = now()`,
      [ctx.tenantId, b.quoteValidDays ?? null, b.defaultCreditLimit ?? null, b.banks ? JSON.stringify(b.banks) : null],
    );
    await writeAudit(tx, ctx, [{ action: 'update', object: 'sales-settings', detail: Object.keys(b).join(', ') }]);
    return settings(tx, ctx);
  }));
  app.get('/api/sales/price', authed(async (tx, ctx, req) => {
    readSales(ctx);
    const q = SalesPriceQuery.parse(req.query);
    const vatMode = await resolveVatMode(tx, ctx, q.vatMode);
    return resolveB2bPrice(tx, { customerId: q.customerId, productId: q.productId, unitIdx: q.unitIdx, qty: q.qty, date: q.date ?? d.today(), vatMode, doc: q.doc });
  }));
  app.post('/api/sales/line-check', authed(async (tx, ctx, req) => {
    requireAny(ctx, ['sales.doc'], { readOnly: true });
    return lineCheck(tx, ctx, SalesLineCheckReq.parse(req.body));
  }));
  app.get('/api/sales/salespeople', authed(async (tx, ctx) => { readSales(ctx); return salesPeople(tx); }));
  app.get('/api/sales/customers/:id/addresses', authed(async (tx, ctx, req) => {
    requireAny(ctx, ['sales.doc', 'inv.receive', 'sales.project'], { readOnly: true });
    return customerAddresses(tx, param(req, 'id'));
  }));
  app.post('/api/sales/customers/:id/addresses', authed(async (tx, ctx, req, reply) => {
    reply.status(201);
    return addCustomerAddress(tx, ctx, param(req, 'id'), CustomerAddressReq.parse(req.body));
  }));
  app.get('/api/sales/customers/:id/credit', authed(async (tx, ctx, req) => {
    readSales(ctx);
    const c = await loadCustomer(tx, param(req, 'id'));
    return { customerId: c.id, term: c.term, ...(await creditInfo(tx, d, c)) };
  }));

  // ---------- price lists ----------
  app.get('/api/sales/price-lists', authed(async (tx, ctx, req) => { requireAny(ctx, ['data.master', 'sales.doc'], { readOnly: true }); return listPriceLists(tx, SalesPageQuery.parse(req.query)); }));
  app.get('/api/sales/price-lists/:id', authed(async (tx, ctx, req) => { requireAny(ctx, ['data.master', 'sales.doc'], { readOnly: true }); return getPriceList(tx, param(req, 'id')); }));
  app.post('/api/sales/price-lists', authed(async (tx, ctx, req, reply) => { reply.status(201); return createPriceList(tx, ctx, SalesPriceListReq.parse(req.body)); }));
  app.patch('/api/sales/price-lists/:id', authed(async (tx, ctx, req) => updatePriceList(tx, ctx, param(req, 'id'), SalesPriceListReq.parse(req.body))));

  // ---------- quotations ----------
  app.get('/api/sales/quotations', authed(async (tx, ctx, req) => { readSales(ctx); return listQuotes(tx, d, SalesPageQuery.parse(req.query)); }));
  app.post('/api/sales/quotations', authed(async (tx, ctx, req, reply) => { reply.status(201); return createQuote(tx, d, ctx, SalesQuoteReq.parse(req.body)); }));
  app.get('/api/sales/quotations/:no', authed(async (tx, ctx, req) => { readSales(ctx); return getQuote(tx, d, ctx, param(req, 'no')); }));
  app.patch('/api/sales/quotations/:no', authed(async (tx, ctx, req) => updateQuote(tx, d, ctx, param(req, 'no'), SalesQuoteReq.parse(req.body))));
  app.post('/api/sales/quotations/:no/status', authed(async (tx, ctx, req) => setQuoteStatus(tx, d, ctx, param(req, 'no'), SalesQuoteStatusReq.parse(req.body).status)));
  app.post('/api/sales/quotations/:no/void', authed(async (tx, ctx, req) => voidQuote(tx, d, ctx, param(req, 'no'), VoidReq.parse(req.body))));

  // ---------- sales orders ----------
  app.get('/api/sales/orders', authed(async (tx, ctx, req) => { readSales(ctx); return listOrders(tx, ProjectListQuery.parse(req.query)); }));
  app.post('/api/sales/orders', authed(async (tx, ctx, req, reply) => { reply.status(201); return createOrder(tx, d, ctx, SalesOrderReq.parse(req.body)); }));
  app.get('/api/sales/orders/:no', authed(async (tx, ctx, req) => { readSales(ctx); return getOrder(tx, ctx, param(req, 'no')); }));
  app.post('/api/sales/orders/:no/void', authed(async (tx, ctx, req) => voidOrder(tx, d, ctx, param(req, 'no'), VoidReq.parse(req.body))));

  // ---------- delivery orders ----------
  app.get('/api/sales/deliveries', authed(async (tx, ctx, req) => {
    requireAny(ctx, ['sales.doc', 'inv.view', 'fin.ar', 'sales.project'], { readOnly: true });
    return listDeliveries(tx, ProjectListQuery.parse(req.query));
  }));
  app.get('/api/sales/delivery-sources', authed(async (tx, ctx, req) => { requireAny(ctx, ['sales.doc', 'inv.receive']); return deliverySources(tx, SalesPageQuery.parse(req.query)); }));
  app.post('/api/sales/deliveries', authed(async (tx, ctx, req, reply) => { reply.status(201); return createDelivery(tx, d, ctx, SalesDeliveryReq.parse(req.body)); }));
  app.get('/api/sales/deliveries/:no', authed(async (tx, ctx, req) => {
    requireAny(ctx, ['sales.doc', 'inv.view', 'fin.ar', 'sales.project'], { readOnly: true });
    return getDelivery(tx, ctx, param(req, 'no'));
  }));
  app.post('/api/sales/deliveries/:no/void', authed(async (tx, ctx, req) => voidDelivery(tx, d, ctx, param(req, 'no'), VoidReq.parse(req.body))));

  // ---------- B2B tax invoices (void: core POST /api/sales/docs/:no/void with the BR-22 guard in invoices.ts) ----------
  app.get('/api/sales/invoices', authed(async (tx, ctx, req) => { readSales(ctx); return listInvoices(tx, d, SalesPageQuery.parse(req.query)); }));
  app.post('/api/sales/invoices', authed(async (tx, ctx, req, reply) => { reply.status(201); return createInvoice(tx, d, ctx, SalesInvoiceReq.parse(req.body)); }));
  app.post('/api/sales/invoices/from-abb', authed(async (tx, ctx, req, reply) => { reply.status(201); return invoiceFromAbb(tx, d, ctx, SalesAbbInvoiceReq.parse(req.body)); }));
  app.get('/api/sales/invoices/:no', authed(async (tx, ctx, req) => { readSales(ctx); return getInvoice(tx, d, ctx, param(req, 'no')); }));
  app.get('/api/sales/credit-notes', authed(async (tx, ctx, req) => { readSales(ctx); return listCreditNotes(tx, SalesPageQuery.parse(req.query)); }));

  // ---------- projects ----------
  app.get('/api/sales/projects', authed(async (tx, ctx, req) => { readProjects(ctx); return listProjects(tx, SalesPageQuery.parse(req.query)); }));
  app.post('/api/sales/projects', authed(async (tx, ctx, req, reply) => { reply.status(201); return createProject(tx, d, ctx, SalesProjectReq.parse(req.body)); }));
  app.get('/api/sales/projects/:id', authed(async (tx, ctx, req) => { readProjects(ctx); return getProject(tx, d, param(req, 'id')); }));
  app.post('/api/sales/projects/:id/installments', authed(async (tx, ctx, req) => setInstallments(tx, d, ctx, param(req, 'id'), SalesInstallmentsReq.parse(req.body))));
  app.post('/api/sales/projects/:id/installments/:installmentId/bill', authed(async (tx, ctx, req, reply) => {
    reply.status(201);
    return billInstallment(tx, d, ctx, param(req, 'id'), param(req, 'installmentId'), BillReq.parse(req.body ?? {}));
  }));
  app.post('/api/sales/projects/:id/deposits', authed(async (tx, ctx, req, reply) => { reply.status(201); return receiveDeposit(tx, d, ctx, param(req, 'id'), SalesDepositReq.parse(req.body)); }));
  app.post('/api/sales/projects/:id/void', authed(async (tx, ctx, req) => voidProject(tx, d, ctx, param(req, 'id'), VoidReq.parse(req.body))));
  app.patch('/api/sales/projects/:id', authed(async (tx, ctx, req) => editProject(tx, d, ctx, param(req, 'id'), SalesProjectEditReq.parse(req.body))));
  app.post('/api/sales/deposits/:no/forfeit', authed(async (tx, ctx, req) => forfeitDeposit(tx, d, ctx, param(req, 'no'), SalesDepositActionReq.parse(req.body ?? {}))));
  app.post('/api/sales/deposits/:no/refund', authed(async (tx, ctx, req) => refundDeposit(tx, d, ctx, param(req, 'no'), SalesDepositActionReq.parse(req.body ?? {}))));
  app.post('/api/sales/deposits/:no/void', authed(async (tx, ctx, req) => voidDeposit(tx, d, ctx, param(req, 'no'), VoidReq.parse(req.body))));

  // ---------- receivables ----------
  app.get('/api/ar/aging', authed(async (tx, ctx, req) => { readAr(ctx); return aging(tx, d, ArAgingQuery.parse(req.query)); }));
  app.get('/api/ar/invoices', authed(async (tx, ctx, req) => { readAr(ctx); return openInvoices(tx, d, ArInvoicesQuery.parse(req.query)); }));
  app.get('/api/ar/due-soon', authed(async (tx, ctx, req) => {
    readAr(ctx);
    const days = z.coerce.number().int().min(1).max(60).default(7).parse((req.query as { days?: string }).days);
    return dueSoon(tx, d, days);
  }));
  app.get('/api/ar/statement', authed(async (tx, ctx, req) => { readAr(ctx); return statement(tx, d, ArStatementQuery.parse(req.query)); }));
  app.get('/api/ar/billing-notes', authed(async (tx, ctx, req) => { readAr(ctx); return listBillingNotes(tx, SalesPageQuery.parse(req.query)); }));
  app.post('/api/ar/billing-notes', authed(async (tx, ctx, req, reply) => { reply.status(201); return createBillingNote(tx, d, ctx, ArBillingNoteReq.parse(req.body)); }));
  app.get('/api/ar/billing-notes/:no', authed(async (tx, ctx, req) => { readAr(ctx); return getBillingNote(tx, param(req, 'no')); }));
  app.post('/api/ar/billing-notes/:no/void', authed(async (tx, ctx, req) => voidBillingNote(tx, ctx, param(req, 'no'), ReasonReq.parse(req.body).reason)));
  app.get('/api/ar/receipts', authed(async (tx, ctx, req) => { readAr(ctx); return listReceipts(tx, SalesPageQuery.parse(req.query)); }));
  app.post('/api/ar/receipts', authed(async (tx, ctx, req, reply) => { reply.status(201); return createReceipt(tx, d, ctx, ArReceiptReq.parse(req.body)); }));
  app.get('/api/ar/receipts/:no', authed(async (tx, ctx, req) => { readAr(ctx); return getReceipt(tx, param(req, 'no')); }));
  app.post('/api/ar/receipts/:no/void', authed(async (tx, ctx, req) => voidReceipt(tx, ctx, param(req, 'no'), ReasonReq.parse(req.body).reason)));

};
