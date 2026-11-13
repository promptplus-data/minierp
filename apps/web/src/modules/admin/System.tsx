/**
 * On-premise system screen (owner): M19-11 license key, M19-09 optional cloud backup, M19-10 manual sales-summary
 * share with SCG, M19-07 whole-shop export for moving to the cloud edition.
 */
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  BackupConfig, BackupOauthPolled, BackupOauthStarted, BackupRun, LicenseStatus, ShareConfig, SharePayload, ShareSent,
  type BackupProvider,
} from '@erp/contracts';
import { addDays } from '@erp/core';
import { api, getToken } from '../../api';
import { useAuth } from '../../auth';
import { Modal, Pill, SkeletonRows, fmt, fq, th, thTime, useToast } from '../../ui';
import { LoadMore, useLoadMore } from '../../ui/lists';
import { LICENSE_STATE, admErr, todayYmd } from './common';
import LicenseKey from './LicenseKey';
import { ErrorBanner } from '../../errors';

const TABS = [['license', 'License key'], ['backup', 'สำรองข้อมูลขึ้น cloud'], ['share', 'ส่งสรุปยอดขายให้ SCG'], ['export', 'ย้ายร้านไป Cloud']] as const;
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
        {tab === 'share' && <Share />}
        {tab === 'export' && <ExportShop />}
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
  const [s3, setS3] = useState<S3Form>({ endpoint: '', region: 'ap-southeast-1', bucket: '', prefix: 'scg-erp/', accessKeyId: '', secretAccessKey: '', forcePathStyle: true });
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
              <div className="note warn small" data-testid="oauth-unavailable">{provider === 'gdrive' ? 'Google Drive' : 'OneDrive'} ยังไม่เปิดให้ใช้ในเวอร์ชันนี้ (SCG กำลังลงทะเบียนแอปกับผู้ให้บริการ) ใช้ S3 ไปก่อน</div>
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

