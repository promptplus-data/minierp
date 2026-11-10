/**
 * Searchable picker used for every entity dropdown (customer, product, project, vendor, address, employee…).
 * - partial search with Thai word segmentation (`matchesSearch` from core): "ปูนช้าง" finds "ปูนซีเมนต์ตราช้าง"
 * - lazy list: shows 20 rows and adds 20 more as the list scrolls (local items) or fetches the next page (remote)
 * - optional "+ สร้างใหม่" row that hands the typed text to the caller (quick-create customer etc.)
 * Keyboard: ↑ ↓ Enter Esc. Touch: rows are 44px+, the input works with the on-screen keyboard.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { matchesSearch, searchRank } from '@erp/core';
import { useDebounced } from '../ui';

export const PAGE = 20;

export interface RemotePage<T> { items: T[]; nextCursor: string | null }

export interface SearchSelectProps<T> {
  value: string | null;
  onChange: (id: string | null, item: T | null) => void;
  /** Local rows, filtered in the browser. Use for lists that are already loaded (warehouses, units of one product…). */
  items?: readonly T[];
  /** Remote rows: one page of `limit` rows for a query. Used instead of `items` for large lists. */
  fetchPage?: (q: string, cursor: string | undefined, limit: number) => Promise<RemotePage<T>>;
  /** Query key prefix for remote pages (cache per list). */
  queryKey?: readonly unknown[];
  getId: (x: T) => string;
  getLabel: (x: T) => string;
  getSub?: (x: T) => ReactNode;
  /** Extra text searched besides the label (code, phone, tax id, barcode…). */
  getSearch?: (x: T) => string;
  /** Row shown for value = null (e.g. "ลูกค้าทั่วไป"). Without it the picker cannot be cleared. */
  emptyLabel?: string;
  /** The selected row when it is not among `items` / loaded pages (e.g. a saved document). */
  selected?: T | null;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Adds "+ {createLabel} "{text}"" at the end; called with the typed text. */
  onCreate?: (text: string) => void;
  createLabel?: string;
  isDisabled?: (x: T) => string | false;
  testId?: string;
  name?: string;
  ariaLabel?: string;
  style?: React.CSSProperties;
  autoFocus?: boolean;
}

