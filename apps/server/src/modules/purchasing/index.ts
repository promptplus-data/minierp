/**
 * "purchasing" module group: Agent B — M18 AP, payment vouchers, vendor returns, M04 Import Hub, stock count/ledger/reorder, M05 GR-overdue alert, M19-08 delivery-file import.
 * Put routes here and services / helpers next to this file (modules/purchasing/*.ts). Tests: apps/server/test/purchasing/*.test.ts.
 * Conventions: ../types.ts.
 */
import type { ErpModule } from '../types';

export const purchasingModule: ErpModule = async (_app, _opts) => {
  // const { deps, authed } = _opts;
  // _app.get('/api/...', authed(async (tx, ctx, req) => { ... }));
};
