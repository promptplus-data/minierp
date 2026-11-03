/** SCG Admin accounts and roles (mockup VIEWS.adm_users) and the platform audit log (super admin only). */
import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { AdmAuditEntry, AdmRole, AdmUser, page } from '@erp/contracts';
import { Modal, Pager, Pill, SkeletonRows, thTime, useCursorPager, useDebounced, useToast, type PillKind } from '../../../ui';
import { admErr } from '../common';
import { ADM_ROLE_TH, admApi } from './admApi';

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
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="card">
        <h2>ผู้ดูแลระบบฝั่ง SCG <button className="btn sm pri" onClick={() => setOpen(true)}>+ เพิ่มผู้ดูแล</button></h2>
        <div className="tw">
          <table>
            <thead><tr><th>ชื่อ</th><th>ชื่อผู้ใช้</th><th>บทบาท</th><th>สถานะ</th><th>เข้าใช้ล่าสุด</th></tr></thead>
            <tbody>
              {admins.isLoading ? <SkeletonRows cols={5} rows={3} /> : (admins.data?.items ?? []).map((a) => (
                <tr key={a.id}><td>{a.name}</td><td className="mono small">{a.username}</td><td>{ADM_ROLE_TH[a.role]}</td><td>{a.status === 'active' ? <Pill k="ok">ใช้งาน</Pill> : <Pill k="mut">ปิด</Pill>}</td><td className="small">{a.lastLoginAt ? thTime(a.lastLoginAt) : '-'}</td></tr>
              ))}
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
      {open && <NewAdmin onClose={() => setOpen(false)} onDone={() => { setOpen(false); void qc.invalidateQueries({ queryKey: ['scg', 'admins'] }); }} />}
    </>
  );
}

const ACT: Record<string, PillKind> = { login: 'mut', 'login-failed': 'bad', create: 'ok', issue: 'ok', revoke: 'bad', suspend: 'bad', resume: 'acc', import: 'acc', push: 'acc', 'support-view': 'warn' };

function AuditCard() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const pager = useCursorPager(dq);
  const list = useQuery({
    queryKey: ['scg', 'audit', dq, pager.cursor], placeholderData: keepPreviousData,
    queryFn: () => admApi('GET', '/api/adm/audit', { query: { q: dq, limit: 20, cursor: pager.cursor }, schema: page(AdmAuditEntry) }),
  });
  const loading = list.isLoading || (list.isFetching && list.isPlaceholderData);
  return (
    <div className="card">
      <h2>log ของ SCG Admin</h2>
      <input type="search" style={{ width: '100%', marginBottom: 10 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นผู้ทำ การกระทำ หรือรายละเอียด" aria-label="ค้นหา log" />
      <div className="tw">
        <table data-testid="adm-audit">
          <thead><tr><th>เวลา</th><th>ผู้ทำ</th><th>การกระทำ</th><th>เรื่อง</th><th>อ้างอิง</th><th>รายละเอียด</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={6} /> : (list.data?.items ?? []).map((a) => (
              <tr key={a.id}><td className="small mono">{thTime(a.at)}</td><td className="small">{a.admin}</td><td><Pill k={ACT[a.action] ?? 'mut'}>{a.action}</Pill></td><td className="small">{a.object}</td><td className="small mono">{a.ref ?? ''}</td><td className="small">{a.detail}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!list.data?.nextCursor} count={list.data?.items.length} loading={list.isFetching} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor ?? null)} />
    </div>
  );
}

function NewAdmin({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ username: '', name: '', role: 'support' as z.infer<typeof AdmRole>, password: '' });
  const [err, setErr] = useState('');
  const go = async () => {
    if (!/^[a-z0-9._]{3,30}$/.test(f.username)) return setErr('ชื่อผู้ใช้ a–z 0–9 . _ 3–30 ตัว');
    if (!f.name.trim()) return setErr('ใส่ชื่อ');
    if (f.password.length < 8) return setErr('รหัสผ่านอย่างน้อย 8 ตัว');
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
        <label className="f">ชื่อผู้ใช้<input type="text" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} /></label>
        <label className="f">ชื่อ<input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="f">บทบาท<select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as typeof f.role })}>{AdmRole.options.map((r) => <option key={r} value={r}>{ADM_ROLE_TH[r]}</option>)}</select></label>
        <label className="f">รหัสผ่านเริ่มต้น (8 ตัวขึ้นไป)<input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" onClick={() => void go()}>เพิ่ม</button></div>
    </Modal>
  );
}
