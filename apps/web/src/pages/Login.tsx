import { Suspense, useState, type FormEvent } from 'react';
import { errText } from '../api';
import { useAuth } from '../auth';
import { CloudSsoButton, IS_CLOUD } from '../cloud';
import { useMeta } from '../data';

export default function Login() {
  const { login } = useAuth();
  const meta = useMeta();
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!u || !p) return setErr('กรอกชื่อผู้ใช้และรหัสผ่าน');
    setBusy(true);
    setErr('');
    try {
      await login(u.trim(), p);
    } catch (ex) {
      setErr(errText(ex));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lg">
      <form className="card lgcard" onSubmit={submit} aria-label="เข้าสู่ระบบ">
        <div className="row" style={{ gap: 10 }}>
          <div className="logo">S</div>
          <div>
            <b>SCG Shop ERP</b>
            <div className="small muted">{meta.data?.shop.name ?? 'ร้านวัสดุก่อสร้าง'} · <span className={`ed ${IS_CLOUD ? 'cloud' : 'onprem'}`}>{IS_CLOUD ? 'Cloud' : 'On-premise'}</span></div>
          </div>
        </div>
        {CloudSsoButton ? (
          <Suspense fallback={null}><CloudSsoButton /></Suspense>
        ) : (
          <div className="note small" style={{ marginTop: 16 }}>On-premise · เข้าด้วยชื่อผู้ใช้ของร้าน</div>
        )}
        <div className="small muted" style={{ textAlign: 'center', margin: '12px 0' }}>{IS_CLOUD ? 'หรือ พนักงานเข้าด้วยชื่อผู้ใช้ของร้าน' : 'พนักงานเข้าด้วยชื่อผู้ใช้ของร้าน'}</div>
        <label className="f">ชื่อผู้ใช้<input type="text" name="username" autoComplete="username" placeholder="เช่น prae" value={u} onChange={(e) => setU(e.target.value)} autoFocus /></label>
        <label className="f" style={{ marginTop: 8 }}>รหัสผ่าน<input type="password" name="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} /></label>
        <div className="err" role="alert" style={{ minHeight: 18, marginTop: 6 }} data-testid="login-error">{err}</div>
        <button className={`btn${IS_CLOUD ? '' : ' pri'}`} style={{ width: '100%', justifyContent: 'center' }} type="submit" disabled={busy}>
          {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
        </button>
        <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>ระบบล็อกบัญชีเมื่อใส่รหัสผิด 5 ครั้ง · พนักงานที่ลาออกถูกปิดบัญชี</p>
      </form>
    </div>
  );
}