// ------------------------------------------------------------------ M19-10 sales summary
function Share() {
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const today = todayYmd();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01` < today ? `${today.slice(0, 7)}-01` : addDays(today, -6));
  const [to, setTo] = useState(addDays(today, -1) >= `${today.slice(0, 7)}-01` ? addDays(today, -1) : today);
  const [preview, setPreview] = useState<z.infer<typeof SharePayload> | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const conf = useQuery({ queryKey: ['share-config'], queryFn: () => api('GET', '/api/share/config', { schema: ShareConfig }) });
  const load = async () => {
    setErr('');
    setBusy(true);
    try {
      setPreview(await api('GET', '/api/share/preview', { query: { from, to }, schema: SharePayload }));
    } catch (e) {
      setPreview(null);
      setErr(admErr(e));
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    setConfirmOpen(false);
    setBusy(true);
    try {
      const r = await api('POST', '/api/share/send', { body: { from, to }, schema: ShareSent });
      toast(r.status === 'sent' ? `ส่งสรุปยอดขายให้ SCG แล้ว · เลขรับ ${r.receiptId}` : `ส่งไม่สำเร็จ · ${r.error ?? ''}`);
      void qc.invalidateQueries({ queryKey: ['share-history'] });
    } catch (e) {
      setErr(admErr(e));
    } finally {
      setBusy(false);
    }
  };
  const c = conf.data;
  return (
    <>
      <div className="note small">ส่งเฉพาะยอดขายรายวันของสินค้า SCG (จำนวน + มูลค่า) และยอดรวมสินค้าอื่น ไม่มีข้อมูลลูกค้า ผู้ใช้ หรือเลขเอกสาร · ระบบไม่ส่งอัตโนมัติ ถ้าไม่กดส่งก็ไม่มีข้อมูลใดออกจากร้าน (OQ-17)</div>
      {c && (!c.receiverUrl || !c.licensed) && (
        <div className="note warn small" style={{ marginTop: 8 }}>
          {!c.licensed && 'ต้องใส่ license key ก่อน (คีย์ใช้ยืนยันกับ SCG ว่าเป็นร้านนี้) '}{!c.receiverUrl && '· ยังไม่ได้ตั้งปลายทางของ SCG ในเครื่องหลัก (SCG_SHARE_URL)'}
        </div>
      )}
      <div className="row" style={{ margin: '12px 0' }}>
        <label className="f">ตั้งแต่<input type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} data-testid="share-from" /></label>
        <label className="f">ถึง<input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} data-testid="share-to" /></label>
        <button className="btn" style={{ alignSelf: 'flex-end' }} disabled={busy} onClick={() => void load()} data-testid="share-preview">ดูตัวอย่างข้อมูลที่จะส่ง</button>
        <button className="btn pri" style={{ alignSelf: 'flex-end' }} disabled={busy || !preview || user?.role !== 'owner'} onClick={() => setConfirmOpen(true)} data-testid="share-send">ส่งสรุปยอดขายให้ SCG</button>
      </div>
      {err && <div className="err" role="alert" data-testid="share-error">{err}</div>}
      {preview && (
        <>
          <div className="grid g4" style={{ marginBottom: 10 }}>
            <div className="card kpi"><div className="l">สินค้า SCG (จำนวน)</div><div className="v">{fq(preview.totals.scgQty)}</div></div>
            <div className="card kpi"><div className="l">สินค้า SCG (มูลค่า)</div><div className="v">฿{fmt(preview.totals.scgAmount)}</div></div>
            <div className="card kpi"><div className="l">สินค้าอื่น (ยอดรวม)</div><div className="v">฿{fmt(preview.totals.otherAmount)}</div></div>
            <div className="card kpi"><div className="l">รวม {preview.days.length} วัน</div><div className="v" data-testid="share-total">฿{fmt(preview.totals.total)}</div></div>
          </div>
          <div className="tw">
            <table data-testid="share-table">
              <thead><tr><th>วันที่</th><th>รหัส SCG</th><th>สินค้า SCG</th><th className="n">จำนวน</th><th className="n">มูลค่า</th></tr></thead>
              <tbody>
                {preview.days.map((dd) => [
                  ...dd.scg.map((x, i) => (
                    <tr key={dd.date + x.sku}><td className="small">{i === 0 ? th(dd.date) : ''}</td><td className="mono small">{x.sku}</td><td>{x.name}</td><td className="n">{fq(x.qty)} {x.unit}</td><td className="n">{fmt(x.amount)}</td></tr>
                  )),
                  <tr key={`${dd.date}-o`}><td className="small">{dd.scg.length ? '' : th(dd.date)}</td><td /><td className="muted">สินค้าอื่นรวม</td><td /><td className="n">{fmt(dd.otherAmount)}</td></tr>,
                ])}
                {!preview.days.length && <tr><td colSpan={5} className="empty">ไม่มียอดขายในช่วงนี้</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
      <ShareHistory />
      {confirmOpen && preview && (
        <Modal onClose={() => setConfirmOpen(false)} label="ยืนยันส่ง">
          <h3>ส่งสรุปยอดขายให้ SCG</h3>
          <p style={{ margin: 0 }}>ช่วง {th(from)} – {th(to)} · {preview.days.length} วัน · ยอดรวม ฿{fmt(preview.totals.total)}</p>
          <p className="small muted" style={{ margin: 0 }}>ส่งเฉพาะข้อมูลตามตัวอย่าง ระบบบันทึกการส่งใน audit log</p>
          <div className="act"><button className="btn" onClick={() => setConfirmOpen(false)}>ยกเลิก</button><button className="btn pri" onClick={() => void send()} data-testid="share-confirm">ยืนยันส่ง</button></div>
        </Modal>
      )}
    </>
  );
}

function ShareHistory() {
  const h = useLoadMore(['share-history'], '/api/share/history', ShareSent, {}, 10);
  return (
    <>
      <h4 className="sec" style={{ marginTop: 16 }}>ประวัติการส่ง</h4>
      <div className="tw">
        <table data-testid="share-history">
          <thead><tr><th>ส่งเมื่อ</th><th>ช่วงข้อมูล</th><th className="n">ยอดรวม</th><th>โดย</th><th>ผล</th></tr></thead>
          <tbody>
            {h.isLoading ? <SkeletonRows cols={5} rows={2} /> : h.rows.map((x) => (
              <tr key={x.id}>
                <td className="small">{thTime(x.sentAt)}</td><td className="small">{th(x.from)} – {th(x.to)}</td><td className="n">{fmt(x.total)}</td><td className="small">{x.sentBy}</td>
                <td>{x.status === 'sent' ? <Pill k="ok">ส่งแล้ว · {x.receiptId}</Pill> : <span title={x.error ?? ''}><Pill k="bad">ไม่สำเร็จ</Pill></span>}</td>
              </tr>
            ))}
            {h.data && !h.rows.length && <tr><td colSpan={5} className="empty">ยังไม่เคยส่ง</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!h.hasNextPage} loading={h.isFetchingNextPage} onMore={() => void h.fetchNextPage()} count={h.rows.length} />
    </>
  );
}

// ------------------------------------------------------------------ M19-07 export
function ExportShop() {
  const toast = useToast();
  const { user } = useAuth();
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (p1.length < 8) return setErr('รหัสผ่านอย่างน้อย 8 ตัวอักษร');
    if (p1 !== p2) return setErr('รหัสผ่านสองช่องไม่ตรงกัน');
    setErr('');
    setBusy(true);
    try {
      const res = await fetch('/api/system/export', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken() ?? ''}` }, body: JSON.stringify({ passphrase: p1 }) });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { message?: string; details?: { reason?: string } } | null;
        throw new Error(j?.details?.reason === 'OWNER_ONLY' ? 'เฉพาะเจ้าของร้านเท่านั้นที่ส่งออกข้อมูลทั้งร้านได้' : j?.message ?? `HTTP ${res.status}`);
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'shop.scgshop';
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setP1('');
      setP2('');
      toast(`ส่งออกแล้ว · ${name}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ maxWidth: 680 }}>
      <p style={{ marginTop: 0 }}>ส่งออกข้อมูลทั้งร้านเป็นไฟล์เดียวที่เข้ารหัสด้วยรหัสผ่าน เพื่อให้ทีม SCG นำเข้าเป็นร้านใหม่บน Cloud · สต็อกตามล็อต ลูกหนี้ เจ้าหนี้ เลขเอกสารล่าสุด และ log ตรงกัน 100% (ระบบตรวจยอดหลังนำเข้า)</p>
      {user?.role === 'owner' ? (
        <>
          <div className="fgrid">
            <label className="f">รหัสผ่านไฟล์ (อย่างน้อย 8 ตัว)<input type="password" autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} data-testid="export-pass" /></label>
            <label className="f">ยืนยันรหัสผ่าน<input type="password" autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} data-testid="export-pass2" /></label>
          </div>
          {err && <div className="err" role="alert" style={{ marginTop: 6 }}>{err}</div>}
          <button className="btn pri" style={{ marginTop: 10 }} disabled={busy} onClick={() => void go()} data-testid="export-go">{busy ? 'กำลังส่งออก…' : 'ส่งออกข้อมูลทั้งร้าน'}</button>
          <p className="small muted">ส่งไฟล์และรหัสผ่านให้ทีม SCG แยกช่องทางกัน (เช่น ไฟล์ทางอีเมล รหัสทางโทรศัพท์) · หลังย้ายแล้วหยุดใช้เครื่องนี้ออกเอกสาร เพื่อไม่ให้ข้อมูลสองที่ไม่ตรงกัน</p>
        </>
      ) : <div className="note small">เฉพาะเจ้าของร้านส่งออกข้อมูลทั้งร้านได้</div>}
    </div>
  );
}
