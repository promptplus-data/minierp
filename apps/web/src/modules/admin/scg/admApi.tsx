/**
 * SCG Admin console session: platform accounts sign in at /api/adm/auth/login (separate from shop users) and keep
 * their own token. Same error shape as the shop API (ApiFail), so screens reuse admErr().
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { ZodType, ZodTypeDef } from 'zod';
import { AdmLoginRes, AdmUser, ApiError, page, type AdmRole, type Page } from '@erp/contracts';
import { ApiFail, reportFailure } from '../../../api';

const KEY = 'erp-adm-token';
const read = () => { try { return sessionStorage.getItem(KEY); } catch { return null; } };
let token: string | null = read();
const save = (t: string | null) => {
  token = t;
  try { if (t) sessionStorage.setItem(KEY, t); else sessionStorage.removeItem(KEY); } catch { /* memory only */ }
};
let onUnauthorized = () => {};

type Q = Record<string, string | number | boolean | null | undefined>;
export async function admApi<T = unknown>(method: 'GET' | 'POST' | 'PATCH', path: string, opts: { body?: unknown; query?: Q; schema?: ZodType<T, ZodTypeDef, unknown> } = {}): Promise<T> {
  const qs = opts.query ? Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : '';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path + (qs ? `?${qs}` : ''), { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  } catch (err) {
    const fail = new ApiFail(0, 'NETWORK', String(err), null);
    reportFailure(fail, method, path);
    throw fail;
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const e = ApiError.safeParse(json);
    const fail = e.success ? new ApiFail(res.status, e.data.code, e.data.message, e.data.details) : new ApiFail(res.status, 'INTERNAL', text.slice(0, 200), null);
    fail.requestId = res.headers.get('x-request-id') ?? undefined;
    if (fail.code === 'UNAUTHORIZED' && token && !path.endsWith('/auth/login')) onUnauthorized();
    reportFailure(fail, method, path);
    throw fail;
  }
  if (!opts.schema) return json as T;
  const p = opts.schema.safeParse(json);
  if (!p.success) throw new ApiFail(res.status, 'INTERNAL', 'Response does not match the contract', p.error.issues);
  return p.data;
}

/** Lazy SCG console list: 20 rows a page through the console token (the shop `useLoadMore` uses the shop token). Pair with `LoadMore`. */
export function useAdmLoadMore<T>(key: readonly unknown[], path: string, item: ZodType<T, ZodTypeDef, unknown>, query: Q = {}, pageSize = 20) {
  const schema = page(item) as unknown as ZodType<Page<T>, ZodTypeDef, unknown>;
  const clean = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '' && v != null)) as Q;
  const r = useInfiniteQuery({
    queryKey: [...key, clean, pageSize],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => admApi('GET', path, { query: { ...clean, limit: pageSize, cursor: pageParam }, schema }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  return { ...r, rows: r.data?.pages.flatMap((x) => x.items) ?? [] };
}

interface AdmAuth { admin: AdmUser | null; restoring: boolean; login: (u: string, p: string) => Promise<void>; logout: () => void }
const Ctx = createContext<AdmAuth>({ admin: null, restoring: false, login: async () => {}, logout: () => {} });
export const useAdm = () => useContext(Ctx);

export function AdmAuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [admin, setAdmin] = useState<AdmUser | null>(null);
  const [restoring, setRestoring] = useState(() => !!token);
  const logout = useCallback(() => {
    save(null);
    setAdmin(null);
    qc.removeQueries({ queryKey: ['scg'] });
  }, [qc]);
  useEffect(() => {
    onUnauthorized = logout;
    if (!token) return;
    admApi('GET', '/api/adm/auth/me', { schema: AdmUser }).then(setAdmin).catch(() => save(null)).finally(() => setRestoring(false));
  }, [logout]);
  const login = useCallback(async (username: string, password: string) => {
    const r = await admApi('POST', '/api/adm/auth/login', { body: { username, password }, schema: AdmLoginRes });
    save(r.token);
    setAdmin(r.admin);
  }, []);
  return <Ctx.Provider value={{ admin, restoring, login, logout }}>{children}</Ctx.Provider>;
}

export const ADM_ROLE_TH: Record<AdmRole, string> = { super: 'Super admin', master: 'Master data admin', onboarding: 'Onboarding', support: 'Support', analyst: 'Data analyst' };

/** Mirrors the server's ADM_CAN (apps/server/src/modules/admin/platform.ts); the server enforces it. */
export const ADM_CAN = {
  shopsWrite: ['super', 'onboarding'], support: ['super', 'support'], masterWrite: ['super', 'master'], licenseWrite: ['super', 'onboarding'], admins: ['super'], audit: ['super'],
} as const satisfies Record<string, readonly AdmRole[]>;
export const admCan = (a: AdmUser | null, k: keyof typeof ADM_CAN) => !!a && (ADM_CAN[k] as readonly AdmRole[]).includes(a.role);
