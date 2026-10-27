/**
 * API contract shared by apps/server and apps/web.
 * Money and quantities travel as decimal strings ("145.00", "118.3400") — never JS floats.
 * Every list endpoint is cursor-paged (NFR-12): ?limit=20&cursor=<opaque>.
 *
 * Layout: ./core.ts (phase 1) and one file per module group in ./modules. Each module agent edits only its own
 * file; this index re-exports them and merges their route tables. Do not add schemas here.
 */
import { coreRouteEditions, coreRoutes } from './core';
import { salesRouteEditions, salesRoutes } from './modules/sales';
import { purchasingRouteEditions, purchasingRoutes } from './modules/purchasing';
import { retailRouteEditions, retailRoutes } from './modules/retail';
import { adminRouteEditions, adminRoutes } from './modules/admin';
import { reportsRouteEditions, reportsRoutes } from './modules/reports';

export * from './core';
export * from './modules/sales';
export * from './modules/purchasing';
export * from './modules/retail';
export * from './modules/admin';
export * from './modules/reports';

/** Route table — the single source of truth both apps import. Duplicate keys or endpoints throw at import time. */
// @__PURE__ lets bundlers drop the table (and its cloud-only paths) when nothing reads it, as in the on-prem server.
export const routes = /* @__PURE__ */ mergeRoutes(coreRoutes, salesRoutes, purchasingRoutes, retailRoutes, adminRoutes, reportsRoutes);
export type RouteKey = keyof typeof routes;
/** Edition-only routes across all modules; anything not listed is on both editions. */
export const routeEditions: Partial<Record<RouteKey, 'cloud' | 'onprem'>> = /* @__PURE__ */ Object.assign(
  {}, coreRouteEditions, salesRouteEditions, purchasingRouteEditions, retailRouteEditions, adminRouteEditions, reportsRouteEditions,
);

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

function mergeRoutes<T extends Record<string, string>[]>(...tables: T): UnionToIntersection<T[number]> {
  const out: Record<string, string> = {};
  const endpoints = new Map<string, string>();
  for (const t of tables) {
    for (const [k, v] of Object.entries(t)) {
      if (k in out) throw new Error(`@erp/contracts: duplicate route key "${k}"`);
      const prev = endpoints.get(v);
      if (prev) throw new Error(`@erp/contracts: "${v}" is declared as both "${prev}" and "${k}"`);
      out[k] = v;
      endpoints.set(v, k);
    }
  }
  return out as UnionToIntersection<T[number]>;
}
