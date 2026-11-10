/**
 * Product picker for document lines (quotation, sales order, receiving, count, production…): partial search over
 * name / SKU / barcode / category with Thai word segmentation, 20 rows at a time, and the stock of each row in the
 * chosen warehouse (REQ: show how much stock each item has while adding lines). When the stock API returns
 * `available` (on hand − reserved by open sales orders) it is shown too.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { StockBalance, page, type Product } from '@erp/contracts';
import { d } from '@erp/core';
import { api } from '../api';
import { useCatalog } from '../data';
import { fq } from '../ui';
import { SearchSelect } from './SearchSelect';

export interface StockInfo { qty: string; reserved?: string; available?: string }

/** Stock per product in one warehouse (or all warehouses when warehouseId is empty). */
export function useStockInfo(warehouseId: string | null | undefined) {
  return useQuery({
    queryKey: ['stock', 'info', warehouseId ?? 'all'],
    staleTime: 15_000,
    queryFn: async () => {
      const out = new Map<string, StockInfo>();
      let cursor: string | undefined;
      const Row = StockBalance.passthrough();
      for (let i = 0; i < 50; i++) {
        const r = await api('GET', '/api/stock', { query: { warehouseId: warehouseId || undefined, limit: 100, cursor }, schema: page(Row), silent: true });
        for (const b of r.items as (z.infer<typeof Row> & { reserved?: string; available?: string })[]) {
          const cur = out.get(b.productId);
          const add = (a: string | undefined, x: string | undefined) => (x == null ? a : d(a ?? 0).plus(d(x)).toString());
          out.set(b.productId, cur
            ? { qty: d(cur.qty).plus(d(b.qty)).toString(), reserved: add(cur.reserved, b.reserved), available: add(cur.available, b.available) }
            : { qty: b.qty, reserved: b.reserved, available: b.available });
        }
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      return out;
    },
  });
}

/** "คงเหลือ 12 ถุง · พร้อมขาย 8" — red when nothing is available. */
export function StockText({ p, info }: { p: Product; info: StockInfo | undefined }) {
  if (p.kind !== 'stock') return <span className="muted">บริการ (ไม่นับสต็อก)</span>;
  const unit = p.units[0]?.name ?? '';
  const qty = d(info?.qty ?? 0);
  const avail = info?.available != null ? d(info.available) : null;
  const low = (avail ?? qty).lte(0);
  return (
    <span style={low ? { color: 'var(--bad)' } : undefined} data-stock={qty.toString()}>
      คงเหลือ {fq(qty)} {unit}{avail != null && !avail.eq(qty) ? ` · พร้อมขาย ${fq(avail)}` : ''}{low ? ' · ของหมด' : ''}
    </span>
  );
}

export function ProductPicker({ value, onChange, warehouseId, showStock = true, filter, testId = 'product', ariaLabel = 'สินค้า', invalid, disabled, name, style, placeholder, autoFocus }: {
  value: string | null;
  onChange: (id: string | null, p: Product | null) => void;
  /** Warehouse whose stock is shown; empty = total of all warehouses. */
  warehouseId?: string | null;
  showStock?: boolean;
  filter?: (p: Product) => boolean;
  testId?: string; ariaLabel?: string; invalid?: boolean; disabled?: boolean; name?: string; style?: React.CSSProperties; placeholder?: string; autoFocus?: boolean;
}) {
  const cat = useCatalog();
  const stock = useStockInfo(showStock ? warehouseId : undefined);
  const items = useMemo(() => (cat.data ?? []).filter((p) => p.active && (!filter || filter(p))), [cat.data, filter]);
  return (
    <SearchSelect<Product>
      value={value}
      onChange={onChange}
      items={items}
      getId={(p) => p.id}
      getLabel={(p) => p.name}
      getSub={(p) => (
        <>
          <span className="mono">{p.sku}</span>{p.category ? ` · ${p.category}` : ''}
          {showStock && <> · <StockText p={p} info={stock.data?.get(p.id)} /></>}
        </>
      )}
      getSearch={(p) => `${p.sku} ${p.barcode ?? ''} ${p.category}`}
      placeholder={placeholder ?? 'ค้นหาชื่อสินค้า / รหัส / บาร์โค้ด'}
      testId={testId}
      ariaLabel={ariaLabel}
      invalid={invalid}
      disabled={disabled}
      name={name}
      style={style}
      autoFocus={autoFocus}
    />
  );
}
