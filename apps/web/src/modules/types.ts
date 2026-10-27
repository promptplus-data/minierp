/**
 * Web module contract. Each module group exports `{ nav, routes }` from modules/<name>/index.tsx; the registry in
 * ./index.ts feeds the Shell (left nav) and the router. Module agents never edit Shell.tsx or main.tsx.
 */
import type { RouteObject } from 'react-router-dom';
import type { PermKey, PermValue } from '@erp/core';
import type { Capabilities, Edition } from '@erp/contracts';
import type { IconName } from './icons';

/** Nav sections in display order; each has a colour pair --c-<section> / --c-<section>-soft in styles.css. */
export const SECTIONS = {
  ov: 'ภาพรวม',
  sale: 'ขาย',
  inv: 'ซื้อและคลัง',
  data: 'ข้อมูลหลัก',
  hr: 'บุคคล',
  sys: 'ตั้งค่า',
  adm: 'SCG Admin',
} as const;
export type Section = keyof typeof SECTIONS;

export interface NavItem {
  /** Top-level path, e.g. '/ar'. Every route whose path starts with it is guarded by this item's visibility. */
  path: string;
  /** Thai label shown in the nav and the page header, e.g. 'ลูกหนี้ / รับชำระ'. */
  label: string;
  /** Module code shown next to the label and in the header, e.g. 'M10'. */
  code: string;
  section: Section;
  /** A key of ICONS (./icons.ts) or raw inner SVG markup for a 24×24 stroked icon. */
  icon: IconName | (string & {});
  /** Visible when the role has any of these permissions (core.perm(role, key) is not 0). Omit for everyone. */
  perm?: PermKey | readonly PermKey[];
  /** Only in this edition (build-time VITE_EDITION). */
  edition?: Edition;
  /** Only when GET /api/meta reports this capability as true. */
  capability?: keyof Capabilities;
  /** Extra condition, ANDed with the ones above. */
  show?: (can: (k: PermKey) => PermValue, caps: Partial<Capabilities>) => boolean;
  /** Sort order inside the section (default 100; core items use 10, 20, ...). */
  order?: number;
}

export interface WebModule {
  nav: NavItem[];
  /** Absolute paths ('/ar', '/ar/:no'). Elements are wrapped in a guard that redirects to '/' when the nav item
   *  with the longest matching path prefix is hidden for this user. Lazy-load big screens with React.lazy. */
  routes: RouteObject[];
}