export function SearchSelect<T>(p: SearchSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [hi, setHi] = useState(0);
  const [shown, setShown] = useState(PAGE);
  const [picked, setPicked] = useState<T | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const q = useDebounced(text, p.fetchPage ? 250 : 0);

  const remote = useInfiniteQuery({
    queryKey: [...(p.queryKey ?? ['pick']), q],
    enabled: !!p.fetchPage && open,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => p.fetchPage!(q.trim(), pageParam, PAGE),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });

  const hay = (x: T) => `${p.getLabel(x)} ${p.getSearch?.(x) ?? ''}`;
  const localRows = useMemo(() => {
    if (!p.items) return [];
    if (!text.trim()) return [...p.items];
    return p.items.filter((x) => matchesSearch(hay(x), text)).sort((a, b) => searchRank(p.getLabel(a), text) - searchRank(p.getLabel(b), text));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.items, text]);
  const remoteRows = useMemo(() => remote.data?.pages.flatMap((x) => x.items) ?? [], [remote.data]);
  const rows = p.fetchPage ? remoteRows : localRows.slice(0, shown);
  const more = p.fetchPage ? !!remote.hasNextPage : localRows.length > shown;

  const current = useMemo(() => {
    if (p.value == null) return null;
    const find = (xs: readonly T[] | undefined) => xs?.find((x) => p.getId(x) === p.value) ?? null;
    return find(p.items) ?? (picked && p.getId(picked) === p.value ? picked : null) ?? (p.selected && p.getId(p.selected) === p.value ? p.selected : null) ?? find(remoteRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.value, p.items, picked, p.selected, remoteRows]);

  type Opt = { k: 'empty' } | { k: 'row'; x: T } | { k: 'create' };
  const opts: Opt[] = [
    ...(p.emptyLabel && !text.trim() ? [{ k: 'empty' } as const] : []),
    ...rows.map((x) => ({ k: 'row', x }) as const),
    ...(p.onCreate ? [{ k: 'create' } as const] : []),
  ];

  useEffect(() => { setHi(0); setShown(PAGE); }, [text]);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent | TouchEvent) => { if (!wrap.current?.contains(e.target as Node)) close(); };
    document.addEventListener('mousedown', off);
    document.addEventListener('touchstart', off);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('touchstart', off); };
  });
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const close = () => { setOpen(false); setText(''); };
  const choose = (o: Opt) => {
    if (o.k === 'create') { const t = text.trim(); close(); p.onCreate!(t); return; }
    if (o.k === 'row') {
      const why = p.isDisabled?.(o.x);
      if (why) return;
      setPicked(o.x);
      p.onChange(p.getId(o.x), o.x);
    } else p.onChange(null, null);
    close();
    input.current?.blur();
  };
  const loadMore = () => {
    if (p.fetchPage) { if (remote.hasNextPage && !remote.isFetchingNextPage) void remote.fetchNextPage(); }
    else setShown((n) => n + PAGE);
  };
  const onScroll = (e: React.UIEvent<HTMLUListElement>) => {
    const el = e.currentTarget;
    if (more && el.scrollTop + el.clientHeight >= el.scrollHeight - 60) loadMore();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else setHi((h) => { const n = Math.min(opts.length - 1, h + 1); if (n >= opts.length - 3 && more) loadMore(); return n; }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    else if (e.key === 'Enter') { if (open && opts[hi]) { e.preventDefault(); choose(opts[hi]!); } }
    else if (e.key === 'Escape') { if (open) { e.stopPropagation(); close(); } }
    else if (e.key === 'Tab') close();
  };

  const label = current ? p.getLabel(current) : p.value == null ? (p.emptyLabel ?? '') : '';
  const loading = p.fetchPage ? remote.isLoading : false;

  return (
    <div className={`ss${open ? ' open' : ''}${p.invalid ? ' bad' : ''}`} ref={wrap} style={p.style} data-testid={p.testId}>
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={p.ariaLabel}
        aria-invalid={p.invalid || undefined}
        name={p.name}
        data-field={p.name}
        disabled={p.disabled}
        autoFocus={p.autoFocus}
        autoComplete="off"
        value={open ? text : label}
        placeholder={open ? (label || p.placeholder || 'พิมพ์เพื่อค้นหา') : (p.placeholder ?? 'เลือก / พิมพ์เพื่อค้นหา')}
        onFocus={() => { setOpen(true); setText(''); }}
        onClick={() => setOpen(true)}
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onKeyDown={onKey}
        data-testid={p.testId ? `${p.testId}-input` : undefined}
      />
      <span className="ss-caret" aria-hidden>▾</span>
      {open && (
        <ul className="ss-list" role="listbox" id={listId} ref={listRef} onScroll={onScroll} data-testid={p.testId ? `${p.testId}-list` : undefined}>
          {opts.map((o, i) => {
            if (o.k === 'empty') return <li key="__empty" role="option" aria-selected={p.value == null} data-i={i} className={`${hi === i ? 'hi' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o)} onMouseEnter={() => setHi(i)}>{p.emptyLabel}</li>;
            if (o.k === 'create') return <li key="__create" role="option" aria-selected={false} data-i={i} className={`ss-create${hi === i ? ' hi' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o)} onMouseEnter={() => setHi(i)} data-testid={p.testId ? `${p.testId}-create` : undefined}>+ {p.createLabel ?? 'สร้างใหม่'}{text.trim() ? ` "${text.trim()}"` : ''}</li>;
            const id = p.getId(o.x);
            const why = p.isDisabled?.(o.x);
            return (
              <li key={id} role="option" aria-selected={id === p.value} aria-disabled={!!why || undefined} data-i={i} data-id={id}
                className={`${hi === i ? 'hi' : ''}${id === p.value ? ' sel' : ''}${why ? ' dis' : ''}`}
                onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o)} onMouseEnter={() => setHi(i)} title={why || undefined}>
                <span className="ss-l">{p.getLabel(o.x)}</span>
                {(p.getSub || why) && <span className="ss-s">{why || p.getSub!(o.x)}</span>}
              </li>
            );
          })}
          {loading && <li className="ss-info">กำลังค้นหา…</li>}
          {!loading && !rows.length && text.trim() && <li className="ss-info">ไม่พบ "{text.trim()}"</li>}
          {more && <li className="ss-info"><button type="button" className="btn sm" onMouseDown={(e) => e.preventDefault()} onClick={loadMore}>{remote.isFetchingNextPage ? 'กำลังโหลด…' : 'โหลดเพิ่ม'}</button></li>}
        </ul>
      )}
    </div>
  );
}
