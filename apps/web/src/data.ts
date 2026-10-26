/** TanStack Query hooks over the API. Every list is cursor paged; small lookups load all pages once. */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { Approver, Customer, Product, Shift, StockBalance, Vendor, Warehouse, page, type Page } from '@erp/contracts';
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
  shop: z.object({ name: z.string(), taxId: z.string(), branch: z.string(), vatRegistered: z.boolean(), b2bVatMode: z.enum(['inc', 'exc']) }),
  version: z.string(),
});
export type MetaLite = z.infer<typeof MetaLite>;

export function useMeta() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['meta', user?.id ?? null], queryFn: () => api('GET', '/api/meta', { schema: MetaLite }), staleTime: 5 * 60_000 });
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
export const useWarehouses = () => useQuery({ queryKey: ['warehouses'], queryFn: () => all('/api/warehouses', Warehouse), staleTime: STALE });
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
