/**
 * Per-shop menu entitlements ("features"): which menus SCG lets each shop use.
 *
 * One registry drives everything: the SCG Admin switches (grouped, with packages), the shop nav and route guard
 * (`paths`), and the server guard (`api`: request-path prefixes that belong only to these menus). A prefix listed
 * under several features stays reachable while any of them is on (e.g. sales orders serve both B2B and projects).
 * APIs shared with always-on screens (products, warehouses, customers, documents lookup) are deliberately not listed:
 * turning a menu off hides its screen, it never breaks another screen's pickers.
 *
 * Always on, never listed: the shop overview, terms, the audit log, on-prem system page, and user management
 * (the พนักงาน page keeps its users tab; the `payroll` feature only gates the payroll tabs).
 *
 * Cloud: SCG Admin sets them live per shop (tenants.adm_features, null = all).
 * On-prem: they travel inside the signed license key (LicensePayload.features, absent = all).
 */
import { z } from 'zod';

export const FEATURE_GROUPS = {
  sale: 'ขาย',
  inv: 'ซื้อและคลัง',
  data: 'ข้อมูลหลัก',
  hr: 'บุคคล',
  sys: 'ตั้งค่า',
} as const;
export type FeatureGroup = keyof typeof FEATURE_GROUPS;

interface FeatureDef {
  readonly key: string;
  readonly group: FeatureGroup;
  readonly label: string;
  readonly code: string;
  /** Web nav paths this feature owns (the route guard hides every route under them). */
  readonly paths: readonly string[];
  /** API path prefixes owned by this feature (segment-aligned). */
  readonly api: readonly string[];
}

export const FEATURES = [
  { key: 'pos', group: 'sale', label: 'ขายหน้าร้าน (POS) และกะแคชเชียร์', code: 'M07', paths: ['/pos'], api: ['/api/pos', '/api/shifts', '/api/sales/pos'] },
  { key: 'salesDocs', group: 'sale', label: 'เอกสารขาย', code: 'M08', paths: ['/sales'], api: [] },
  { key: 'b2b', group: 'sale', label: 'ขายส่ง / เงินเชื่อ', code: 'M08', paths: ['/b2b'],
    api: ['/api/sales/quotations', '/api/sales/orders', '/api/sales/deliveries', '/api/sales/invoices', '/api/sales/deposits', '/api/sales/settings'] },
  { key: 'projects', group: 'sale', label: 'ขายโครงการ', code: 'M09', paths: ['/projects'],
    api: ['/api/sales/projects', '/api/sales/orders', '/api/sales/deliveries', '/api/sales/invoices', '/api/sales/deposits'] },
  { key: 'ar', group: 'sale', label: 'ลูกหนี้ / รับชำระ', code: 'M10', paths: ['/ar'], api: ['/api/ar'] },
  { key: 'returns', group: 'sale', label: 'รับคืนสินค้า', code: 'M08', paths: ['/returns'], api: ['/api/returns', '/api/sales/credit-notes'] },
  { key: 'promos', group: 'sale', label: 'โปรโมชั่นของร้าน', code: 'M15', paths: ['/promos'], api: ['/api/promos', '/api/reports/promotions'] },
  { key: 'purchasing', group: 'inv', label: 'ซื้อเข้า / รับของ', code: 'M05', paths: ['/purchasing'],
    api: ['/api/purchasing', '/api/purchase-orders', '/api/gr-drafts', '/api/delivery-imports'] },
  { key: 'stock', group: 'inv', label: 'คลังสินค้า', code: 'M06', paths: ['/stock'], api: ['/api/stock/transfers', '/api/stock/issues', '/api/stock/adjust-requests'] },
  { key: 'stockLedger', group: 'inv', label: 'สมุดคุมสต็อก', code: 'M06', paths: ['/stock-ledger'], api: ['/api/stock/ledger'] },
  { key: 'stockCount', group: 'inv', label: 'นับสต็อก', code: 'M06', paths: ['/stock-count'], api: ['/api/stock-counts'] },
  { key: 'ap', group: 'inv', label: 'เจ้าหนี้ / จ่ายเงิน', code: 'M18', paths: ['/ap'], api: ['/api/ap'] },
  { key: 'production', group: 'inv', label: 'การผลิต', code: 'M16', paths: ['/production'], api: ['/api/mos', '/api/boms'] },
  { key: 'products', group: 'data', label: 'สินค้าและหน่วยนับ', code: 'M03', paths: ['/products'], api: [] },
  { key: 'warehouses', group: 'data', label: 'คลังและประเภทคลัง', code: 'M06', paths: ['/warehouses'], api: [] },
  { key: 'priceLists', group: 'data', label: 'ราคาตามลูกค้า', code: 'M03', paths: ['/price-lists'], api: ['/api/price-lists', '/api/sales/price-lists'] },
  { key: 'productImages', group: 'data', label: 'รูปสินค้าในหน้าขาย', code: 'M07', paths: ['/product-images'], api: [] },
  { key: 'import', group: 'data', label: 'นำเข้าข้อมูล', code: 'M04', paths: ['/import'], api: ['/api/import'] },
  { key: 'reports', group: 'data', label: 'รายงาน', code: 'M11', paths: ['/reports'],
    api: ['/api/reports/sales', '/api/reports/stock', '/api/reports/vat', '/api/reports/costs', '/api/reports/coupons'] },
  { key: 'acctExport', group: 'data', label: 'ส่งออกให้นักบัญชี', code: 'M12', paths: ['/export'], api: ['/api/acct-export'] },
  { key: 'payroll', group: 'hr', label: 'เงินเดือนและค่าใช้จ่ายพนักงาน', code: 'M17', paths: [],
    api: ['/api/hr/payroll', '/api/hr/payslip-periods', '/api/hr/labour-cost', '/api/hr/settings'] },
  { key: 'leave', group: 'hr', label: 'วันลา', code: 'M17', paths: ['/leave'], api: ['/api/hr/leaves', '/api/hr/leave-balances'] },
  { key: 'posDevices', group: 'sys', label: 'เครื่อง POS และ ภ.พ.06', code: 'M01', paths: ['/pos-devices'], api: ['/api/pos-devices'] },
] as const satisfies readonly FeatureDef[];

