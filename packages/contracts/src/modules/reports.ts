/**
 * API contract for the "reports" module group — Agent E (reports): M11 reports, M12 PEAK/FlowAccount/Express export.
 * Only this module's agent edits this file. Import shared building blocks from '../core'
 * (Dec, DecNN, pageQuery, page, Approval, Discount, ...). Every name exported here is re-exported from
 * '@erp/contracts', so prefix ambiguous names with the module (e.g. `ArReceipt`, not `Receipt`).
 *
 * Route keys are merged into `routes` in ../index.ts: add `key: 'METHOD /api/<path>'` below.
 * Keep Prompt Plus names out of this file (scripts/check-onprem.mjs).
 */
// import { z } from 'zod';
// import { Dec, DecNN, pageQuery } from '../core';
import type { RouteEditions } from '../core';

export const reportsRoutes = {} as const;

/** Routes registered on one edition only, e.g. { key: 'cloud' }. Unlisted routes must exist on both. */
export const reportsRouteEditions: RouteEditions<typeof reportsRoutes> = {};
