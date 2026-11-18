import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LoginRes, SessionUser } from '@erp/contracts';
import { perm, type PermKey, type PermValue } from '@erp/core';
import { ApiFail, api, getToken, setToken, setUnauthorizedHandler } from './api';

interface AuthState {
  user: SessionUser | null;
  /** true while a saved token is being checked with /api/auth/me */
  restoring: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  /** core.perm for the signed-in role (0 when signed out). */
  can: (key: PermKey) => PermValue;
}

const Ctx = createContext<AuthState>({ user: null, restoring: false, login: async () => {}, logout: () => {}, can: () => 0 });
export const useAuth = () => useContext(Ctx);

export const ROLE_TH: Record<SessionUser['role'], string> = {
  owner: 'เจ้าของร้าน', manager: 'ผู้จัดการร้าน', cashier: 'แคชเชียร์', sales: 'พนักงานขาย', wh: 'พนักงานคลัง', driver: 'คนขับรถ', acct: 'บัญชี', extacct: 'นักบัญชีภายนอก',
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [restoring, setRestoring] = useState(() => !!getToken());

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    qc.clear();
  }, [qc]);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!getToken()) return;
    // Only a 401 ends the saved session; a network blip or busy server on reload gets two retries instead of a forced logout.
    const me = (left: number): Promise<SessionUser> =>
      api('GET', '/api/auth/me', { schema: SessionUser, silent: true }).catch((e: unknown) => {
        if (left > 0 && !(e instanceof ApiFail && e.status === 401)) return new Promise<SessionUser>((ok) => setTimeout(() => ok(me(left - 1)), 700));
        throw e;
      });
    me(2)
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setRestoring(false));
  }, [logout]);

  // The owner may change a role's permissions while staff are signed in: refresh the session on focus and every 2 minutes.
  useEffect(() => {
    if (!user) return;
    const refresh = () => { if (getToken()) api('GET', '/api/auth/me', { schema: SessionUser, silent: true }).then((u) => setUser((cur) => (cur && JSON.stringify(cur) === JSON.stringify(u) ? cur : u))).catch(() => {}); };
    const t = setInterval(refresh, 120_000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(t); window.removeEventListener('focus', refresh); };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback(async (username: string, password: string) => {
    const r = await api('POST', '/api/auth/login', { body: { username, password }, schema: LoginRes });
    qc.clear();
    setToken(r.token);
    setUser(r.user);
  }, [qc]);

  // The shop's permission set comes with the session (owner-managed roles); the built-in table is the fallback.
  const can = useCallback((key: PermKey) => (user ? (user.perms[key] as PermValue | undefined) ?? perm(user.role, key) : 0), [user]);
  return <Ctx.Provider value={{ user, restoring, login, logout, can }}>{children}</Ctx.Provider>;
}
