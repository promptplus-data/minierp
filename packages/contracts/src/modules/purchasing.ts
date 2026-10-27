/**
 * API contract for the "purchasing" module group — Agent B (purchasing): M18 AP, M04 Import Hub, stock count/ledger/reorder, M05 GR-overdue, M19-08 delivery-file import.
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

export const purchasingRoutes = {} as const;

/** Routes registered on one edition only, e.g. { key: 'cloud' }. Unlisted routes must exist on both. */
export const purchasingRouteEditions: RouteEditions<typeof purchasingRoutes> = {};
