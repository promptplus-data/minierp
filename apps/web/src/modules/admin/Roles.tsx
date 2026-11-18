/**
 * สิทธิ์และบทบาท (owner): what each role may see and do — menus follow the permissions — and roles the owner adds,
 * e.g. ฝ่ายบุคคล who creates logins and keys in salaries. Others with sys.users see it read-only.
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ShopRole } from '@erp/contracts';
import { PERM_KEYS, type PermKey, type PermValue } from '@erp/core';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { Modal, Pill, SkeletonRows, thTime, useToast } from '../../ui';

const GROUPS: [string, [PermKey, string, string][]][] = [
  ['ขายหน้าร้าน', [
    ['pos.sell', 'ขายหน้าร้าน (POS)', 'เมนูขายหน้าร้าน'], ['pos.delLine', 'ลบรายการในบิล', ''], ['pos.void', 'ยกเลิกบิล', ''],
    ['pos.discCap', 'ให้ส่วนลดได้สูงสุด (%)', ''], ['pos.price', 'แก้ราคาขาย', ''], ['fin.shift', 'เปิด/ปิดกะ นับเงินลิ้นชัก', ''],
  ]],
  ['ขายส่งและลูกหนี้', [
    ['sales.doc', 'เอกสารขาย ขายส่ง ลูกค้า', 'เมนูขายส่ง / เงินเชื่อ'], ['sales.project', 'ขายโครงการ', 'เมนูขายโครงการ'], ['sales.creditApv', 'อนุมัติเกินวงเงิน แก้วงเงินเครดิต', ''],
    ['sales.belowCost', 'ขายต่ำกว่าทุน', ''], ['sales.return', 'รับคืนสินค้า ลดหนี้ คืนเงิน', 'เมนูรับคืนสินค้า'], ['sales.voidDoc', 'ยกเลิกเอกสารขาย', ''],
    ['fin.ar', 'ลูกหนี้ รับชำระ', 'เมนูลูกหนี้'], ['promo.manage', 'โปรโมชั่นของร้าน', 'เมนูโปรโมชั่น'],
  ]],
  ['ซื้อและคลัง', [
    ['inv.receive', 'ซื้อเข้า รับของ', 'เมนูซื้อเข้า'], ['inv.view', 'ดูคลังสินค้า สมุดคุมสต็อก', 'เมนูคลังสินค้า'], ['inv.adj', 'โอน เบิก ขอปรับยอด', ''],
    ['inv.adjApprove', 'อนุมัติปรับยอด / ปรับต้นทุน', ''], ['inv.count', 'นับสต็อก', 'เมนูนับสต็อก'], ['inv.seeSys', 'เห็นยอดระบบตอนนับ', ''],
    ['inv.produce', 'การผลิต', 'เมนูการผลิต'], ['fin.ap', 'เจ้าหนี้ จ่ายเงิน', 'เมนูเจ้าหนี้'],
  ]],
  ['ข้อมูลและรายงาน', [
    ['data.cost', 'เห็นต้นทุนและกำไร', ''], ['data.master', 'แก้ข้อมูลหลัก สินค้า ลูกค้า ราคา', 'เมนูสินค้า ราคาตามลูกค้า'], ['data.import', 'นำเข้าข้อมูล', 'เมนูนำเข้าข้อมูล'],
    ['data.export', 'ส่งออกให้นักบัญชี', 'เมนูส่งออก'], ['rep.view', 'รายงาน', 'เมนูรายงาน'],
  ]],
  ['พนักงาน', [
    ['hr.manage', 'พนักงาน สร้างผู้ใช้', 'เมนูพนักงานและเงินเดือน'], ['hr.salary', 'เห็นและแก้เงินเดือน ค่าจ้าง เลขบัตร', ''], ['hr.leave', 'อนุมัติวันลา', ''],
  ]],
  ['ระบบ', [
    ['sys.users', 'ดูสิทธิ์และบทบาท ปลดล็อกผู้ใช้', 'เมนูสิทธิ์และบทบาท'], ['sys.settings', 'ตั้งค่าร้าน คลัง เอกสาร', 'เมนูตั้งค่า'], ['sys.log', 'ประวัติการทำรายการ', 'เมนูประวัติ'],
  ]],
];
const VALUE_TH: Record<string, string> = { 1: 'ทำได้', ro: 'ดูอย่างเดียว', apv: 'ต้องใช้ PIN อนุมัติ', 0: 'ไม่ได้' };
const OPTIONS: PermValue[] = [1, 'ro', 'apv', 0];
const BASE_TH: Record<string, string> = { manager: 'ผู้จัดการ', cashier: 'แคชเชียร์', sales: 'พนักงานขาย', wh: 'พนักงานคลัง', driver: 'คนขับรถ', acct: 'บัญชี', extacct: 'นักบัญชีภายนอก' };
const covered = new Set(GROUPS.flatMap(([, ks]) => ks.map(([k]) => k)));
if (PERM_KEYS.some((k) => !covered.has(k))) console.warn('Roles page: a permission has no label');

export default function Roles() {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const owner = user?.role === 'owner';
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api('GET', '/api/roles', { schema: z.array(ShopRole) }) });
  const [pick, setPick] = useState<string>('manager');
  const [draft, setDraft] = useState<Record<string, Record<string, PermValue>>>({});
  const [name, setName] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const role = roles.data?.find((r) => r.id === pick) ?? roles.data?.[0];
  const g = role ? { ...(role.grants as Record<string, PermValue>), ...draft[role.id] } : {};
  const dirty = !!role && (Object.keys(draft[role.id] ?? {}).length > 0 || (name[role.id] !== undefined && name[role.id] !== role.name));
  const changed = useMemo(() => (role ? PERM_KEYS.filter((k) => g[k] !== (role.defaults as Record<string, PermValue>)[k]).length : 0), [role, g]);
  const set = (k: PermKey, v: PermValue) => role && setDraft({ ...draft, [role.id]: { ...draft[role.id], [k]: v } });
  const refresh = () => qc.invalidateQueries({ queryKey: ['roles'] });

  const save = async (reset = false) => {
    if (!role) return;
    setBusy(true);
    try {
      await api('PATCH', `/api/roles/${role.id}`, { body: reset ? { reset: true } : { grants: g, ...(role.builtin ? {} : { name: name[role.id] ?? role.name }) }, schema: ShopRole });
      setDraft({ ...draft, [role.id]: {} });
      toast(reset ? `คืนค่ามาตรฐานของ${role.name}แล้ว` : `บันทึกสิทธิ์ ${name[role.id] ?? role.name} แล้ว`);
      await refresh();
    } catch (e) {
      toast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!role || role.builtin || !window.confirm(`ลบบทบาท ${role.name}?`)) return;
    try {
      await api('POST', `/api/roles/${role.id}/delete`);
      toast(`ลบบทบาท ${role.name} แล้ว`);
      setPick('manager');
      await refresh();
    } catch (e) {
      toast(errText(e));
    }
  };

  return (
    <div className="roles">
      <div className="card">
        <h2><span>สิทธิ์และบทบาท</span>{owner && <button className="btn sm pri" onClick={() => setAdding(true)} data-testid="role-add">+ เพิ่มบทบาท</button>}</h2>
        <p className="small muted" style={{ marginTop: 0 }}>กำหนดว่าแต่ละบทบาทเห็นเมนูไหนและทำอะไรได้ เมนูซ่อนเองเมื่อไม่มีสิทธิ์ · เจ้าของร้านมีสิทธิ์ทุกอย่างเสมอ · กำหนดบทบาทให้พนักงานที่เมนูพนักงานและเงินเดือน · สิทธิ์ใหม่มีผลทันที เมนูของผู้ใช้ที่เปิดค้างอยู่ปรับตามภายใน 2 นาที{owner ? '' : ' · คุณดูได้อย่างเดียว เจ้าของร้านเป็นผู้แก้'}</p>
        <div className="steps" style={{ flexWrap: 'wrap' }} role="tablist" aria-label="บทบาท">
          {roles.isLoading ? <span>กำลังโหลด…</span> : roles.data!.map((r) => (
            <span key={r.id} role="tab" tabIndex={0} aria-selected={role?.id === r.id} className={role?.id === r.id ? 'on' : ''} onClick={() => setPick(r.id)} onKeyDown={(e) => { if (e.key === 'Enter') setPick(r.id); }} data-testid={`role-tab-${r.key}`}>
              {r.name}{!r.builtin && ' ★'} <small className="muted">{r.users}</small>
            </span>
          ))}
        </div>
      </div>
      {role && (
        <div className="card" data-testid="role-editor">
          <h2>
            <span>
              {role.builtin ? role.name : owner ? <input type="text" value={name[role.id] ?? role.name} onChange={(e) => setName({ ...name, [role.id]: e.target.value })} aria-label="ชื่อบทบาท" data-testid="role-name" style={{ fontSize: 'inherit', fontWeight: 600 }} /> : role.name}
              {' '}{role.builtin ? (role.customized ? <Pill k="warn">ร้านปรับเอง</Pill> : <Pill k="mut">ค่ามาตรฐาน</Pill>) : <Pill k="ok">บทบาทของร้าน · ใช้กฎ PIN แบบ{BASE_TH[role.base]}</Pill>}
            </span>
            <span className="small muted">ผู้ใช้ {role.users} คน{changed ? ` · ต่างจากค่าเริ่มต้น ${changed} ข้อ` : ''}{role.updatedBy ? ` · แก้ล่าสุด ${role.updatedBy} ${thTime(role.updatedAt!)}` : ''}</span>
          </h2>
          <div className="tw">
            <table data-testid="role-matrix">
              <thead><tr><th>สิทธิ์</th><th>เมนูที่เกี่ยวข้อง</th><th>ค่า</th><th className="small">ค่าเริ่มต้น</th></tr></thead>
              {GROUPS.map(([grp, keys]) => (
                <tbody key={grp}>
                  <tr><td colSpan={4} style={{ background: 'var(--bg-soft, #f3f5f8)', fontWeight: 600 }}>{grp}</td></tr>
                  {keys.map(([k, label, menu]) => {
                    const v = g[k] ?? 0;
                    const dflt = (role.defaults as Record<string, PermValue>)[k] ?? 0;
                    return (
                      <tr key={k} data-testid={`perm-${k}`}>
                        <td>{label}<div className="small muted mono">{k}</div></td>
                        <td className="small muted">{menu}</td>
                        <td>
                          {k === 'pos.discCap'
                            ? <input type="number" min={0} max={100} value={Number(v)} disabled={!owner} onChange={(e) => set(k, Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))))} aria-label={label} style={{ width: 80 }} />
                            : <select value={String(v)} disabled={!owner} onChange={(e) => set(k, (e.target.value === '1' ? 1 : e.target.value === '0' ? 0 : e.target.value) as PermValue)} aria-label={label} data-testid={`perm-sel-${k}`}>
                                {OPTIONS.map((o) => <option key={String(o)} value={String(o)}>{VALUE_TH[String(o)]}</option>)}
                              </select>}
                          {v !== dflt && <span className="small" style={{ color: 'var(--warn, #b26a00)', marginLeft: 6 }}>●</span>}
                        </td>
                        <td className="small muted">{k === 'pos.discCap' ? `${dflt}%` : VALUE_TH[String(dflt)]}</td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
          {owner && (
            <div className="act">
              {!role.builtin && <button className="btn bad" onClick={() => void remove()} data-testid="role-delete">ลบบทบาท</button>}
              {role.builtin && role.customized && <button className="btn" disabled={busy} onClick={() => void save(true)} data-testid="role-reset">คืนค่ามาตรฐาน</button>}
              <button className="btn pri" disabled={busy || !dirty} onClick={() => void save()} data-testid="role-save">บันทึกสิทธิ์</button>
            </div>
          )}
          <p className="small muted" style={{ margin: '8px 0 0' }}>"ต้องใช้ PIN อนุมัติ" = ทำได้เมื่อผู้จัดการหรือเจ้าของร้านใส่ PIN · "เห็นและแก้เงินเดือน" ควรให้เฉพาะคนที่ดูแลเงินเดือน · ผู้ที่ไม่ใช่เจ้าของร้านให้บทบาทที่มีสิทธิ์มากกว่าตัวเองไม่ได้</p>
        </div>
      )}
      {roles.isLoading && <div className="card"><table><tbody><SkeletonRows cols={4} rows={6} /></tbody></table></div>}
      {adding && <AddRole onClose={() => setAdding(false)} onDone={(id) => { setAdding(false); setPick(id); void refresh(); }} />}
    </div>
  );
}

function AddRole({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [base, setBase] = useState('acct');
  const [err, setErr] = useState('');
  const go = async () => {
    if (!name.trim()) return setErr('ตั้งชื่อบทบาท');
    try {
      const r = await api('POST', '/api/roles', { body: { name, base }, schema: ShopRole });
      toast(`เพิ่มบทบาท ${r.name} แล้ว ปรับสิทธิ์ต่อได้เลย`);
      onDone(r.id);
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <Modal onClose={onClose} label="เพิ่มบทบาท">
      <h3>เพิ่มบทบาทของร้าน</h3>
      <label className="f">ชื่อบทบาท *<input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น ฝ่ายบุคคล" data-testid="role-new-name" /></label>
      <label className="f">เริ่มจากสิทธิ์ของ<select value={base} onChange={(e) => setBase(e.target.value)} data-testid="role-new-base">{Object.entries(BASE_TH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <p className="small muted">บทบาทใหม่ใช้กฎ PIN อนุมัติแบบบทบาทที่เลือก (เช่น เริ่มจากผู้จัดการ = ใส่ PIN อนุมัติให้คนอื่นได้) แล้วปรับสิทธิ์รายข้อได้หลังสร้าง</p>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" onClick={() => void go()} data-testid="role-new-save">เพิ่มบทบาท</button></div>
    </Modal>
  );
}
