/**
 * M14 SCG Admin console (cloud only, public route /scg/*): its own sign-in and shell. Screens: KPI (registered shops),
 * shops, central SCG master + recommended prices, on-prem license issuing + registry, received sales summaries,
 * SCG admins + platform audit.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorBox, QueryFailBar, checkFields, markLoginFailure } from '../../../errors';
import { iconSvg } from '../../icons';
import { admErr } from '../common';
import { ADM_ROLE_TH, AdmAuthProvider, admCan, useAdm } from './admApi';
import Admins from './Admins';
import Kpi from './Kpi';
import Licenses, { Shares } from './Licenses';
import Master from './Master';
import Shops from './Shops';

const NAV = [
  { to: '/scg', label: 'ภาพรวม · ร้านที่ลงทะเบียน', code: 'M14-03', icon: 'admMonitor', show: () => true },
  { to: '/scg/shops', label: 'ร้านค้า', code: 'M14-01', icon: 'admShops', show: () => true },
  { to: '/scg/master', label: 'สินค้า SCG กลาง', code: 'M14-02', icon: 'admMaster', show: () => true },
  { to: '/scg/licenses', label: 'License key', code: 'M19-11', icon: '<rect x="3" y="10" width="18" height="11" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/>', show: () => true },
  { to: '/scg/shares', label: 'สรุปยอดขายที่ร้านส่ง', code: 'M19-10', icon: 'reports', show: () => true },
  { to: '/scg/admins', label: 'ผู้ดูแลและ log', code: 'M14', icon: 'admUsers', show: (a: Parameters<typeof admCan>[0]) => admCan(a, 'admins') },
] as const;

const I = (svg: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;

function Login() {
  const { login } = useAdm();
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!checkFields({ username: !u.trim() && 'กรอกชื่อผู้ใช้', password: !p && 'กรอกรหัสผ่าน' })) return setErr('กรอกชื่อผู้ใช้และรหัสผ่าน');
    setBusy(true);
    setErr('');
    try {
      await login(u.trim(), p);
    } catch (ex) {
      setErr(admErr(ex));
      markLoginFailure(ex);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="lg">
      <form className="card lgcard" onSubmit={submit} aria-label="เข้าสู่ระบบ SCG Admin">
        <div className="row" style={{ gap: 10 }}>
          <div className="logo" style={{ background: 'var(--c-adm)' }}>S</div>
          <div><b>SCG Admin</b><div className="small muted">ผู้ดูแลระบบฝั่ง SCG · <span className="ed cloud">Cloud</span></div></div>
        </div>
        <div className="note small" style={{ margin: '14px 0' }}>บัญชีผู้ดูแลของ SCG แยกจากผู้ใช้ของร้าน · ทุกการทำรายการบันทึกใน log ของ SCG</div>
        <label className="f">ชื่อผู้ใช้<input type="text" name="username" autoComplete="username" value={u} onChange={(e) => { setU(e.target.value); setErr(''); }} autoFocus /></label>
        <label className="f" style={{ marginTop: 8 }}>รหัสผ่าน<input type="password" name="password" autoComplete="current-password" value={p} onChange={(e) => { setP(e.target.value); setErr(''); }} /></label>
        <ErrorBox testId="adm-login-error">{err}</ErrorBox>
        <button className="btn pri" style={{ width: '100%', justifyContent: 'center' }} type="submit" disabled={busy}>{busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}</button>
        <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>ผู้ใช้ของร้านเข้าระบบที่ <a href="/">หน้าแรก</a></p>
      </form>
    </div>
  );
}

function Shell() {
  const { admin, logout } = useAdm();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const items = NAV.filter((n) => n.show(admin));
  const cur = [...items].sort((a, b) => b.to.length - a.to.length).find((n) => loc.pathname === n.to || loc.pathname.startsWith(`${n.to}/`));
  useEffect(() => {
    document.body.dataset.mod = 'adm';
    setOpen(false);
  }, [loc.pathname]);
  return (
    <div className="app">
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <aside className={`side${open ? ' open' : ''}`} aria-label="เมนู SCG Admin">
        <div className="brand"><div className="logo">SCG</div><div><b>SCG Admin</b><small>ผู้ดูแลระบบ SCG Shop ERP</small></div></div>
        <nav className="nav">
          <div className="navgrp"><i style={{ background: 'var(--c-adm)' }} />SCG Admin</div>
          {items.map((n) => {
            const on = cur?.to === n.to;
            return (
              <NavLink key={n.to} to={n.to} end className={on ? 'on' : ''} style={on ? { background: 'var(--c-adm-soft)' } : undefined}>
                <span className="ni" style={{ color: 'var(--c-adm)', background: on ? 'var(--c-adm)' : 'var(--c-adm-soft)' }}>{I(iconSvg(n.icon))}</span>
                <span className="lbl">{n.label}</span><span className="code">{n.code}</span>
              </NavLink>
            );
          })}
        </nav>
      </aside>
      <div className="main">
        <header className="top">
          <button className="btn sm menu-btn" aria-label="เปิดเมนู" onClick={() => setOpen(true)}>☰ เมนู</button>
          <div><h1>{cur?.label ?? 'SCG Admin'}</h1><div className="mcode"><span className="crumb">SCG Admin</span><span className="mono">Module {cur?.code ?? 'M14'}</span></div></div>
          <div className="sp" />
          <div className="who">
            <span className="ed cloud">Cloud</span>
            <span className="uname" data-testid="adm-who">{admin?.name}<small>{admin ? ADM_ROLE_TH[admin.role] : ''}</small></span>
            <button className="btn sm" onClick={logout}>ออกจากระบบ</button>
          </div>
        </header>
        <main className="content">
          <QueryFailBar />
          <Routes>
            <Route index element={<Kpi />} />
            <Route path="shops" element={<Shops />} />
            <Route path="master" element={<Master />} />
            <Route path="licenses" element={<Licenses />} />
            <Route path="shares" element={<Shares />} />
            <Route path="admins" element={admCan(admin, 'admins') ? <Admins /> : <Navigate to="/scg" replace />} />
            <Route path="*" element={<Navigate to="/scg" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function Gate() {
  const { admin, restoring } = useAdm();
  if (restoring) return <div className="lg"><div className="card lgcard"><div className="sk" /><div className="sk" /></div></div>;
  return admin ? <Shell /> : <Login />;
}

export default function ScgApp() {
  return <AdmAuthProvider><Gate /></AdmAuthProvider>;
}
