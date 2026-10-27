/**
 * App shell from the mockup: left nav grouped by section (one hue per section), sticky header, content area.
 * Nav items come from the module registry (./modules); add screens there, not here.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ROLE_TH, useAuth } from './auth';
import { IS_CLOUD } from './cloud';
import { useMeta } from './data';
import { navFor, useVisibleNav } from './modules';
import { iconSvg } from './modules/icons';
import { SECTIONS, type Section } from './modules/types';

const I = (svg: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
);

export function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const meta = useMeta();
  const views = useVisibleNav();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const cur = navFor(loc.pathname);
  const grp: Section = cur?.section ?? 'ov';

  useEffect(() => {
    document.body.dataset.mod = grp;
    setOpen(false);
  }, [grp, loc.pathname]);

  const groups = (Object.keys(SECTIONS) as Section[]).map((g) => [g, views.filter((v) => v.section === g)] as const).filter(([, vs]) => vs.length);
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
              <div className="navgrp"><i style={{ background: `var(--c-${g})` }} />{SECTIONS[g]}</div>
              {vs.map((v) => {
                const on = cur?.path === v.path;
                return (
                  <NavLink key={v.path} to={v.path} className={on ? 'on' : ''} style={on ? { background: `var(--c-${g}-soft)` } : undefined}>
                    <span className="ni" style={{ color: `var(--c-${g})`, background: on ? `var(--c-${g})` : `var(--c-${g}-soft)` }}>{I(iconSvg(v.icon))}</span>
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
            <div className="mcode"><span className="crumb">{SECTIONS[grp]}</span><span className="mono">Module {cur?.code ?? '-'}</span></div>
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
