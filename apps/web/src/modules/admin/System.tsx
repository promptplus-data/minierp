/**
 * On-premise system screen (owner): M19-11 license key and M19-09 optional backup to the shop's own cloud storage.
 * The shop's data stays on its main machine: nothing is sent to SCG or anyone else.
 */
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  BackupConfig, BackupOauthPolled, BackupOauthStarted, BackupRun,
  type BackupProvider,
} from '@erp/contracts';
import { api } from '../../api';
import { Modal, Pill, SkeletonRows, fq, thTime, useToast } from '../../ui';
import { LoadMore, useLoadMore } from '../../ui/lists';
import { admErr } from './common';
import LicenseKey from './LicenseKey';
import { ErrorBanner } from '../../errors';

const TABS = [['license', 'License key'], ['backup', 'สำรองข้อมูลขึ้น cloud']] as const;
type Tab = (typeof TABS)[number][0];

export default function System() {
  const [sp, setSp] = useSearchParams();
  const tab = (TABS.some(([k]) => k === sp.get('tab')) ? sp.get('tab') : 'license') as Tab;
  return (
    <div className="card">
      <div className="tabs" role="tablist">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setSp(k === 'license' ? {} : { tab: k }, { replace: true })}>{l}</button>)}
      </div>
      <div style={{ marginTop: 14 }}>
        {tab === 'license' && <LicenseKey />}
        {tab === 'backup' && <Backup />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ M19-09 backup
const PROVIDERS: [BackupProvider, string][] = [['s3', 'Amazon S3 / S3-compatible (Wasabi, R2, MinIO)'], ['gdrive', 'Google Drive'], ['onedrive', 'OneDrive']];
interface S3Form { endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean }

function Backup() {
  const qc = useQueryClient();
  const toast = useToast();
  const cfg = useQuery({ queryKey: ['backup-config'], queryFn: () => api('GET', '/api/backup/config', { schema: BackupConfig }) });
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<BackupProvider>('s3');
  const [schedule, setSchedule] = useState<'daily' | 'off'>('daily');
  const [s3, setS3] = useState<S3Form>({ endpoint: '', region: 'ap-southeast-1', bucket: '', prefix: 'prompt-os/', accessKeyId: '', secretAccessKey: '', forcePathStyle: true });
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [oauth, setOauth] = useState<z.infer<typeof BackupOauthStarted> | null>(null);
  const loaded = useRef(false);
  const c = cfg.data;
  useEffect(() => {
    if (!c || loaded.current) return;
    loaded.current = true;
    setEnabled(c.enabled);
    if (c.provider) setProvider(c.provider);
    setSchedule(c.schedule);
    if (c.s3) setS3({ endpoint: c.s3.endpoint ?? '', region: c.s3.region, bucket: c.s3.bucket, prefix: c.s3.prefix, accessKeyId: c.s3.accessKeyId, secretAccessKey: '', forcePathStyle: c.s3.forcePathStyle });
  }, [c]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['backup-config'] });
    void qc.invalidateQueries({ queryKey: ['backup-runs'] });
    void qc.invalidateQueries({ queryKey: ['backup-files'] });
  };

  const save = async () => {
    if (pass && pass.length < 8) return setErr('รหัสเข้ารหัสอย่างน้อย 8 ตัวอักษร');
    if (pass !== pass2) return setErr('รหัสเข้ารหัสสองช่องไม่ตรงกัน');
    if (provider === 's3' && (!s3.bucket.trim() || !s3.accessKeyId.trim())) return setErr('กรอก bucket และ access key');
    if (provider === 's3' && !s3.secretAccessKey && !(c?.s3?.hasSecret && c.provider === 's3')) return setErr('กรอก secret access key');
    setBusy(true);
    setErr('');
    try {
      const body = {
        enabled, provider, schedule, passphrase: pass || undefined,
        s3: provider === 's3' ? { ...s3, endpoint: s3.endpoint.trim() || undefined, secretAccessKey: s3.secretAccessKey || undefined } : undefined,
      };
      await api('POST', '/api/backup/config', { body, schema: BackupConfig });
      setPass('');
      setPass2('');
      setS3((x) => ({ ...x, secretAccessKey: '' }));
      loaded.current = false;
      refresh();
      toast(enabled ? 'บันทึกแล้ว · เปิดสำรองข้อมูลขึ้น cloud' : 'บันทึกแล้ว · ปิดสำรองข้อมูลขึ้น cloud');
    } catch (e) {
      setErr(admErr(e));
    } finally {
      setBusy(false);
    }
  };
  const runNow = async () => {
    setBusy(true);
    try {
      const r = await api('POST', '/api/backup/run', { body: {}, schema: BackupRun });
      toast(r.status === 'ok' ? `สำรองข้อมูลสำเร็จ · ${r.fileName}` : `สำรองข้อมูลไม่สำเร็จ · ${r.error ?? ''}`);
      refresh();
    } catch (e) {
      toast(admErr(e));
    } finally {
      setBusy(false);
    }
  };
  const connect = async () => {
    if (provider === 's3') return;
    setErr('');
    try {
      setOauth(await api('POST', '/api/backup/oauth/start', { body: { provider }, schema: BackupOauthStarted }));
    } catch (e) {
      setErr(admErr(e));
    }
  };

  if (cfg.isLoading) return <><div className="sk" /><div className="sk" /></>;
  if (cfg.isError || !c) return <ErrorBanner error={cfg.error} onRetry={() => void cfg.refetch()} retrying={cfg.isFetching} />;
  const oauthReady = provider !== 's3' && c.oauthClientConfigured[provider];
  const connected = provider !== 's3' && c.provider === provider && !!c.oauth?.connected;

  return (
    <div className="grid g2">
      <div>
        <div className="note small" style={{ marginBottom: 12 }}>ปิดเป็นค่าเริ่มต้น · ข้อมูลทั้งร้านถูกเข้ารหัสในเครื่องนี้ด้วยรหัสของร้านก่อนส่งออก ปลายทาง (บัญชีของร้านเอง) อ่านข้อมูลไม่ได้ · ต้องใช้รหัสเดิมตอนกู้คืน เก็บรหัสไว้ให้ดี</div>
        <label className="row" style={{ marginBottom: 10 }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid="backup-enabled" /> <b>เปิดสำรองข้อมูลขึ้น cloud</b></label>
        <div className="fgrid">
          <label className="f">ปลายทาง
            <select value={provider} onChange={(e) => { setProvider(e.target.value as BackupProvider); setOauth(null); }} data-testid="backup-provider">
              {PROVIDERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label className="f">รอบการสำรอง<select value={schedule} onChange={(e) => setSchedule(e.target.value as 'daily' | 'off')}><option value="daily">อัตโนมัติทุกวัน</option><option value="off">กดเองเท่านั้น</option></select></label>
        </div>
        {provider === 's3' ? (
          <div className="fgrid" style={{ marginTop: 10 }}>
            <label className="f" style={{ gridColumn: '1/-1' }}>Endpoint (เว้นว่าง = AWS S3)<input type="text" value={s3.endpoint} placeholder="https://s3.ap-southeast-1.wasabisys.com" onChange={(e) => setS3({ ...s3, endpoint: e.target.value })} data-testid="s3-endpoint" /></label>
            <label className="f">Region<input type="text" value={s3.region} onChange={(e) => setS3({ ...s3, region: e.target.value })} /></label>
            <label className="f">Bucket<input type="text" value={s3.bucket} onChange={(e) => setS3({ ...s3, bucket: e.target.value })} data-testid="s3-bucket" /></label>
            <label className="f">โฟลเดอร์ (prefix)<input type="text" value={s3.prefix} onChange={(e) => setS3({ ...s3, prefix: e.target.value })} /></label>
            <label className="f">Access key ID<input type="text" value={s3.accessKeyId} autoComplete="off" onChange={(e) => setS3({ ...s3, accessKeyId: e.target.value })} data-testid="s3-key" /></label>
            <label className="f">Secret access key<input type="password" value={s3.secretAccessKey} autoComplete="new-password" placeholder={c.s3?.hasSecret ? 'ตั้งไว้แล้ว (เว้นว่าง = ใช้ค่าเดิม)' : ''} onChange={(e) => setS3({ ...s3, secretAccessKey: e.target.value })} data-testid="s3-secret" /></label>
            <label className="row small"><input type="checkbox" checked={s3.forcePathStyle} onChange={(e) => setS3({ ...s3, forcePathStyle: e.target.checked })} /> path-style URL (MinIO / บางผู้ให้บริการ)</label>
          </div>
        ) : (
          <div style={{ marginTop: 10 }}>
            {!oauthReady ? (
              <div className="note warn small" data-testid="oauth-unavailable">{provider === 'gdrive' ? 'Google Drive' : 'OneDrive'} ยังไม่เปิดให้ใช้ในเวอร์ชันนี้ (ผู้ให้บริการกำลังลงทะเบียนแอปกับ Google และ Microsoft) ใช้ S3 ไปก่อน</div>
            ) : connected ? (
              <div className="row"><Pill k="ok">เชื่อมบัญชีแล้ว</Pill><span className="small muted">{c.oauth?.account ?? ''}</span><button className="btn sm" onClick={() => void connect()}>เชื่อมบัญชีใหม่</button></div>
            ) : (
              <button className="btn" onClick={() => void connect()} data-testid="oauth-connect">เชื่อมบัญชี {provider === 'gdrive' ? 'Google Drive' : 'OneDrive'}</button>
            )}
          </div>
        )}
        <h4 className="sec" style={{ marginTop: 14 }}>รหัสเข้ารหัสข้อมูลสำรอง {c.hasPassphrase && <Pill k="ok">ตั้งไว้แล้ว</Pill>}</h4>
        <div className="fgrid" style={{ marginTop: 6 }}>
          <label className="f">{c.hasPassphrase ? 'รหัสใหม่ (เว้นว่าง = ใช้รหัสเดิม)' : 'รหัส (อย่างน้อย 8 ตัว)'}<input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} data-testid="backup-pass" /></label>
          <label className="f">ยืนยันรหัส<input type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} data-testid="backup-pass2" /></label>
        </div>
        {err && <div className="err" role="alert" style={{ marginTop: 6 }} data-testid="backup-error">{err}</div>}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn pri" disabled={busy} onClick={() => void save()} data-testid="backup-save">บันทึกการตั้งค่า</button>
          <button className="btn" disabled={busy || !c.provider || !c.hasPassphrase} onClick={() => void runNow()} data-testid="backup-run">สำรองตอนนี้</button>
        </div>
      </div>
      <div>
        <h4 className="sec">สถานะล่าสุด</h4>
        <div className="kv" style={{ marginTop: 8 }} data-testid="backup-status">
          <span>สำเร็จล่าสุด</span><span>{c.lastSuccessAt ? <>{thTime(c.lastSuccessAt)} <span className="small muted mono">{c.lastFile}</span></> : '-'}</span>
          <span>ล้มเหลวล่าสุด</span><span>{c.lastFailureAt ? <>{thTime(c.lastFailureAt)}<div className="small" style={{ color: 'var(--bad)' }}>{c.lastError}</div></> : '-'}</span>
        </div>
        <BackupRuns />
        <p className="small muted">กู้คืนบนเครื่องใหม่: ติดตั้งโปรแกรม แล้วเลือก "กู้คืนจากข้อมูลสำรอง" ในหน้าตั้งค่าครั้งแรก ใส่ปลายทางและรหัสเดิม</p>
      </div>
      {oauth && <OauthModal provider={provider as 'gdrive' | 'onedrive'} start={oauth} onClose={() => setOauth(null)} onDone={() => { setOauth(null); loaded.current = false; refresh(); toast('เชื่อมบัญชีแล้ว'); }} />}
    </div>
  );
}

