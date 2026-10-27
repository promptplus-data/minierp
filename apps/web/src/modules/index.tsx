/**
 * Web module registry: the Shell nav and the router read only from here. Module agents edit modules/<name>/,
 * not this file, Shell.tsx or main.tsx.
 */
import { Suspense, type ReactNode } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import type { PermKey, PermValue } from '@erp/core';
import type { Capabilities } from '@erp/contracts';
import { useAuth } from '../auth';
import { IS_CLOUD } from '../cloud';
import { useMeta } from '../data';
import { adminModule } from './admin';
import { coreModule } from './core';
import { purchasingModule } from './purchasing';
import { reportsModule } from './reports';
import { retailModule } from './retail';
import { salesModule } from './sales';
import { SECTIONS, type NavItem, type Section, type WebModule } from './types';

export const MODULES: readonly WebModule[] = [coreModule, salesModule, purchasingModule, retailModule, adminModule, reportsModule];

const sectionOrder = Object.keys(SECTIONS) as Section[];
export const NAV: readonly NavItem[] = MODULES.flatMap((m) => m.nav).sort(
  (a, b) => sectionOrder.indexOf(a.section) - sectionOrder.indexOf(b.section) || (a.order ?? 100) - (b.order ?? 100),
);

export function navVisible(item: NavItem, can: (k: PermKey) => PermValue, caps: Partial<Capabilities>): boolean {
  if (item.edition && item.edition !== (IS_CLOUD ? 'cloud' : 'onprem')) return false;
  if (item.capability && !caps[item.capability]) return false;
  if (item.perm !== undefined) {
    const keys: readonly PermKey[] = typeof item.perm === 'string' ? [item.perm] : item.perm;
    if (!keys.some((k) => !!can(k))) return false;
  }
  return item.show ? item.show(can, caps) : true;
}

/** Nav items the signed-in user may see, in display order. */
export function useVisibleNav(): NavItem[] {
  const { can } = useAuth();
  const meta = useMeta();
  const caps = meta.data?.capabilities ?? {};
  return NAV.filter((v) => navVisible(v, can, caps));
}

/** The nav item owning a path: the one with the longest path prefix (segment-aligned). */
export function navFor(pathname: string): NavItem | undefined {
  let best: NavItem | undefined;
  for (const v of NAV) {
    if ((pathname === v.path || pathname.startsWith(v.path.endsWith('/') ? v.path : `${v.path}/`)) && (!best || v.path.length > best.path.length)) best = v;
  }
  return best;
}

function Guard({ owner, children }: { owner: NavItem; children: ReactNode }) {
  const visible = useVisibleNav();
  return visible.includes(owner) ? <>{children}</> : <Navigate to="/" replace />;
}

const routePending = <div className="card"><div className="sk" /><div className="sk" /></div>;

/** Every module route, each element wrapped in Suspense (for lazy screens) and in its nav item's guard. */
export const MODULE_ROUTES: RouteObject[] = MODULES.flatMap((m) => m.routes).map((r) => {
  const owner = r.path ? navFor(r.path) : undefined;
  if (!r.element) return r;
  const el = <Suspense fallback={routePending}>{r.element}</Suspense>;
  return { ...r, element: owner ? <Guard owner={owner}>{el}</Guard> : el } as RouteObject;
});
