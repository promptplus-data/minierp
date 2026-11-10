/**
 * M04 Import Hub: choose data + source program + file (templates downloadable) → map columns (guessed, remembered
 * per source) → check (row status, download error rows, all-or-only-valid) → done; import history; remembered
 * delivery-file mappings and product-code aliases (spec §3.5).
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { IMPORT_KINDS, ImportBatch, ImportPreview, ImportProfile, ProductAlias, type ImportKind } from '@erp/contracts';
import { ApiFail, api, errText, getToken } from '../../api';
import { useAuth } from '../../auth';
import { Modal, Pill, SkeletonRows, thTime, useDebounced, useToast } from '../../ui';
import { LoadMore, useLoadMore } from '../../ui/lists';
import { NoteField } from '../../ui/NoteField';
import { downloadErrorRows, readAsBase64, saveBlob, STATUS_PILL, STATUS_TH } from './shared';

const KIND_TH: Record<ImportKind, string> = {
  products: 'สินค้า', customers: 'ลูกค้า', vendors: 'ผู้ขาย', opening_stock: 'สต็อกเปิด (ล็อต)', opening_ar: 'ลูกหนี้คงค้าง', opening_ap: 'เจ้าหนี้คงค้าง',
};
const SOURCES = ['Excel template', 'Express', 'FlowAccount', 'PEAK', 'POS อื่น (CSV)'];
const STEPS = ['เลือกไฟล์', 'จับคู่คอลัมน์', 'ตรวจข้อมูล', 'เสร็จ'];

export default function Import() {
  const { can } = useAuth();
  const kinds = IMPORT_KINDS.filter((k) => can('data.import') === 1 || (k === 'opening_ap' && can('fin.ap') === 1));
  const [tab, setTab] = useState<'import' | 'mapping'>('import');
  return (
    <>
      <div className="card">
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button className={tab === 'import' ? 'on' : ''} onClick={() => setTab('import')}>นำเข้าข้อมูล (เริ่มใช้ระบบ)</button>
          {(can('data.import') === 1 || can('inv.receive') === 1) && <button className={tab === 'mapping' ? 'on' : ''} onClick={() => setTab('mapping')}>การจับคู่ที่จำไว้</button>}
        </div>
        {tab === 'import' ? <Wizard kinds={kinds} /> : <Remembered />}
      </div>
      <History />
    </>
  );
}

function Wizard({ kinds }: { kinds: ImportKind[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<ImportKind>(kinds[0] ?? 'products');
  const [source, setSource] = useState(SOURCES[0]!);
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [pv, setPv] = useState<ImportPreview | null>(null);
  const [onlyValid, setOnlyValid] = useState(true);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [saveMapping, setSaveMapping] = useState(true);
  const [note, setNote] = useState('');
  const [done, setDone] = useState<ImportBatch | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const body = (m?: Record<string, number>) => ({ kind, source, fileName: file!.name, contentBase64: file!.b64, ...(m ? { mapping: m } : {}) });

  const template = async (format: 'csv' | 'xlsx') => {
    const res = await fetch(`/api/import/templates/${kind}?format=${format}`, { headers: { authorization: `Bearer ${getToken() ?? ''}` } });
    if (!res.ok) return setErr('ดาวน์โหลด template ไม่ได้');
    saveBlob(await res.blob(), `template-${kind}.${format}`);
  };
  const preview = async (m?: Record<string, number>) => {
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/import/preview', { body: body(m), schema: ImportPreview });
      setPv(r);
      setMapping(r.mapping);
      return r;
    } catch (e) {
      setErr(errText(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/import/commit', { body: { ...body(mapping), onlyValid, updateExisting, saveMapping, note: note.trim() || undefined }, schema: ImportBatch });
      setDone(r);
      setStep(4);
      toast(`นำเข้า${KIND_TH[kind]}แล้ว ${r.rowsCreated + r.rowsUpdated} แถว`);
      await Promise.all([qc.invalidateQueries({ queryKey: ['pu'] }), qc.invalidateQueries({ queryKey: ['catalog'] }), qc.invalidateQueries({ queryKey: ['customers'] }), qc.invalidateQueries({ queryKey: ['vendors'] }), qc.invalidateQueries({ queryKey: ['stock'] })]);
    } catch (e) {
      setErr(e instanceof ApiFail && e.detail('errorRows') ? `${errText(e)}` : errText(e));
    } finally {
      setBusy(false);
    }
  };
  const reset = () => { setStep(1); setFile(null); setPv(null); setMapping({}); setDone(null); setErr(''); setNote(''); };
  const errorRows = pv?.rows.filter((r) => r.status === 'error') ?? [];
  const importable = pv ? (onlyValid ? pv.counts.ok + pv.counts.warn + (updateExisting ? pv.counts.exists : 0) : pv.rows.length) : 0;

  return (
    <>
      <div className="steps" style={{ margin: '4px 0 14px' }}>{STEPS.map((s, i) => <span key={s} className={i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}>{i + 1}. {s}</span>)}</div>
      {step === 1 && (
        <>
          <div className="fgrid">
            <label className="f">ข้อมูลที่จะนำเข้า<select value={kind} onChange={(e) => { setKind(e.target.value as ImportKind); setPv(null); }} data-testid="imp-kind">{kinds.map((k) => <option key={k} value={k}>{KIND_TH[k]}</option>)}</select></label>
            <label className="f">ไฟล์มาจาก<select value={source} onChange={(e) => setSource(e.target.value)} data-testid="imp-source">{SOURCES.map((s) => <option key={s}>{s}</option>)}</select></label>
            <label className="f">เลือกไฟล์ (.xlsx, .csv · ไม่เกิน 10,000 แถว)<input type="file" accept=".csv,.xlsx,.txt" data-testid="imp-file" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setFile({ name: f.name, b64: await readAsBase64(f) }); }} /></label>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn pri" disabled={!file || busy} onClick={async () => { const r = await preview(); if (r) setStep(2); }} data-testid="imp-next1">ถัดไป: จับคู่คอลัมน์</button>
            <span className="small muted">template:</span>
            <button className="btn sm" onClick={() => void template('xlsx')}>Excel</button>
            <button className="btn sm" onClick={() => void template('csv')}>CSV</button>
          </div>
          <div className="note small" style={{ marginTop: 12 }}>
            {kind === 'opening_stock' ? 'สต็อกเปิดนำเข้าเป็นล็อต: สินค้า 1 รหัสใส่ได้หลายแถวต่างวันที่ (yyyymmdd แบบเดียวกับ template PEAK) ระบบใช้วันที่ล็อตตัด FIFO'
              : kind === 'opening_ar' || kind === 'opening_ap' ? 'ยอดคงค้าง ณ วันเริ่มใช้ระบบ ใส่เลขที่เอกสารเดิม วันที่ วันครบกำหนด (เว้นว่างได้ ระบบคิดจากเงื่อนไขชำระ) · ไม่ออกใบกำกับภาษีใหม่'
                : kind === 'customers' || kind === 'vendors' ? 'ช่องผู้ติดต่อตาม template PEAK (ประเภทกิจการ ที่อยู่ ธนาคาร ฯลฯ) · ผู้ติดต่อที่มีอยู่แล้ว (รหัส เลขภาษี หรือชื่อตรง) จะแสดงเป็น "มีอยู่แล้ว" เลือกข้ามหรืออัปเดตได้'
                  : 'สินค้า SCG ไม่ต้องนำเข้า ระบบซิงก์ให้แล้ว · บาร์โค้ดที่ตรงกับสินค้าในระบบจะผูกรหัสเดิมเข้ากับสินค้านั้นแทนการสร้างซ้ำ'}
            {' · '}ทีม onboarding นำเข้าแทนร้านได้ ทุกการนำเข้าบันทึกชื่อผู้ทำใน log
          </div>
        </>
      )}
      {step === 2 && pv && (
        <>
          <p className="small muted" style={{ margin: '0 0 10px' }}>จับคู่คอลัมน์ในไฟล์ ({source}) กับข้อมูลในระบบ{pv.profileName ? ` · ใช้การจับคู่ที่จำไว้ "${pv.profileName}"` : ''}</p>
          <div className="pu-map">
            {pv.fields.map((f) => (
              <label key={f.key}>
                <span>{f.label}{f.required && <span className="req"> *</span>}</span>
                <select value={mapping[f.key] ?? ''} aria-label={`จับคู่ ${f.label}`} onChange={(e) => { const m = { ...mapping }; if (e.target.value === '') delete m[f.key]; else m[f.key] = Number(e.target.value); setMapping(m); }}>
                  <option value="">ไม่นำเข้า</option>
                  {pv.headers.map((h, i) => <option key={i} value={i}>{h || `คอลัมน์ ${i + 1}`}</option>)}
                </select>
              </label>
            ))}
          </div>
          <label className="row small" style={{ marginTop: 10 }}><input type="checkbox" checked={saveMapping} onChange={(e) => setSaveMapping(e.target.checked)} /> จำการจับคู่นี้ไว้ใช้ครั้งถัดไป (ตามโปรแกรมต้นทาง)</label>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setStep(1)}>ย้อนกลับ</button>
            <button className="btn pri" disabled={busy || pv.fields.some((f) => f.required && mapping[f.key] == null)} onClick={async () => { const r = await preview(mapping); if (r) setStep(3); }} data-testid="imp-next2">ตรวจข้อมูล</button>
          </div>
        </>
      )}
      {step === 3 && pv && (
        <>
          {pv.fileImportedAt && <div className="note warn small" style={{ marginBottom: 8 }}>ไฟล์นี้เคยนำเข้าแล้วเมื่อ {thTime(pv.fileImportedAt)} · รายการที่มีอยู่แล้วจะไม่ถูกสร้างซ้ำ</div>}
          <div className="row" style={{ marginBottom: 8 }}>
            <Pill k="ok">พร้อม {pv.counts.ok}</Pill><Pill k="warn">เตือน {pv.counts.warn}</Pill><Pill k="bad">ผิด {pv.counts.error}</Pill><Pill k="mut">มีอยู่แล้ว {pv.counts.exists}</Pill>
            {errorRows.length > 0 && <button className="btn sm" onClick={() => downloadErrorRows(file!.name, pv.headers, errorRows)} data-testid="imp-errors">ดาวน์โหลดแถวที่ผิด</button>}
          </div>
          <div className="tw" style={{ maxHeight: 380 }}>
            <table data-testid="imp-rows">
              <thead><tr><th>แถว</th>{pv.fields.filter((f) => mapping[f.key] != null).map((f) => <th key={f.key}>{f.label}</th>)}<th>ผลตรวจ</th></tr></thead>
              <tbody>
                {pv.rows.map((r) => (
                  <tr key={r.rowNo} className={`pu-${r.status}`}>
                    <td>{r.rowNo}</td>
                    {pv.fields.filter((f) => mapping[f.key] != null).map((f) => <td key={f.key} className="small">{r.cells[mapping[f.key]!] || <span className="muted">-</span>}</td>)}
                    <td className="pu-cell-wrap"><Pill k={STATUS_PILL[r.status]}>{STATUS_TH[r.status]}</Pill>{r.messages.length > 0 && <div className={`pu-msgs${r.status === 'error' ? ' bad' : ''}`}>{r.messages.join(' · ')}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <label className="row small"><input type="radio" checked={onlyValid} onChange={() => setOnlyValid(true)} /> บันทึกเฉพาะแถวที่ผ่าน</label>
            <label className="row small"><input type="radio" checked={!onlyValid} onChange={() => setOnlyValid(false)} /> บันทึกทั้งไฟล์ (ต้องไม่มีแถวผิด)</label>
            {(kind === 'products' || kind === 'customers' || kind === 'vendors') && <label className="row small"><input type="checkbox" checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)} /> อัปเดตรายการที่มีอยู่แล้ว</label>}
          </div>
          <NoteField value={note} onChange={setNote} testId="imp-note" placeholder="เช่น ยอดยกมาจาก Express ณ 31 ต.ค." />
          <p className="small muted" style={{ margin: '6px 0' }}>แถวที่ผิดจะไม่ถูกนำเข้า แก้ในไฟล์แล้วอัปโหลดใหม่ได้ · ทั้งไฟล์บันทึกใน transaction เดียว ถ้าผิดพลาดจะไม่มีข้อมูลค้างครึ่งทาง</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setStep(2)}>ย้อนกลับ</button>
            <button className="btn pri" disabled={busy || importable === 0 || (!onlyValid && pv.counts.error > 0)} onClick={() => void commit()} data-testid="imp-commit">นำเข้า {importable} แถว</button>
          </div>
        </>
      )}
      {step === 4 && done && (
        <>
          <div className="empty" style={{ color: 'var(--fg)' }} data-testid="imp-done">
            <div style={{ fontSize: 28 }}>✓</div>
            <b>นำเข้า{KIND_TH[kind]}แล้ว · สร้าง {done.rowsCreated} · อัปเดต {done.rowsUpdated}</b><br />
            <span className="small muted">ข้าม {done.rowsSkipped} แถว · ผิด {done.rowsError} แถว · เลขที่ {done.no}</span>
            {done.note && <><br /><span className="small muted">หมายเหตุ: {done.note}</span></>}
          </div>
          <div className="row" style={{ justifyContent: 'center' }}><button className="btn pri" onClick={reset}>นำเข้าข้อมูลอื่น</button></div>
        </>
      )}
      {err && <div className="err" role="alert" style={{ marginTop: 10 }}>{err}</div>}
    </>
  );
}

function History() {
  const r = useLoadMore(['pu', 'batches'], '/api/import/batches', ImportBatch, {}, 10);
  const loading = r.isLoading;
  const kindTh = (k: string) => (k === 'delivery' ? 'ใบส่งของ' : KIND_TH[k as ImportKind] ?? k);
  return (
    <div className="card">
      <h2>ประวัติการนำเข้า</h2>
      <div className="tw">
        <table data-testid="imp-history">
          <thead><tr><th>วันที่</th><th>เลขที่</th><th>ข้อมูล</th><th>ที่มา</th><th>ไฟล์</th><th className="n">แถว</th><th className="n">สร้าง / อัปเดต / ข้าม / ผิด</th><th>โดย</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={8} rows={3} /> : r.rows.map((b) => (
              <tr key={b.id}>
                <td className="small">{thTime(b.createdAt)}</td><td className="mono">{b.no}</td><td>{kindTh(b.kind)}</td><td className="small">{b.source}</td><td className="small pu-cell-wrap">{b.fileName}{b.note && <div className="muted">หมายเหตุ: {b.note}</div>}</td>
                <td className="n">{b.rowsTotal}</td><td className="n small">{b.rowsCreated} / {b.rowsUpdated} / {b.rowsSkipped} / {b.rowsError}</td><td className="small">{b.createdBy}</td>
              </tr>
            ))}
            {!loading && !r.rows.length && <tr><td colSpan={8} className="empty">ยังไม่มีการนำเข้า</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!r.hasNextPage} loading={r.isFetchingNextPage} onMore={() => void r.fetchNextPage()} count={r.rows.length} testId="batches-more" />
    </div>
  );
}

function Remembered() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const profiles = useLoadMore(['pu', 'profiles'], '/api/import/profiles', ImportProfile, {}, 10);
  const aliases = useLoadMore(['pu', 'aliases'], '/api/import/aliases', ProductAlias, { q: dq }, 20);
  const [confirm, setConfirm] = useState<{ path: string; label: string } | null>(null);
  const kindTh = (k: string) => (k === 'delivery' ? 'ไฟล์ใบส่งของ' : KIND_TH[k as ImportKind] ?? k);
  const disable = async () => {
    if (!confirm) return;
    try {
      await api('POST', confirm.path);
      toast('ลบแล้ว');
      await Promise.all([profiles.refetch(), aliases.refetch()]);
    } catch (e) {
      toast(errText(e));
    }
    setConfirm(null);
  };
  return (
    <>
      <h4 className="sec" style={{ marginTop: 0 }}>การจับคู่คอลัมน์ (ตามโปรแกรมต้นทาง / ผู้แทนจำหน่าย)</h4>
      <div className="tw">
        <table>
          <thead><tr><th>ชื่อ</th><th>ข้อมูล</th><th className="n">คอลัมน์</th><th>แก้ล่าสุด</th><th /></tr></thead>
          <tbody>
            {profiles.isLoading ? <SkeletonRows cols={5} rows={2} /> : profiles.rows.map((p) => (
              <tr key={p.id}><td>{p.name}</td><td>{kindTh(p.kind)}</td><td className="n">{Object.keys(p.mapping).length}</td><td className="small">{thTime(p.updatedAt)}</td><td><button className="btn sm bad" onClick={() => setConfirm({ path: `/api/import/profiles/${p.id}/disable`, label: p.name })}>ลบ</button></td></tr>
            ))}
            {!profiles.isLoading && !profiles.rows.length && <tr><td colSpan={5} className="empty">ยังไม่มี</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!profiles.hasNextPage} loading={profiles.isFetchingNextPage} onMore={() => void profiles.fetchNextPage()} count={profiles.rows.length} testId="profiles-more" />
      <h4 className="sec">รหัสสินค้าในไฟล์ที่ผูกกับสินค้าของร้าน</h4>
      <input type="search" placeholder="ค้นหารหัสในไฟล์ หรือสินค้า" value={q} onChange={(e) => setQ(e.target.value)} aria-label="ค้นหารหัสที่ผูกไว้" style={{ width: '100%', margin: '10px 0' }} />
      <div className="tw">
        <table>
          <thead><tr><th>รหัสในไฟล์</th><th>สินค้าของร้าน</th><th>หน่วยที่จำไว้</th><th /></tr></thead>
          <tbody>
            {aliases.isLoading ? <SkeletonRows cols={4} rows={2} /> : aliases.rows.map((a) => (
              <tr key={a.id}><td className="mono">{a.externalCode}</td><td>{a.productName}</td><td className="small">{Object.keys(a.unitMap).join(', ') || '-'}</td><td><button className="btn sm bad" onClick={() => setConfirm({ path: `/api/import/aliases/${a.id}/disable`, label: a.externalCode })}>ลบ</button></td></tr>
            ))}
            {!aliases.isLoading && !aliases.rows.length && <tr><td colSpan={4} className="empty">ยังไม่มี</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!aliases.hasNextPage} loading={aliases.isFetchingNextPage} onMore={() => void aliases.fetchNextPage()} count={aliases.rows.length} testId="aliases-more" />
      {confirm && (
        <Modal onClose={() => setConfirm(null)} label="ยืนยันการลบ">
          <h3>ลบ "{confirm.label}"?</h3>
          <p className="small muted" style={{ margin: 0 }}>ไฟล์ครั้งถัดไปจะต้องจับคู่ใหม่ · การลบบันทึกใน log</p>
          <div className="act"><button className="btn" onClick={() => setConfirm(null)}>ยกเลิก</button><button className="btn bad" onClick={() => void disable()}>ลบ</button></div>
        </Modal>
      )}
    </>
  );
}