function BackupRuns() {
  const runs = useLoadMore(['backup-runs'], '/api/backup/runs', BackupRun, {}, 10);
  return (
    <>
      <div className="tw" style={{ marginTop: 10 }}>
        <table data-testid="backup-runs">
          <thead><tr><th>เวลา</th><th>ปลายทาง</th><th>รอบ</th><th className="n">ขนาด</th><th>ผล</th></tr></thead>
          <tbody>
            {runs.isLoading ? <SkeletonRows cols={5} rows={3} /> : runs.rows.map((r) => (
              <tr key={r.id}>
                <td className="small">{thTime(r.at)}</td><td className="small">{r.provider}</td><td className="small">{r.trigger === 'manual' ? 'กดเอง' : 'อัตโนมัติ'}</td>
                <td className="n small">{r.bytes ? `${fq(r.bytes / 1024)} KB` : '-'}</td>
                <td>{r.status === 'ok' ? <Pill k="ok">สำเร็จ</Pill> : <span title={r.error ?? ''}><Pill k="bad">ล้มเหลว</Pill></span>}</td>
              </tr>
            ))}
            {runs.data && !runs.rows.length && <tr><td colSpan={5} className="empty">ยังไม่เคยสำรองข้อมูล</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!runs.hasNextPage} loading={runs.isFetchingNextPage} onMore={() => void runs.fetchNextPage()} count={runs.rows.length} />
    </>
  );
}

