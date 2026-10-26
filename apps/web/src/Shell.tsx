/** App shell from the mockup: left nav grouped by section (one hue per section), sticky header, content area. */
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import type { PermKey, PermValue } from '@erp/core';
import { ROLE_TH, useAuth } from './auth';
import { IS_CLOUD } from './cloud';
import { useMeta } from './data';

export type Grp = 'ov' | 'sale' | 'inv' | 'data' | 'sys';
const GROUP_NAME: Record<Grp, string> = { ov: 'ภาพรวม', sale: 'ขาย', inv: 'ซื้อและคลัง', data: 'ข้อมูลหลัก', sys: 'ตั้งค่า' };

const I = (p: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: p }} />
);
const ICON = {
  pos: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3.5h3l2.4 11.2a1.5 1.5 0 0 0 1.5 1.2h8.4a1.5 1.5 0 0 0 1.5-1.2L21 7.5H6.5"/>',
  sales: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  returns: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  stock: '<path d="M3 8.5 12 4l9 4.5-9 4.5z"/><path d="M3 8.5v7L12 20l9-4.5v-7M12 13v7"/>',
  master: '<ellipse cx="12" cy="5.5" rx="8" ry="2.8"/><path d="M4 5.5v6c0 1.6 3.6 2.8 8 2.8s8-1.2 8-2.8v-6M4 11.5v6c0 1.6 3.6 2.8 8 2.8s8-1.2 8-2.8v-6"/>',
  log: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M8.5 16.5c1.5-2.5 2.5-2.5 3 0s1.5 1 3-.5"/>',
};

export interface ViewDef { path: string; label: string; code: string; grp: Grp; icon: keyof typeof ICON; show: (can: (k: PermKey) => PermValue, caps: Record<string, boolean>) => boolean }

/** Nav, filtered by core.perm(role, key) and by edition capabilities from /api/meta. */
export const VIEWS: ViewDef[] = [
  { path: '/pos', label: 'ขายหน้าร้าน (POS)', code: 'M07', grp: 'sale', icon: 'pos', show: (can) => !!can('pos.sell') },
  { path: '/sales', label: 'เอกสารขาย', code: 'M08', grp: 'sale', icon: 'sales', show: (can) => !!can('sales.doc') || !!can('pos.sell') || !!can('fin.ar') },
  { path: '/returns', label: 'รับคืนสินค้า', code: 'M08', grp: 'sale', icon: 'returns', show: (can) => !!can('sales.return') },
  { path: '/stock', label: 'คลังสินค้า', code: 'M06', grp: 'inv', icon: 'stock', show: (can) => !!can('inv.view') },
  { path: '/products', label: 'สินค้าและหน่วยนับ', code: 'M03', grp: 'data', icon: 'master', show: (can) => !!can('data.master') },
  { path: '/audit', label: 'ประวัติการทำรายการ', code: 'BR-18', grp: 'sys', icon: 'log', show: (can) => !!can('sys.log') },
];

export function useVisibleViews(): ViewDef[] {
  const { can } = useAuth();
  const meta = useMeta();
  const caps = meta.data?.capabilities ?? {};
  return VIEWS.filter((v) => v.show(can, caps));
}

export function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const meta = useMeta();
  const views = useVisibleViews();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const cur = VIEWS.find((v) => loc.pathname.startsWith(v.path));
  const grp = cur?.grp ?? 'ov';

  useEffect(() => {
    document.body.dataset.mod = grp;
    setOpen(false);
  }, [grp, loc.pathname]);

  const groups = (Object.keys(GROUP_NAME) as Grp[]).map((g) => [g, views.filter((v) => v.grp === g)] as const).filter(([, vs]) => vs.length);
  const shop = meta.data?.shop;

  return (
    <div className="app">
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <aside className={`side${open ? ' open' : ''}`} aria-label="เมนู">
        <div className="brand">
          <div className="logo">{(shop?.name ?? 'S').slice(0, 2)}</div>
          <div><b>{shop?.name ?? 'SCG Shop ERP'}</b><small>{shop ? `สาขา${shop.branch || 'สำนักงานใหญ่'}` : ''}</small></div>
        </div>
        <nav className="nav">
          {groups.map(([g, vs]) => (
            <div key={g}>
              <div className="navgrp"><i style={{ background: `var(--c-${g})` }} />{GROUP_NAME[g]}</div>
              {vs.map((v) => {
                const on = cur?.path === v.path;
                return (
                  <NavLink key={v.path} to={v.path} className={on ? 'on' : ''} style={on ? { background: `var(--c-${g}-soft)` } : undefined}>
                    <span className="ni" style={{ color: `var(--c-${g})`, background: on ? `var(--c-${g})` : `var(--c-${g}-soft)` }}>{I(ICON[v.icon])}</span>
                    <span className="lbl">{v.label}</span>
                    <span className="code">{v.code}</span>
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="small muted" style={{ padding: '16px 8px' }}>ผู้ใช้: {user?.name} ({user ? ROLE_TH[user.role] : ''}){meta.data ? ` · v${meta.data.version}` : ''}</div>
      </aside>
      <div className="main">
        <header className="top">
          <button className="btn sm menu-btn" aria-label="เปิดเมนู" onClick={() => setOpen(true)}>☰ เมนู</button>
          <div>
            <h1>{cur?.label ?? 'SCG Shop ERP'}</h1>
            <div className="mcode"><span className="crumb">{GROUP_NAME[grp]}</span><span className="mono">Module {cur?.code ?? '-'}</span></div>
          </div>
          <div className="sp" />
          <div className="who">
            <span className={`ed ${IS_CLOUD ? 'cloud' : 'onprem'}`} data-testid="edition">{IS_CLOUD ? 'Cloud' : 'On-premise'}</span>
            <span className="uname">{user?.name}<small>{user ? ROLE_TH[user.role] : ''}</small></span>
            <button className="btn sm" onClick={logout}>ออกจากระบบ</button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
