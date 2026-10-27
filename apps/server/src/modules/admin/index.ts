/**
 * "admin" module group: Agent D — M17 HR/payroll/leave, M14 SCG Admin, M19-07 export/import, M19-09 cloud backup, M19-10 sales-summary share, M19-11 license verification.
 * Put routes here and services / helpers next to this file (modules/admin/*.ts). Tests: apps/server/test/admin/*.test.ts.
 * Conventions: ../types.ts.
 */
import type { ErpModule } from '../types';

export const adminModule: ErpModule = async (_app, _opts) => {
  // const { deps, authed } = _opts;
  // _app.get('/api/...', authed(async (tx, ctx, req) => { ... }));
};