/** Device-flow sign-in: show the code, poll until the owner approves on the provider's page. */
function OauthModal({ provider, start, onClose, onDone }: { provider: 'gdrive' | 'onedrive'; start: z.infer<typeof BackupOauthStarted>; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState<'pending' | 'expired' | 'denied' | 'error'>('pending');
  const [err, setErr] = useState('');
  useEffect(() => {
    if (status !== 'pending') return;
    const t = setInterval(() => {
      api('POST', '/api/backup/oauth/poll', { body: { provider }, schema: BackupOauthPolled, silent: true })
        .then((r) => { if (r.status === 'connected') onDone(); else if (r.status !== 'pending') setStatus(r.status); })
        .catch((e: unknown) => { setErr(admErr(e)); setStatus('error'); });
    }, start.interval * 1000);
    return () => clearInterval(t);
  }, [status, provider, start.interval, onDone]);
  return (
    <Modal onClose={onClose} label="เชื่อมบัญชี">
      <h3>เชื่อมบัญชี {provider === 'gdrive' ? 'Google Drive' : 'OneDrive'}</h3>
      <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
        <li>เปิด <a href={start.verificationUrl} target="_blank" rel="noreferrer">{start.verificationUrl}</a> บนมือถือหรือคอมเครื่องใดก็ได้</li>
        <li>ใส่รหัสนี้ แล้วเข้าสู่ระบบด้วยบัญชีของร้าน และกดอนุญาต</li>
      </ol>
      <div style={{ textAlign: 'center' }}><span className="adm-code" data-testid="oauth-code">{start.userCode}</span></div>
      {status === 'pending' && <div className="small muted">กำลังรอการอนุญาต… (รหัสหมดอายุใน {Math.round(start.expiresIn / 60)} นาที)</div>}
      {status === 'expired' && <div className="err">รหัสหมดอายุแล้ว ปิดแล้วกดเชื่อมบัญชีอีกครั้ง</div>}
      {status === 'denied' && <div className="err">บัญชีไม่อนุญาต ปิดแล้วลองใหม่</div>}
      {status === 'error' && <div className="err">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ปิด</button></div>
    </Modal>
  );
}
