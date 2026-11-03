/**
 * M19-09 restore wizard on a new on-prem machine (public route /restore, linked from the first-run setup screen):
 * destination → pick a backup → passphrase → restore. The server allows it only on the main machine while it has no shop.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { BackupFile } from '@erp/contracts';
import { api } from '../../api';
import { useMeta } from '../../data';
import { fq, thTime } from '../../ui';
import { admErr } from './common';

const RestoreResult = z.object({ shop: z.string(), tables: z.record(z.number()), verified: z.object({ tables: z.number(), rows: z.number(), numericColumns: z.number(), auditChainOk: z.boolean() }) });

export default function Restore() {
  const meta = useMeta();
  const qc = useQueryClient();
  const [s3, setS3] = useState({ endpoint: '', region: 'ap-southeast-1', bucket: '', prefix: 'scg-erp/', accessKeyId: '', secretAccessKey: '', forcePathStyle: true });
  const [files, setFiles] = useState<z.infer<typeof BackupFile>[] | null>(null);
  const [file, setFile] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<z.infer<typeof RestoreResult> | null>(null);
  const target = () => ({ provider: 's3' as const, s3: { ...s3, endpoint: s3.endpoint.trim() || undefined } });
  const step = done ? 3 : files ? 2 : 1;

  const list = async () => {
    setErr('');
    setBusy(true);
    try {
      const r = await api('POST', '/api/backup/restore/files', { body: target(), schema: z.object({ items: z.array(BackupFile) }) });
      setFiles(r.items);
      setFile(r.items[0]?.name ?? '');
    } catch (e) {
      setErr(admErr(e));
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    setErr('');
    setBusy(true);
    try {
      setDone(await api('POST', '/api/backup/restore', { body: { ...target(), file, passphrase: pass }, schema: RestoreResult }));
      void qc.invalidateQueries({ queryKey: ['meta'] });
    } catch (e) {
      setErr(admErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lg">
      <div className="card lgcard" style={{ width: 'min(560px,100%)' }}>
        <div className="row" style={{ gap: 10 }}>
          <div className="logo">S</div>
          <div><b>กู้คืนข้อมูลร้านจากข้อมูลสำรอง</b><div className="small muted">SCG Shop ERP · <span className="ed onprem">On-premise</span></div></div>
        </div>
        <div className="steps" style={{ margin: '14px 0' }}>
          {['ปลายทาง', 'เลือกไฟล์และรหัส', 'เสร็จ'].map((s, i) => <span key={s} className={i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}>{i + 1}. {s}</span>)}
        </div>
        {meta.data && !meta.data.needsSetup && !done && <div className="note warn small" style={{ marginBottom: 10 }}>เครื่องนี้มีข้อมูลร้านแล้ว กู้คืนได้เฉพาะเครื่องใหม่ที่ยังไม่มีร้าน</div>}
        {step === 1 && (
          <div className="fgrid">
            <label className="f" style={{ gridColumn: '1/-1' }}>S3 endpoint (เว้นว่าง = AWS S3)<input type="text" value={s3.endpoint} onChange={(e) => setS3({ ...s3, endpoint: e.target.value })} /></label>
            <label className="f">Region<input type="text" value={s3.region} onChange={(e) => setS3({ ...s3, region: e.target.value })} /></label>
            <label className="f">Bucket<input type="text" value={s3.bucket} onChange={(e) => setS3({ ...s3, bucket: e.target.value })} /></label>
            <label className="f">โฟลเดอร์ (prefix)<input type="text" value={s3.prefix} onChange={(e) => setS3({ ...s3, prefix: e.target.value })} /></label>
            <label className="f">Access key ID<input type="text" value={s3.accessKeyId} onChange={(e) => setS3({ ...s3, accessKeyId: e.target.value })} /></label>
            <label className="f" style={{ gridColumn: '1/-1' }}>Secret access key<input type="password" value={s3.secretAccessKey} onChange={(e) => setS3({ ...s3, secretAccessKey: e.target.value })} /></label>
            <label className="row small"><input type="checkbox" checked={s3.forcePathStyle} onChange={(e) => setS3({ ...s3, forcePathStyle: e.target.checked })} /> path-style URL</label>
            <p className="small muted" style={{ gridColumn: '1/-1', margin: 0 }}>Google Drive / OneDrive: กู้คืนผ่านหน้านี้ได้เมื่อ SCG เปิดใช้ปลายทางนั้น (ตอนนี้ดาวน์โหลดไฟล์ .scgbackup แล้วอัปโหลดขึ้น S3 ของร้านก่อน)</p>
          </div>
        )}
        {step === 2 && files && (
          <>
            {files.length ? (
              <label className="f">ไฟล์สำรอง
                <select value={file} onChange={(e) => setFile(e.target.value)}>
                  {files.map((f) => <option key={f.name} value={f.name}>{f.name}{f.modifiedAt ? ` · ${thTime(f.modifiedAt)}` : ''}{f.size ? ` · ${fq(f.size / 1024)} KB` : ''}</option>)}
                </select>
              </label>
            ) : <div className="note warn small">ไม่พบไฟล์ .scgbackup ในปลายทางนี้</div>}
            <label className="f" style={{ marginTop: 8 }}>รหัสเข้ารหัสข้อมูลสำรอง (รหัสเดียวกับที่ตั้งในเครื่องเดิม)<input type="password" value={pass} onChange={(e) => setPass(e.target.value)} /></label>
          </>
        )}
        {done && (
          <div className="note small">
            กู้คืนร้าน <b>{done.shop}</b> เรียบร้อย · {done.verified.tables} ตาราง {done.verified.rows} แถว ตรวจยอดตรงกันทุกคอลัมน์ตัวเลข · log {done.verified.auditChainOk ? 'ครบถ้วน' : 'ไม่ครบ'}
            <br />เข้าสู่ระบบด้วยผู้ใช้เดิมของร้าน แล้วตั้งรหัสสำรองข้อมูลอีกครั้งในหน้าระบบและข้อมูลร้าน
          </div>
        )}
        {err && <div className="err" role="alert" style={{ marginTop: 8 }}>{err}</div>}
        <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
          <a className="btn" href="/">{done ? 'ไปหน้าเข้าสู่ระบบ' : '‹ กลับหน้าตั้งค่าครั้งแรก'}</a>
          {step === 1 && <button className="btn pri" disabled={busy || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey} onClick={() => void list()}>ค้นหาไฟล์สำรอง</button>}
          {step === 2 && <span className="row"><button className="btn" onClick={() => setFiles(null)}>ย้อนกลับ</button><button className="btn pri" disabled={busy || !file || pass.length < 8} onClick={() => void restore()}>{busy ? 'กำลังกู้คืน…' : 'กู้คืน'}</button></span>}
        </div>
      </div>
    </div>
  );
}
