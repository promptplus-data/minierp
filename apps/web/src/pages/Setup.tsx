/** On-prem first run (GET /api/meta needsSetup): create the shop and the owner account, then sign in. */
import { useState, type FormEvent } from 'react';
import { LoginRes } from '@erp/contracts';
import { api, errText } from '../api';
import { useAuth } from '../auth';

export default function Setup() {
  const { login } = useAuth();
  const [f, setF] = useState({ shop: '', taxId: '', vat: true, name: '', username: '', password: '', password2: '', pin: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!f.shop.trim() || !f.name.trim() || !f.username.trim()) return setErr('กรอกชื่อร้าน ชื่อเจ้าของ และชื่อผู้ใช้');
    if (f.password.length < 6) return setErr('รหัสผ่านอย่างน้อย 6 ตัวอักษร');
    if (f.password !== f.password2) return setErr('รหัสผ่านสองช่องไม่ตรงกัน');
    if (!/^\d{4,6}$/.test(f.pin)) return setErr('PIN อนุมัติเป็นตัวเลข 4–6 หลัก');
    setBusy(true);
    setErr('');
    try {
      await api('POST', '/api/setup', {
        body: { shop: { name: f.shop.trim(), taxId: f.taxId.trim(), vatRegistered: f.vat }, owner: { username: f.username.trim(), name: f.name.trim(), password: f.password, pin: f.pin } },
        schema: LoginRes,
      });
      await login(f.username.trim(), f.password);
    } catch (ex) {
      setErr(errText(ex));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lg">
      <form className="card lgcard" onSubmit={submit} aria-label="ตั้งค่าร้านครั้งแรก">
        <div className="row" style={{ gap: 10 }}>
          <div className="logo">S</div>
          <div>
            <b>ตั้งค่าร้านครั้งแรก</b>
            <div className="small muted">SCG Shop ERP · <span className="ed onprem">On-premise</span></div>
          </div>
        </div>
        <div className="note small" style={{ margin: '14px 0' }}>เครื่องหลักยังไม่มีข้อมูลร้าน สร้างร้านและบัญชีเจ้าของร้านก่อนเริ่มใช้งาน ทำได้ครั้งเดียวจากเครื่องหลักเท่านั้น</div>
        <label className="f">ชื่อร้าน<input type="text" value={f.shop} onChange={(e) => set('shop', e.target.value)} autoFocus /></label>
        <label className="f" style={{ marginTop: 8 }}>เลขประจำตัวผู้เสียภาษี<input type="text" inputMode="numeric" value={f.taxId} onChange={(e) => set('taxId', e.target.value)} /></label>
        <label className="row small" style={{ marginTop: 8 }}><input type="checkbox" checked={f.vat} onChange={(e) => set('vat', e.target.checked)} /> จดทะเบียนภาษีมูลค่าเพิ่ม (VAT)</label>
        <label className="f" style={{ marginTop: 12 }}>ชื่อเจ้าของร้าน<input type="text" value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="f" style={{ marginTop: 8 }}>ชื่อผู้ใช้<input type="text" autoComplete="username" value={f.username} onChange={(e) => set('username', e.target.value)} /></label>
        <label className="f" style={{ marginTop: 8 }}>รหัสผ่าน<input type="password" autoComplete="new-password" value={f.password} onChange={(e) => set('password', e.target.value)} /></label>
        <label className="f" style={{ marginTop: 8 }}>ยืนยันรหัสผ่าน<input type="password" autoComplete="new-password" value={f.password2} onChange={(e) => set('password2', e.target.value)} /></label>
        <label className="f" style={{ marginTop: 8 }}>PIN อนุมัติ (4–6 หลัก)<input type="password" inputMode="numeric" maxLength={6} value={f.pin} onChange={(e) => set('pin', e.target.value)} /></label>
        <div className="err" role="alert" style={{ minHeight: 18, marginTop: 6 }} data-testid="setup-error">{err}</div>
        <button className="btn pri" style={{ width: '100%', justifyContent: 'center' }} type="submit" disabled={busy}>{busy ? 'กำลังสร้างร้าน…' : 'สร้างร้านและเข้าสู่ระบบ'}</button>
      </form>
    </div>
  );
}
