/**
 * Lazy lists (REQ: long lists load 10-20 rows at a time). `useLoadMore` pages a cursor API with TanStack
 * infinite queries; `LoadMore` is the footer row that loads the next page when it scrolls into view (or on tap).
 */
import { useEffect, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { page, type Page } from '@erp/contracts';
import { api } from '../api';

type Q = Record<string, string | number | boolean | undefined | null>;

export function useLoadMore<T>(key: readonly unknown[], path: string, item: z.ZodType<T, z.ZodTypeDef, unknown>, query: Q = {}, pageSize = 20, enabled = true) {
  const schema = page(item) as unknown as z.ZodType<Page<T>, z.ZodTypeDef, unknown>;
  const clean = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '' && v != null)) as Record<string, string | number | boolean>;
  const r = useInfiniteQuery({
    queryKey: [...key, clean, pageSize],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api('GET', path, { query: { ...clean, limit: pageSize, cursor: pageParam }, schema }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = r.data?.pages.flatMap((p) => p.items) ?? [];
  return { ...r, rows };
}

/** Footer that fetches the next page when visible. Put it after a table or list. */
export function LoadMore({ hasMore, loading, onMore, count, testId = 'load-more' }: { hasMore: boolean; loading: boolean; onMore: () => void; count?: number; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting) && !loading) onMore(); }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, onMore]);
  if (!hasMore && count == null) return null;
  return (
    <div ref={ref} className="loadmore" data-testid={testId}>
      {hasMore
        ? <button type="button" className="btn sm" onClick={onMore} disabled={loading}>{loading ? 'กำลังโหลด…' : 'โหลดเพิ่ม'}</button>
        : <span className="small muted">แสดงครบ {count} รายการ</span>}
    </div>
  );
}
