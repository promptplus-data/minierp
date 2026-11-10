/** SCG Admin accounts and roles (mockup VIEWS.adm_users) and the platform audit log (super admin only). */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { AdmAuditEntry, AdmRole, AdmUser } from '@erp/contracts';
import { Modal, Pill, SkeletonRows, thTime, useDebounced, useToast, type PillKind } from '../../../ui';
import { LoadMore } from '../../../ui/lists';
import { ErrorBanner, checkFields, requiredMsg } from '../../../errors';
import { admErr } from '../common';
import { ADM_ROLE_TH, admApi, useAdmLoadMore, useAdm } from './admApi';

type V = 1 | 0 | 'ro';
const MATRIX: [string, V[]][] = [
  ['เปิด / ระงับร้าน และนำเข้าร้านจาก On-premise', [1, 0, 1, 0, 0]],
  ['แก้ master สินค้าและราคาแนะนำ SCG', [1, 1, 0, 0, 0]],
  ['ออก / ยกเลิก license On-premise', [1, 0, 1, 0, 0]],
  ['เข้าดูร้านแบบ support (เมื่อร้านอนุญาต)', [1, 0, 0, 1, 0]],
  ['ดูภาพรวมและข้อมูลรวมทุกร้าน (ไม่มีข้อมูลส่วนบุคคล)', [1, 'ro', 'ro', 'ro', 1]],
  ['จัดการผู้ดูแลระบบ และดู log ของ SCG', [1, 0, 0, 0, 0]],
];
const PV = (v: V) => (v === 1 ? <Pill k="ok">ได้</Pill> : v === 'ro' ? <Pill k="acc">ดูอย่างเดียว</Pill> : <Pill k="mut">ไม่ได้</Pill>);

