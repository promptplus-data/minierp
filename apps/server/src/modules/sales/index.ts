/**
 * "sales" module group: Agent A — M08 quotation/SO/DO/invoice/credit approval, M10 AR (billing note, receipts, WHT, aging), M09 projects.
 * Put routes here and services / helpers next to this file (modules/sales/*.ts). Tests: apps/server/test/sales/*.test.ts.
 * Conventions: ../types.ts.
 */
import type { ErpModule } from '../types';

export const salesModule: ErpModule = async (_app, _opts) => {
  // const { deps, authed } = _opts;
  // _app.get('/api/...', authed(async (tx, ctx, req) => { ... }));
};