export type FeatureKey = (typeof FEATURES)[number]['key'];
export const FEATURE_KEYS = FEATURES.map((f) => f.key) as unknown as readonly [FeatureKey, ...FeatureKey[]];
export const FeatureKey = z.enum(FEATURE_KEYS);
/** A stored or signed feature list: unknown keys (from a newer SCG Admin) are dropped, not rejected. */
export const FeatureList = z.array(z.string()).transform((xs) => FEATURE_KEYS.filter((k) => xs.includes(k)));

/** Ready-made sets for the SCG Admin picker. */
export const FEATURE_PACKAGES: readonly { id: string; label: string; features: readonly FeatureKey[] }[] = [
  { id: 'all', label: 'ครบทุกเมนู', features: FEATURE_KEYS },
  { id: 'retail', label: 'ร้านขายปลีก (หน้าร้านเป็นหลัก)',
    features: ['pos', 'salesDocs', 'returns', 'promos', 'purchasing', 'stock', 'stockLedger', 'stockCount', 'ap', 'products', 'warehouses', 'productImages', 'import', 'reports', 'acctExport', 'posDevices'] },
  { id: 'wholesale', label: 'ร้านขายส่ง / โครงการ (ไม่มีหน้าร้าน)',
    features: ['salesDocs', 'b2b', 'projects', 'ar', 'returns', 'purchasing', 'stock', 'stockLedger', 'stockCount', 'ap', 'products', 'warehouses', 'priceLists', 'import', 'reports', 'acctExport'] },
];

/** Resolves a stored list (null/undefined = every feature) to the enabled set. */
export const enabledFeatures = (stored: readonly string[] | null | undefined): ReadonlySet<FeatureKey> =>
  new Set(stored == null ? FEATURE_KEYS : FEATURE_KEYS.filter((k) => stored.includes(k)));

const API_OWNERS: ReadonlyMap<string, readonly FeatureKey[]> = (() => {
  const m = new Map<string, FeatureKey[]>();
  for (const f of FEATURES) for (const p of f.api) m.set(p, [...(m.get(p) ?? []), f.key]);
  return m;
})();
const NAV_OWNER: ReadonlyMap<string, FeatureKey> = new Map(FEATURES.flatMap((f) => f.paths.map((p) => [p, f.key] as const)));

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** Server side: may this request path be served with these features on? Paths no feature owns are always allowed. */
export function apiAllowed(path: string, enabled: ReadonlySet<FeatureKey>): boolean {
  let best: string | undefined;
  for (const p of API_OWNERS.keys()) if (under(path, p) && (!best || p.length > best.length)) best = p;
  return best === undefined || API_OWNERS.get(best)!.some((k) => enabled.has(k));
}

/** Web side: the feature owning a nav path, if any (nav items the registry does not list are always on). */
export const featureForNavPath = (path: string): FeatureKey | undefined => NAV_OWNER.get(path);

/** GET /api/entitlements: the signed-in shop's enabled features (resolved list). */
export const Entitlements = z.object({ features: z.array(FeatureKey) });
export type Entitlements = z.infer<typeof Entitlements>;
/** POST /api/adm/tenants/:id/features body; null = every feature (also the default for a new shop). */
export const AdmFeaturesSet = z.object({ features: z.array(FeatureKey).nullable() });
