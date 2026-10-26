import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LoginRes, SessionUser } from '@erp/contracts';
import { perm, type PermKey, type PermValue } from '@erp/core';
import { api, getToken, setToken, setUnauthorizedHandler } from './api';

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
    api('GET', '/api/auth/me', { schema: SessionUser })
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setRestoring(false));
  }, [logout]);

  const login = useCallback(async (username: string, password: string) => {
    const r = await api('POST', '/api/auth/login', { body: { username, password }, schema: LoginRes });
    qc.clear();
    setToken(r.token);
    setUser(r.user);
  }, [qc]);

  const can = useCallback((key: PermKey) => (user ? perm(user.role, key) : 0), [user]);
  return <Ctx.Provider value={{ user, restoring, login, logout, can }}>{children}</Ctx.Provider>;
}