export default function Admins() {
  const qc = useQueryClient();
  const admins = useQuery({ queryKey: ['scg', 'admins'], queryFn: () => admApi('GET', '/api/adm/admins', { schema: z.object({ items: z.array(AdmUser) }) }) });
  const { admin: me } = useAdm();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<AdmUser | null>(null);
  const [toggle, setToggle] = useState<AdmUser | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['scg', 'admins'] });
  return (
    <>
      <div className="card">
        <h2>ผู้ดูแลระบบฝั่ง SCG <button className="btn sm pri" onClick={() => setOpen(true)}>+ เพิ่มผู้ดูแล</button></h2>
        {admins.isError && <ErrorBanner error={admins.error} onRetry={() => void admins.refetch()} retrying={admins.isFetching} />}
        <div className="tw">
          <table className="admt" data-testid="adm-admins">
            <thead><tr><th>ชื่อ</th><th>ชื่อผู้ใช้</th><th>บทบาท</th><th>สถานะ</th><th>เข้าใช้ล่าสุด</th><th /></tr></thead>
            <tbody>
              {admins.isLoading ? <SkeletonRows cols={6} rows={3} /> : (admins.data?.items ?? []).map((a) => {
                const self = a.id === me?.id;
                const on = a.status === 'active';
                return (
                  <tr key={a.id} data-user={a.username}>
                    <td className="c-name">{a.name}{self && <span className="small muted"> (คุณ)</span>}</td><td className="mono small c-user">{a.username}</td><td className="c-role">{ADM_ROLE_TH[a.role]}</td>
                    <td className="c-st" data-testid={`adm-status-${a.username}`}>{on ? <Pill k="ok">ใช้งาน</Pill> : <Pill k="mut">ปิดใช้งาน</Pill>}</td>
                    <td className="small c-last">{a.lastLoginAt ? thTime(a.lastLoginAt) : '-'}</td>
                    <td className="c-act">
                      <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        <button className="btn sm" onClick={() => setEdit(a)} data-testid={`adm-edit-${a.username}`}>แก้ไข</button>
                        <button className={`btn sm${on ? ' bad' : ''}`} disabled={self} onClick={() => setToggle(a)} data-testid={`adm-toggle-${a.username}`}
                          title={self ? 'ปิดใช้งานบัญชีของตัวเองไม่ได้ ให้ Super admin คนอื่นทำให้' : undefined}>{on ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}</button>
                      </div>
                      {self && <div className="small muted" style={{ textAlign: 'right', marginTop: 2 }}>บัญชีของคุณเอง ปิดใช้งานไม่ได้</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <h2>บทบาทฝั่ง SCG</h2>
        <div className="tw">
          <table>
            <thead><tr><th>สิทธิ์</th>{AdmRole.options.map((r) => <th key={r}>{ADM_ROLE_TH[r]}</th>)}</tr></thead>
            <tbody>{MATRIX.map(([l, vs]) => <tr key={l}><td>{l}</td>{vs.map((v, i) => <td key={i}>{PV(v)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </div>
      <AuditCard />
      {open && <NewAdmin onClose={() => setOpen(false)} onDone={() => { setOpen(false); void refresh(); }} />}
      {edit && <EditAdmin a={edit} self={edit.id === me?.id} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void refresh(); }} />}
      {toggle && <ToggleAdmin a={toggle} onClose={() => setToggle(null)} onDone={(msg) => { setToggle(null); toast(msg); void refresh(); }} />}
    </>
  );
}

const ACT: Record<string, PillKind> = { update: 'acc', activate: 'ok', deactivate: 'bad', 'reset-password': 'warn', login: 'mut', 'login-failed': 'bad', create: 'ok', issue: 'ok', revoke: 'bad', suspend: 'bad', resume: 'acc', import: 'acc', push: 'acc', 'support-view': 'warn' };

function AuditCard() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const list = useAdmLoadMore(['scg', 'audit'], '/api/adm/audit', AdmAuditEntry, { q: dq });
  const loading = list.isLoading;
  return (
    <div className="card">
      <h2>log ของ SCG Admin</h2>
      <input type="search" style={{ width: '100%', marginBottom: 10 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นผู้ทำ การกระทำ หรือรายละเอียด" aria-label="ค้นหา log" />
      <div className="tw">
        <table data-testid="adm-audit">
          <thead><tr><th>เวลา</th><th>ผู้ทำ</th><th>การกระทำ</th><th>เรื่อง</th><th>อ้างอิง</th><th>รายละเอียด</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={6} /> : list.rows.map((a) => (
              <tr key={a.id}><td className="small mono">{thTime(a.at)}</td><td className="small">{a.admin}</td><td><Pill k={ACT[a.action] ?? 'mut'}>{a.action}</Pill></td><td className="small">{a.object}</td><td className="small mono">{a.ref ?? ''}</td><td className="small">{a.detail}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onMore={() => void list.fetchNextPage()} count={list.rows.length} />
    </div>
  );
}

function NewAdmin({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ username: '', name: '', role: 'support' as z.infer<typeof AdmRole>, password: '' });
  const [err, setErr] = useState('');
  const go = async () => {
    if (!checkFields({
      username: !/^[a-z0-9._]{3,30}$/.test(f.username) && 'ชื่อผู้ใช้ a–z 0–9 . _ 3–30 ตัว',
      name: requiredMsg(f.name, 'ชื่อ'), password: f.password.length < 8 && 'รหัสผ่านอย่างน้อย 8 ตัว',
    })) return;
    try {
      await admApi('POST', '/api/adm/admins', { body: { ...f, name: f.name.trim() }, schema: AdmUser });
      toast(`เพิ่มผู้ดูแล ${f.username} แล้ว`);
      onDone();
    } catch (e) {
      setErr(admErr(e));
    }
  };
  return (
    <Modal onClose={onClose} label="เพิ่มผู้ดูแล">
      <h3>เพิ่มผู้ดูแลฝั่ง SCG</h3>
      <div className="fgrid">
        <label className="f">ชื่อผู้ใช้<input type="text" name="username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} /></label>
        <label className="f">ชื่อ<input type="text" name="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="f">บทบาท<select name="role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as typeof f.role })}>{AdmRole.options.map((r) => <option key={r} value={r}>{ADM_ROLE_TH[r]}</option>)}</select></label>
        <label className="f">รหัสผ่านเริ่มต้น (8 ตัวขึ้นไป)<input type="password" name="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" onClick={() => void go()}>เพิ่ม</button></div>
    </Modal>
  );
}

function EditAdmin({ a, self, onClose, onDone }: { a: AdmUser; self: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: a.name, role: a.role as z.infer<typeof AdmRole>, password: '' });
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!checkFields({ name: requiredMsg(f.name, 'ชื่อ'), password: !!f.password && f.password.length < 8 && 'รหัสผ่านใหม่อย่างน้อย 8 ตัว' })) return;
    const body = { ...(f.name.trim() !== a.name ? { name: f.name.trim() } : {}), ...(f.role !== a.role ? { role: f.role } : {}), ...(f.password ? { password: f.password } : {}) };
    if (!Object.keys(body).length) return onClose();
    setBusy(true);
    try {
      await admApi('PATCH', `/api/adm/admins/${a.id}`, { body, schema: AdmUser });
      toast(`บันทึกผู้ดูแล ${a.username} แล้ว${f.password ? ' · ตั้งรหัสผ่านใหม่แล้ว' : ''}`);
      onDone();
    } catch {
      // the error dialog explains it (409: last super / yourself)
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="แก้ไขผู้ดูแล">
      <h3>แก้ไขผู้ดูแล · <span className="mono">{a.username}</span></h3>
      <div className="fgrid">
        <label className="f">ชื่อ<input type="text" name="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="adm-edit-name" /></label>
        <label className="f">บทบาท
          <select name="role" value={f.role} disabled={self} onChange={(e) => setF({ ...f, role: e.target.value as typeof f.role })} data-testid="adm-edit-role">{AdmRole.options.map((r) => <option key={r} value={r}>{ADM_ROLE_TH[r]}</option>)}</select>
          {self && <span className="small muted">เปลี่ยนบทบาทของตัวเองไม่ได้ (กันล็อกตัวเองออก)</span>}
        </label>
        <label className="f" style={{ gridColumn: '1 / -1' }}>ตั้งรหัสผ่านใหม่ (เว้นว่าง = ไม่เปลี่ยน · 8 ตัวขึ้นไป)
          <input type="password" name="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} data-testid="adm-edit-password" />
          <span className="small muted">ตั้งรหัสใหม่แล้วปลดล็อกบัญชีให้ด้วย · ไม่แสดงรหัสใน log</span>
        </label>
      </div>
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" onClick={() => void go()} disabled={busy} data-testid="adm-edit-save">บันทึก</button></div>
    </Modal>
  );
}

function ToggleAdmin({ a, onClose, onDone }: { a: AdmUser; onClose: () => void; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const off = a.status === 'active';
  const go = async () => {
    setBusy(true);
    try {
      await admApi('PATCH', `/api/adm/admins/${a.id}`, { body: { status: off ? 'disabled' : 'active' }, schema: AdmUser });
      onDone(off ? `ปิดใช้งาน ${a.username} แล้ว` : `เปิดใช้งาน ${a.username} แล้ว`);
    } catch {
      onClose(); // the error dialog explains it
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label={off ? 'ปิดใช้งานผู้ดูแล' : 'เปิดใช้งานผู้ดูแล'}>
      <h3>{off ? 'ปิดใช้งาน' : 'เปิดใช้งาน'} {a.name} ({a.username})</h3>
      <p style={{ margin: 0 }}>{off
        ? 'ผู้ดูแลคนนี้จะเข้าระบบไม่ได้ทันที และการเข้าใช้ที่เปิดค้างอยู่จะหลุดในคำขอถัดไป ข้อมูลและ log เดิมยังอยู่ เปิดใช้งานกลับได้ทุกเมื่อ'
        : 'ผู้ดูแลคนนี้จะกลับมาเข้าระบบได้ด้วยรหัสผ่านเดิม'}</p>
      <div className="act">
        <button className="btn" onClick={onClose}>ยกเลิก</button>
        <button className={`btn ${off ? 'bad' : 'pri'}`} onClick={() => void go()} disabled={busy} data-testid="adm-toggle-ok">{off ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}</button>
      </div>
    </Modal>
  );
}
