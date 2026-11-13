/** TanStack Query hooks over the API. Every list is cursor paged; small lookups load all pages once. */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { Entitlements, featureForNavPath, type FeatureKey, Approver, Customer, Product, Shift, StockBalance, Vendor, Warehouse, page, type Page } from '@erp/contracts';
import { api } from './api';
import { useAuth } from './auth';

/**
 * GET /api/meta, parsed WITHOUT the contract's Meta schema: that schema names the cloud-only capability
 * flags, which must not appear in the on-prem bundle (scripts/check-onprem.mjs). Capabilities stay an
 * opaque record here; only files under src/promptplus/ read the cloud flags by name.
 */
const MetaLite = z.object({
  edition: z.enum(['cloud', 'onprem']),
  capabilities: z.record(z.boolean()),
  shop: z.object({ name: z.string(), taxId: z.string(), branch: z.string(), vatRegistered: z.boolean(), b2bVatMode: z.enum(['inc', 'exc']),
    belowCostApprover: z.enum(['owner', 'owner_or_manager', 'none']).default('owner') }),
  version: z.string(),
  needsSetup: z.boolean().default(false),
});
export type MetaLite = z.infer<typeof MetaLite>;

const BELOW_COST_NEED = { owner: 'ต้องให้เจ้าของร้านอนุมัติ', owner_or_manager: 'ต้องให้เจ้าของร้านหรือผู้จัดการอนุมัติ', none: 'ไม่ต้องขออนุมัติ (ระบบบันทึกประวัติไว้)' } as const;
/**
 * BR-16 shop setting (ตั้งค่าเอกสารขาย, owner only): who approves a below-cost sale. Every screen reads it here so the
 * PIN dialog lists the right approvers; the red "ต่ำกว่าทุน" flag is shown in every mode.
 */
export function useBelowCostRule() {
  const mode = useMeta().data?.shop.belowCostApprover ?? 'owner';
  return { mode, ownerOnly: mode === 'owner', need: BELOW_COST_NEED[mode], title: `ขายต่ำกว่าต้นทุน · ${BELOW_COST_NEED[mode]}` };
}

export function useMeta() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['meta', user?.id ?? null], queryFn: () => api('GET', '/api/meta', { schema: MetaLite }), staleTime: 5 * 60_000 });
}

/**
 * Menus SCG enabled for this shop (cloud: set live in SCG Admin; on-prem: inside the license key). While loading,
 * every menu counts as on, so the nav does not flash empty; the server refuses a switched-off menu either way.
 */
export function useFeatures(): ReadonlySet<FeatureKey> | null {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ['entitlements', user?.id ?? null], enabled: !!user, staleTime: 5 * 60_000,
    queryFn: () => api('GET', '/api/entitlements', { schema: Entitlements }),
  });
  return q.data ? new Set(q.data.features) : null;
}

/** Is the menu behind this in-app link switched on for the shop? For shortcuts outside the nav (home buttons, cards). */
export function useMenuOn(): (to: string) => boolean {
  const features = useFeatures();
  return (to) => {
    const owner = featureForNavPath(`/${to.split(/[/?#]/)[1] ?? ''}`);
    return !owner || !features || features.has(owner);
  };
}

/** Loads every page of a small list (lookups for selects and names). */
async function all<T>(path: string, item: z.ZodType<T, z.ZodTypeDef, unknown>, query: Record<string, string | number | boolean | undefined> = {}): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r: Page<T> = await api('GET', path, { query: { ...query, limit: 100, cursor }, schema: page(item) as unknown as z.ZodType<Page<T>, z.ZodTypeDef, unknown> });
    out.push(...r.items);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return out;
}

const STALE = 60_000;
type Wh = z.infer<typeof Warehouse>;
const sellableOnly = (ws: Wh[]) => ws.filter((w) => w.kind !== 'damaged');
/** Sellable warehouses: damaged-goods warehouses (คลังสินค้าชำรุด) never appear in sales, receiving or production pickers. */
export const useWarehouses = () => useQuery({ queryKey: ['warehouses'], queryFn: () => all('/api/warehouses', Warehouse), staleTime: STALE, select: sellableOnly });
/** Every warehouse incl. damaged-goods ones (stock screens: balances, transfers, write-offs, counts, ledger, name lookups). */
export const useAllWarehouses = () => useQuery({ queryKey: ['warehouses'], queryFn: () => all('/api/warehouses', Warehouse), staleTime: STALE });
export const useCustomers = () => useQuery({ queryKey: ['customers'], queryFn: () => all('/api/customers', Customer), staleTime: STALE });
export const useVendors = () => useQuery({ queryKey: ['vendors'], queryFn: () => all('/api/vendors', Vendor), staleTime: STALE });
export const useApprovers = () => useQuery({
  queryKey: ['approvers'],
  queryFn: async () => (await api('GET', '/api/users/approvers', { schema: z.object({ items: z.array(Approver) }) })).items,
  staleTime: STALE,
});

/** Active products for POS tiles, stock rows and name lookups. */
export function useCatalog() {
  const q = useQuery({ queryKey: ['catalog'], queryFn: () => all('/api/products', Product), staleTime: STALE });
  const byId = useMemo(() => new Map((q.data ?? []).map((p) => [p.id, p])), [q.data]);
  return { ...q, byId };
}

export const useShift = () => useQuery({ queryKey: ['shift'], queryFn: () => api('GET', '/api/shifts/current', { schema: Shift.nullable() }) });

/** Balances of one warehouse as productId → base qty. */
export function useWarehouseStock(warehouseId: string | undefined) {
  return useQuery({
    queryKey: ['stock', 'wh', warehouseId],
    enabled: !!warehouseId,
    queryFn: async () => new Map((await all('/api/stock', StockBalance, { warehouseId })).map((b) => [b.productId, b.qty])),
  });
}

export const productPage = page(Product);
