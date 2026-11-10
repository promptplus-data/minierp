/**
 * M05 "ซื้อเข้า / รับของ": BR-10 banner, draft receipts from delivery files (M19-08, one per DN), check-and-confirm
 * (REQ-M05-03/04), confirmed receipts with their AP bill, manual receipt (core form), BR-19 setting.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DELIVERY_FIELDS, DeliveryCommitRes, DeliveryPreview, GrDraft, GrDraftConfirmRes, GrDraftSummary, GrSummary, PurchasingSettings, type Product } from '@erp/contracts';
import { d } from '@erp/core';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { useCatalog, useMeta, useVendors, useWarehouses } from '../../data';
import { LoadMore, useLoadMore } from '../../ui/lists';
import { NoteField } from '../../ui/NoteField';
import { ProductPicker } from '../../ui/ProductPicker';
import { VendorPicker } from '../../ui/VendorPicker';
import { ReceiptModal } from '../../stock/forms';
import { fmt, fq, Modal, Pill, SkeletonRows, th, useDebounced, useToast } from '../../ui';
import { ageText, downloadErrorRows, GrAlertBanner, readAsBase64, STATUS_PILL, STATUS_TH, thOrDash, useDashboard } from './shared';
import { ErrorBanner } from '../../errors';
import { DocLink, DocLinks } from '../../doclink';

const FIELD_TH: Record<(typeof DELIVERY_FIELDS)[number], string> = {
  product_code: 'รหัสสินค้า', product_name: 'ชื่อสินค้า', qty: 'จำนวน', unit: 'หน่วย', unit_price: 'ราคาต่อหน่วย',
  dn_no: 'เลขที่ใบส่งของ (DN)', po_no: 'เลขที่ใบสั่งซื้อ', delivery_date: 'วันที่ส่ง', dealer_name: 'ผู้แทนจำหน่าย / ผู้ขาย',
  vat_flag: 'ราคารวม VAT?', invoice_no: 'เลขที่ใบกำกับ', line_discount: 'ส่วนลดบรรทัด',
};
const REQUIRED = new Set(['product_code', 'product_name', 'qty', 'unit', 'unit_price']);

const isStock = (p: Product) => p.kind === 'stock' && p.active;

export default function Receiving() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [modal, setModal] = useState<'import' | 'manual' | 'settings' | null>(null);
  const [sp, setSp] = useSearchParams();
  const [draftId, setDraftIdState] = useState<string | null>(sp.get('draft'));
  // ?draft=<id> opens that draft (links from the GR-overdue banner and the home dashboard)
  const setDraftId = (id: string | null) => { setDraftIdState(id); if (sp.has('draft') && !id) setSp({}, { replace: true }); };
  const dash = useDashboard();
  const canReceive = can('inv.receive') === 1;
  const refresh = () => qc.invalidateQueries({ queryKey: ['pu'] });
  return (
    <>
      <GrAlertBanner link={false} />
      <div className="grid g4 pu-kpis">
        <div className="card kpi"><div className="l">ของรอยืนยันรับ</div><div className="v">{dash.data ? `${dash.data.draftCount} ใบ` : '…'}</div><div className="s">{dash.data?.overdueDrafts ? `ค้างเกิน 2 วัน ${dash.data.overdueDrafts} ใบ` : 'ไม่มีใบค้างเกิน 2 วัน'}</div></div>
        <Link className="card kpi" to="/stock-ledger?tab=reorder" data-testid="kpi-reorder"><div className="l">สินค้าต่ำกว่าจุดสั่งซื้อ</div><div className="v">{dash.data ? `${dash.data.belowReorder} รายการ` : '…'}</div><div className="s">ดูรายการที่ "สมุดคุมสต็อก"</div></Link>
      </div>
      <div className="card">
        <h2>
          <span>ซื้อเข้า / รับของ</span>
          <span className="row">
            {canReceive && <button className="btn sm pri" onClick={() => setModal('import')} data-testid="btn-delivery-import">นำเข้าไฟล์ใบส่งของ</button>}
            {canReceive && <button className="btn sm" onClick={() => setModal('manual')}>+ ซื้อเข้าแบบบันทึกเอง</button>}
            {can('sys.settings') === 1 && <button className="btn sm" onClick={() => setModal('settings')}>ตั้งค่าส่วนลดท้ายบิล</button>}
          </span>
        </h2>
        <DraftList onOpen={setDraftId} />
        <p className="small muted" style={{ margin: '8px 0 0' }}>นำเข้าไฟล์ใบส่งของ (CSV / Excel) แล้วระบบสร้างใบรับของร่าง 1 ใบต่อ 1 เลขที่ใบส่งของ · สต็อกเพิ่มเมื่อกดยืนยันรับเท่านั้น · ยืนยันแล้วตั้งเจ้าหนี้อัตโนมัติ</p>
      </div>
      <ReceiptList />
      {modal === 'import' && <DeliveryImportModal onClose={() => setModal(null)} onDone={(id) => { setModal(null); void refresh(); if (id) setDraftId(id); }} />}
      {modal === 'manual' && <ReceiptModal onClose={() => { setModal(null); void refresh(); }} />}
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} />}
      {draftId && <DraftModal id={draftId} onClose={() => { setDraftId(null); void refresh(); }} />}
    </>
  );
}

function DraftList({ onOpen }: { onOpen: (id: string) => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const r = useLoadMore(['pu', 'drafts'], '/api/gr-drafts', GrDraftSummary, { q: dq, status: 'draft' }, 10);
  const loading = r.isLoading;
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <input type="search" placeholder="ค้นหาเลขที่ใบส่งของ ใบสั่งซื้อ หรือผู้แทนจำหน่าย" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 200 }} aria-label="ค้นหาใบรับของร่าง" />
      </div>
      {r.isError && <ErrorBanner error={r.error} onRetry={() => void r.refetch()} retrying={r.isFetching} />}
      <div className="tw">
        <table data-testid="draft-table">
          <thead><tr><th>ใบส่งของ (DN)</th><th className="pu-hide-sm">ใบสั่งซื้อ</th><th>ผู้แทนจำหน่าย</th><th className="pu-hide-sm">วันที่ส่ง</th><th className="n">รายการ</th><th>ค้าง</th><th /></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={7} rows={3} /> : r.rows.map((g) => (
              <tr key={g.id} className="pu-click" onClick={() => onOpen(g.id)} title="แตะเพื่อตรวจรับ">
                <td className="mono">{g.dnNo ?? <span className="muted">ยังไม่มีเลข</span>}</td>
                <td className="mono pu-hide-sm">{g.poNo ?? '-'}</td>
                <td className="pu-cell-wrap">{g.dealerName ?? '-'}</td>
                <td className="pu-hide-sm">{thOrDash(g.deliveryDate)}</td>
                <td className="n">{g.lineCount}{g.unmatched ? <div><Pill k="warn">ยังไม่ผูก {g.unmatched}</Pill></div> : null}</td>
                <td><Pill k={g.ageDays >= 2 ? 'bad' : 'mut'}>{ageText(g.ageDays)}</Pill></td>
                <td><button className="btn sm pri" onClick={(e) => { e.stopPropagation(); onOpen(g.id); }} data-testid={`draft-open-${g.dnNo ?? 'none'}`}>ตรวจรับ</button></td>
              </tr>
            ))}
            {!loading && !r.rows.length && <tr><td colSpan={7} className="empty">ไม่มีของรอยืนยันรับ<br /><span className="small">นำเข้าไฟล์ใบส่งของ หรือบันทึกซื้อเข้าเอง</span></td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!r.hasNextPage} loading={r.isFetchingNextPage} onMore={() => void r.fetchNextPage()} count={r.rows.length} testId="drafts-more" />
    </>
  );
}

function ReceiptList() {
  const { can } = useAuth();
  const whs = useWarehouses();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const r = useLoadMore(['pu', 'receipts'], '/api/purchasing/receipts', GrSummary, { q: dq }, 20);
  const loading = r.isLoading;
  const seeCost = can('data.cost') === 1;
  const cols = seeCost ? 7 : 6;
  return (
    <div className="card">
      <h2>รับของแล้ว</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <input type="search" placeholder="ค้นหาเลขที่ใบรับ ผู้ขาย ใบกำกับ หรือใบส่งของ" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 200 }} aria-label="ค้นหาใบรับสินค้า" />
      </div>
      <div className="tw">
        <table data-testid="receipt-table">
          <thead><tr><th>เลขที่</th><th>DN / ใบกำกับ</th><th>วันที่</th><th>ผู้ขาย</th><th>สินค้า</th>{seeCost && <th className="n">ยอด</th>}<th>เจ้าหนี้</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={cols} rows={4} /> : r.rows.map((g) => (
              <tr key={g.id}>
                <td className="mono"><DocLink no={g.no} type="GR" /></td>
                <td className="mono small">{g.deliveryNo ?? '-'}<div className="muted">{g.vendorInvoiceNo ?? ''}</div></td>
                <td>{th(g.date)}</td>
                <td>{g.vendorName ?? '-'}<div className="small muted">{whs.data?.find((w) => w.id === g.warehouseId)?.name}</div></td>
                <td className="pu-cell-wrap small">{g.itemsPreview}<div className="muted">รับโดย {g.createdBy}</div>{g.note && <div className="muted">หมายเหตุ: {g.note}</div>}</td>
                {seeCost && <td className="n">{g.total != null ? fmt(g.total) : '-'}</td>}
                <td className="mono small"><DocLink no={g.apBillNo} type="AP" /></td>
              </tr>
            ))}
            {!loading && !r.rows.length && <tr><td colSpan={cols} className="empty">ยังไม่มีใบรับสินค้า</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!r.hasNextPage} loading={r.isFetchingNextPage} onMore={() => void r.fetchNextPage()} count={r.rows.length} testId="receipts-more" />
    </div>
  );
}

// ---------- delivery-file import (M19-08) ----------
function DeliveryImportModal({ onClose, onDone }: { onClose: () => void; onDone: (firstDraftId: string | null) => void }) {
  const toast = useToast();
  const vendors = useVendors();
  const whs = useWarehouses();
  const active = (whs.data ?? []).filter((w) => w.active);
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null);
  const [encoding, setEncoding] = useState<'auto' | 'utf8' | 'tis620'>('auto');
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [vat, setVat] = useState<'' | 'inc' | 'exc' | 'none'>('');
  const [mapping, setMapping] = useState<Record<string, number> | null>(null);
  const [pv, setPv] = useState<DeliveryPreview | null>(null);
  const [wh, setWh] = useState('');
  const [profileName, setProfileName] = useState('');
  const [force, setForce] = useState<string[]>([]);
  const [forceReason, setForceReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const whId = wh || active.find((w) => !w.isPos)?.id || active[0]?.id || '';
  const base = () => ({ fileName: file!.name, contentBase64: file!.b64, encoding, ...(vendorId ? { vendorId } : {}), ...(vat ? { vatFlagDefault: vat } : {}) });

  const preview = async (m: Record<string, number> | null, f = file) => {
    if (!f) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/delivery-imports/preview', { body: { fileName: f.name, contentBase64: f.b64, encoding, ...(vendorId ? { vendorId } : {}), ...(vat ? { vatFlagDefault: vat } : {}), ...(m ? { mapping: m } : {}) }, schema: DeliveryPreview });
      setPv(r);
      setMapping(r.mapping);
      if (!profileName && r.profileName) setProfileName(r.profileName);
    } catch (e) {
      setErr(errText(e));
      setPv(null);
    } finally {
      setBusy(false);
    }
  };
  const pick = async (f: File | undefined) => {
    if (!f) return;
    const nf = { name: f.name, b64: await readAsBase64(f) };
    setFile(nf);
    setMapping(null);
    setForce([]);
    await preview(null, nf);
  };
  const commit = async () => {
    if (!pv || !mapping) return;
    if (force.length && !forceReason.trim()) return setErr('นำเข้าซ้ำต้องระบุเหตุผล');
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/delivery-imports/commit', {
        body: { ...base(), mapping, warehouseId: whId, saveProfile: true, note: note.trim() || undefined, profileName: profileName.trim() || undefined, forceDnNos: force, forceReason: forceReason.trim() || undefined },
        schema: DeliveryCommitRes,
      });
      toast(`สร้างใบรับของร่าง ${r.drafts.length} ใบ${r.skipped.length ? ` · ข้าม ${r.skipped.length} ใบ` : ''}`);
      onDone(r.drafts[0]?.id ?? null);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const errorRows = pv?.rows.filter((r) => r.status === 'error') ?? [];
  const creatable = pv ? pv.groups.filter((g) => (!g.duplicate || (g.duplicate.kind === 'received' && g.dnNo && force.includes(g.dnNo))) && g.lines > g.errors).length : 0;

  return (
    <Modal onClose={onClose} wide label="นำเข้าไฟล์ใบส่งของ">
      <h3>นำเข้าไฟล์ใบส่งของ</h3>
      <p className="small muted" style={{ margin: 0 }}>ไฟล์ CSV หรือ Excel ที่มีรหัสสินค้า ชื่อ จำนวน หน่วย ราคา (ไม่เกิน 5 MB / 2,000 บรรทัด) · CSV อ่านได้ทั้ง UTF-8 และ TIS-620 · ระบบจำการจับคู่คอลัมน์ไว้ใช้ครั้งต่อไป</p>
      <div className="fgrid">
        <label className="f">ไฟล์ (.csv, .xlsx)<input type="file" accept=".csv,.xlsx,.txt" onChange={(e) => void pick(e.target.files?.[0])} data-testid="dl-file" /></label>
        <label className="f">Encoding (CSV)<select value={encoding} onChange={(e) => setEncoding(e.target.value as typeof encoding)}><option value="auto">ตรวจอัตโนมัติ</option><option value="utf8">UTF-8</option><option value="tis620">TIS-620 (ภาษาไทย Windows)</option></select></label>
        <label className="f">ผู้ขาย (ถ้าไฟล์ไม่ระบุ)<VendorPicker value={vendorId} onChange={(id) => setVendorId(id)} emptyLabel="— ตามชื่อในไฟล์ —" testId="dl-vendor" /></label>
        <label className="f">ราคาในไฟล์<select value={vat} onChange={(e) => setVat(e.target.value as typeof vat)}><option value="">ตามไฟล์ / ค่าที่จำไว้</option><option value="exc">ไม่รวม VAT</option><option value="inc">รวม VAT แล้ว</option><option value="none">ไม่มี VAT</option></select></label>
      </div>
      {file && <div className="row"><button className="btn sm" disabled={busy} onClick={() => void preview(mapping)}>ตรวจไฟล์อีกครั้ง</button>{busy && <span className="small muted">กำลังอ่านไฟล์…</span>}</div>}
      {pv && (
        <>
          {pv.fileImportedAt && <div className="note warn small">ไฟล์นี้นำเข้าแล้วเมื่อ {th(pv.fileImportedAt)} · เลขที่ใบส่งของที่เคยนำเข้าจะถูกข้าม</div>}
          <h4 className="sec">จับคู่คอลัมน์{pv.profileName ? ` · ใช้การจับคู่ที่จำไว้ "${pv.profileName}"` : ''} · {pv.encoding === 'xlsx' ? 'Excel' : pv.encoding === 'tis620' ? 'TIS-620' : 'UTF-8'}</h4>
          <div className="pu-map">
            {DELIVERY_FIELDS.map((f) => (
              <label key={f}>
                <span>{FIELD_TH[f]}{REQUIRED.has(f) && <span className="req"> *</span>}</span>
                <select value={mapping?.[f] ?? ''} aria-label={`คอลัมน์ ${FIELD_TH[f]}`} onChange={(e) => {
                  const m = { ...(mapping ?? {}) };
                  if (e.target.value === '') delete m[f]; else m[f] = Number(e.target.value);
                  setMapping(m);
                  void preview(m);
                }}>
                  <option value="">— ไม่ใช้ —</option>
                  {pv.headers.map((h, i) => <option key={i} value={i}>{h || `คอลัมน์ ${i + 1}`}</option>)}
                </select>
              </label>
            ))}
          </div>
          {pv.missingRequired.length > 0 && <div className="note bad small">ยังไม่ได้จับคู่: {pv.missingRequired.map((f) => FIELD_TH[f]).join(', ')}</div>}
          <h4 className="sec">ใบรับของร่างที่จะสร้าง (1 ใบต่อ 1 เลขที่ใบส่งของ)</h4>
          <div className="pu-groups">
            {pv.groups.map((g, i) => (
              <div className="pu-group" key={i} data-testid="dl-group">
                <b className="mono">{g.dnNo ? `DN ${g.dnNo}` : 'ไม่มีเลขที่ใบส่งของ'}</b>
                <span>{g.dealerName ?? 'ไม่ระบุผู้ขาย'}{g.vendorId ? ` → ${vendors.data?.find((v) => v.id === g.vendorId)?.name ?? ''}` : ' · เลือกผู้ขายตอนยืนยัน'}</span>
                <span className="muted">{g.lines} รายการ{g.deliveryDate ? ` · ส่ง ${th(g.deliveryDate)}` : ''}{g.poNo ? ` · ${g.poNo}` : ''}</span>
                <span className="row">{g.unmatched ? <Pill k="warn">ยังไม่ผูก {g.unmatched}</Pill> : null}{g.errors ? <Pill k="bad">ผิด {g.errors}</Pill> : null}{!g.dnNo && <Pill k="mut">กรอก DN ตอนยืนยัน</Pill>}</span>
                {g.duplicate && <div className="pu-msgs bad">{g.duplicate.kind === 'received' ? <>DN {g.dnNo} รับแล้วใน <DocLink no={g.duplicate.ref} type="GR" /> เมื่อ {th(g.duplicate.date)}</> : `DN ${g.dnNo} มีใบรับของร่างค้างอยู่แล้ว`}</div>}
                {g.duplicate?.kind === 'received' && g.dnNo && (
                  <label className="row small"><input type="checkbox" checked={force.includes(g.dnNo)} onChange={(e) => setForce((f) => (e.target.checked ? [...f, g.dnNo!] : f.filter((x) => x !== g.dnNo)))} /> นำเข้าซ้ำ (ต้องระบุเหตุผล)</label>
                )}
              </div>
            ))}
          </div>
          {force.length > 0 && <label className="f">เหตุผลที่นำเข้าซ้ำ *<input type="text" value={forceReason} onChange={(e) => setForceReason(e.target.value)} /></label>}
          <div className="row">
            <Pill k="ok">พร้อม {pv.counts.ok}</Pill><Pill k="warn">เตือน {pv.counts.warn}</Pill><Pill k="bad">ผิด {pv.counts.error}</Pill>
            {errorRows.length > 0 && <button className="btn sm" onClick={() => downloadErrorRows(file!.name, pv.headers, errorRows)} data-testid="dl-errors">ดาวน์โหลดไฟล์ error</button>}
          </div>
          <div className="tw" style={{ maxHeight: 320 }}>
            <table data-testid="dl-rows">
              <thead><tr><th>แถว</th><th>รหัส</th><th>ชื่อสินค้า</th><th className="n">จำนวน</th><th>หน่วย</th><th className="n">ราคา</th><th>DN</th><th>ผลตรวจ</th></tr></thead>
              <tbody>
                {pv.rows.map((r) => (
                  <tr key={r.rowNo} className={`pu-${r.status}`}>
                    <td>{r.rowNo}</td><td className="mono">{r.productCode || '-'}</td><td className="pu-cell-wrap">{r.productName}</td>
                    <td className="n">{r.qty != null ? fq(r.qty) : r.cells[mapping?.qty ?? -1] ?? '-'}</td><td>{r.unit}</td>
                    <td className="n">{r.unitPrice != null ? fmt(r.unitPrice) : '-'}</td><td className="mono small">{r.dnNo ?? '-'}</td>
                    <td><Pill k={STATUS_PILL[r.status]}>{STATUS_TH[r.status]}</Pill>{r.match ? <div className="pu-msgs">ผูกแล้ว ({r.match.via === 'alias' ? 'จำไว้' : r.match.via === 'sku' ? 'รหัสตรง' : 'บาร์โค้ด'})</div> : null}{r.messages.length > 0 && <div className={`pu-msgs${r.status === 'error' ? ' bad' : ''}`}>{r.messages.join(' · ')}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="fgrid">
            <label className="f">เข้าคลัง (แก้ได้ตอนตรวจรับ)<select value={whId} onChange={(e) => setWh(e.target.value)}>{active.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
            <label className="f">ชื่อการจับคู่ที่จะจำไว้<input type="text" value={profileName} placeholder="เช่น ไฟล์ทวีพัฒนา" onChange={(e) => setProfileName(e.target.value)} /></label>
            <NoteField value={note} onChange={setNote} testId="dl-note" label="หมายเหตุของการนำเข้า" placeholder="เช่น ไฟล์รอบส่งวันจันทร์" />
          </div>
        </>
      )}
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act">
        <button className="btn" onClick={onClose}>ยกเลิก</button>
        <button className="btn pri" disabled={busy || !pv || pv.missingRequired.length > 0 || creatable === 0} onClick={() => void commit()} data-testid="dl-commit">สร้างใบรับของร่าง {creatable ? `${creatable} ใบ` : ''}</button>
      </div>
    </Modal>
  );
}

// ---------- check and confirm a draft (REQ-M05-03 / 04) ----------
function DraftModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const meta = useMeta();
  const cat = useCatalog();
  const whs = useWarehouses();
  const r = useQuery({ queryKey: ['pu', 'draft', id], queryFn: () => api('GET', `/api/gr-drafts/${id}`, { schema: GrDraft }) });
  const [inv, setInv] = useState<string | null>(null);
  const [dn, setDn] = useState<string | null>(null);
  const [bd, setBd] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [newFor, setNewFor] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const g = r.data;
  const seeCost = can('data.cost') === 1;
  const vat = meta.data?.shop.vatRegistered ?? true;

  const patch = async (body: object) => {
    setErr('');
    try {
      const res = await api('PATCH', `/api/gr-drafts/${id}`, { body, schema: GrDraft });
      qc.setQueryData(['pu', 'draft', id], res);
    } catch (e) {
      setErr(errText(e));
    }
  };
  if (!g) return <Modal onClose={onClose} wide label="ตรวจรับของ"><h3>ตรวจรับของ</h3>{r.isError ? <ErrorBanner error={r.error} onRetry={() => void r.refetch()} retrying={r.isFetching} /> : <><div className="sk" /><div className="sk" /></>}</Modal>;
  const mismatch = g.lines.some((l) => !d(l.receivedQty).eq(d(l.qty)) || d(l.damagedQty).gt(0));
  const amount = g.lines.reduce((a, l) => a.plus(l.unitCost ? d(l.unitCost).times(d(l.receivedQty).minus(d(l.damagedQty))) : 0), d(0));
  const invNo = inv ?? g.invoiceNo ?? '';
  const dnNo = dn ?? g.dnNo ?? '';
  const confirm = async () => {
    if (!dnNo.trim()) return setErr('กรอกเลขที่ใบส่งของ');
    if (!invNo.trim()) return setErr('กรอกเลขที่ใบกำกับภาษีผู้ขาย');
    if (mismatch && !reason.trim()) return setErr('รับไม่ตรงใบส่งของ ต้องระบุเหตุผล');
    setBusy(true);
    setErr('');
    try {
      const res = await api('POST', `/api/gr-drafts/${id}/confirm`, { body: { vendorInvoiceNo: invNo.trim(), deliveryNo: dnNo.trim(), billDiscount: bd.trim() || '0', shortReason: reason.trim() || undefined, note: note.trim() || undefined }, schema: GrDraftConfirmRes });
      toast(`รับเข้าสต็อก ${res.grNo} แล้ว${res.apBillNo ? ` · ตั้งเจ้าหนี้ ${res.apBillNo}` : ''}`);
      await qc.invalidateQueries({ queryKey: ['stock'] });
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!window.confirm('ยกเลิกใบรับของร่างนี้?')) return;
    try {
      await api('POST', `/api/gr-drafts/${id}/cancel`, { body: { reason: 'ยกเลิกจากหน้าตรวจรับ' } });
      onClose();
    } catch (e) {
      setErr(errText(e));
    }
  };

  return (
    <Modal onClose={onClose} wide label="ตรวจรับของ">
      <h3>ตรวจรับของ · {g.dnNo ? `DN ${g.dnNo}` : 'ยังไม่มีเลขที่ใบส่งของ'}</h3>
      <div className="small muted">{g.poNo ?? ''}{g.poNo ? ' · ' : ''}{g.dealerName ?? 'ไม่ระบุผู้ขาย'} · นำเข้า {th(g.receivedOn)} โดย {g.createdBy}{g.ageDays >= 2 ? ` · ค้าง ${g.ageDays} วัน` : ''}</div>
      <div className="fgrid">
        <label className="f">ผู้ขาย *<VendorPicker value={g.vendorId} onChange={(id) => void patch({ vendorId: id })} testId="draft-vendor" invalid={!g.vendorId} /></label>
        <label className="f">เข้าคลัง *<select value={g.warehouseId ?? ''} onChange={(e) => void patch({ warehouseId: e.target.value || null })} data-testid="draft-wh"><option value="">— เลือกคลัง —</option>{(whs.data ?? []).filter((w) => w.active).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        <label className="f">เลขที่ใบส่งของ *<input type="text" value={dnNo} onChange={(e) => setDn(e.target.value)} data-testid="draft-dn" /></label>
        <label className="f">เลขที่ใบกำกับภาษีผู้ขาย *<input type="text" value={invNo} onChange={(e) => setInv(e.target.value)} data-testid="draft-inv" /></label>
      </div>
      <div className="tw">
        <table data-testid="draft-lines">
          <thead><tr><th>ในไฟล์</th><th>สินค้าของร้าน</th><th>หน่วย</th><th className="n">ตามใบส่ง</th><th className="n">รับจริง</th><th className="n">เสียหาย</th>{seeCost && <th className="n">ทุน/หน่วย</th>}</tr></thead>
          <tbody>
            {g.lines.map((l) => {
              const p = l.productId ? cat.byId.get(l.productId) : undefined;
              return (
                <tr key={l.id}>
                  <td className="pu-cell-wrap"><span className="mono small">{l.externalCode}</span><div>{l.externalName}</div>{l.warnings.length > 0 && <div className="pu-msgs">{l.warnings.join(' · ')}</div>}</td>
                  <td>
                    <ProductPicker value={l.productId} warehouseId={g.warehouseId} filter={isStock} ariaLabel={`ผูกสินค้า ${l.externalCode}`} testId={`draft-p-${l.externalCode}`}
                      placeholder="— ยังไม่ผูก · พิมพ์ค้นหาสินค้า —" style={{ minWidth: 220 }}
                      onChange={(id) => void patch({ lines: [{ lineId: l.id, productId: id }] })} />
                    {!l.productId && <div><span className="small" style={{ color: 'var(--warn)' }}>ยังไม่ผูกกับสินค้าของร้าน</span> {(can('data.master') === 1 || can('inv.receive') === 1) && <button className="btn sm" onClick={() => setNewFor(l.id)} data-testid={`draft-new-${l.externalCode}`}>สร้างสินค้าใหม่</button>}</div>}
                  </td>
                  <td>{p ? <select value={l.unitIdx ?? ''} aria-label="หน่วย" onChange={(e) => void patch({ lines: [{ lineId: l.id, unitIdx: e.target.value === '' ? null : Number(e.target.value) }] })}><option value="">— เลือก —</option>{p.units.map((u, k) => <option key={k} value={k}>{u.name}</option>)}</select> : <span className="muted">{l.unitText}</span>}{p && l.unitIdx == null && <div className="pu-msgs bad">ไฟล์: {l.unitText}</div>}</td>
                  <td className="n">{fq(l.qty)}<div className="small muted">{l.unitText}</div></td>
                  <td className="n"><input className="pu-qty-in" type="text" inputMode="decimal" defaultValue={l.receivedQty} aria-label={`รับจริง ${l.externalCode}`} onBlur={(e) => { if (e.target.value !== l.receivedQty) void patch({ lines: [{ lineId: l.id, receivedQty: e.target.value.trim() || '0' }] }); }} /></td>
                  <td className="n"><input className="pu-qty-in" type="text" inputMode="decimal" defaultValue={l.damagedQty} aria-label={`เสียหาย ${l.externalCode}`} onBlur={(e) => { if (e.target.value !== l.damagedQty) void patch({ lines: [{ lineId: l.id, damagedQty: e.target.value.trim() || '0' }] }); }} /></td>
                  {seeCost && <td className="n">{l.unitCost != null ? fmt(l.unitCost) : '-'}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <NoteField value={note} onChange={setNote} testId="draft-note" placeholder="เช่น ถุงปูนฉีก 1 ถุง ผู้ขายจะเปลี่ยนให้รอบหน้า" />
      {mismatch && <label className="f">เหตุผลที่รับไม่ตรง *<input type="text" value={reason} placeholder="เช่น ถุงแตก 2 ถุง" onChange={(e) => setReason(e.target.value)} data-testid="draft-reason" /></label>}
      <div className="grid g2" style={{ gap: 12 }}>
        <label className="f">ส่วนลดท้ายบิลตามใบกำกับ (บาท{vat ? ' ก่อน VAT' : ''})<input type="text" inputMode="decimal" value={bd} placeholder="0" onChange={(e) => setBd(e.target.value)} /></label>
        {seeCost && <div className="tot"><span className="muted">มูลค่าที่รับ{g.vatFlag === 'inc' ? ' (แปลงเป็นก่อน VAT แล้ว)' : ''}</span><span>{fmt(amount)}</span></div>}
      </div>
      {g.unmatched > 0 && <div className="note warn small">ยืนยันรับได้เมื่อผูกสินค้าและหน่วยครบทุกรายการ (ยังไม่ผูก {g.unmatched} รายการ) · การผูกจะจำไว้ใช้กับไฟล์ครั้งถัดไป</div>}
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act">
        {can('inv.receive') === 1 && <button className="btn bad" onClick={() => void cancel()}>ยกเลิกใบร่าง</button>}
        <button className="btn" onClick={onClose}>ไว้ทีหลัง</button>
        <button className="btn pri" disabled={busy || g.unmatched > 0 || !g.vendorId || !g.warehouseId || can('inv.receive') !== 1} onClick={() => void confirm()} data-testid="draft-confirm">ยืนยันรับเข้าสต็อก</button>
      </div>
      {newFor && <NewProductModal draftId={id} line={g.lines.find((l) => l.id === newFor)!} onClose={() => setNewFor(null)} onDone={(res) => { qc.setQueryData(['pu', 'draft', id], res); void qc.invalidateQueries({ queryKey: ['catalog'] }); setNewFor(null); }} />}
    </Modal>
  );
}

function NewProductModal({ draftId, line, onClose, onDone }: { draftId: string; line: GrDraft['lines'][number]; onClose: () => void; onDone: (d: GrDraft) => void }) {
  const [sku, setSku] = useState(line.externalCode);
  const [name, setName] = useState(line.externalName);
  const [unit, setUnit] = useState(line.unitText);
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('');
  const [err, setErr] = useState('');
  const save = async () => {
    try {
      onDone(await api('POST', `/api/gr-drafts/${draftId}/lines/${line.id}/product`, { body: { sku: sku.trim(), name: name.trim(), unitName: unit.trim(), price: price.trim() || '0', category: category.trim() }, schema: GrDraft }));
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <Modal onClose={onClose} label="สร้างสินค้าใหม่">
      <h3>สร้างสินค้าใหม่จากใบส่งของ</h3>
      <div className="fgrid">
        <label className="f">รหัสสินค้า<input type="text" value={sku} onChange={(e) => setSku(e.target.value)} /></label>
        <label className="f">หน่วยหลัก<input type="text" value={unit} onChange={(e) => setUnit(e.target.value)} /></label>
        <label className="f" style={{ gridColumn: '1/-1' }}>ชื่อสินค้า<input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="f">ราคาขาย<input type="text" inputMode="decimal" value={price} placeholder="0" onChange={(e) => setPrice(e.target.value)} /></label>
        <label className="f">หมวดสินค้า<input type="text" value={category} onChange={(e) => setCategory(e.target.value)} /></label>
      </div>
      <p className="small muted" style={{ margin: 0 }}>บันทึกแล้วผูกกับบรรทัดนี้ทันที และจำรหัส {line.externalCode} ไว้ใช้กับไฟล์ครั้งถัดไป</p>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" onClick={() => void save()} data-testid="np-save">บันทึกและผูก</button></div>
    </Modal>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const s = useQuery({ queryKey: ['pu', 'settings'], queryFn: () => api('GET', '/api/purchasing/settings', { schema: PurchasingSettings }) });
  const [err, setErr] = useState('');
  const set = async (billDiscountMode: 'sep' | 'alloc') => {
    try {
      await api('PATCH', '/api/purchasing/settings', { body: { billDiscountMode }, schema: PurchasingSettings });
      await s.refetch();
      toast('บันทึกการตั้งค่าแล้ว');
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <Modal onClose={onClose} label="ตั้งค่าส่วนลดท้ายบิล">
      <h3>ส่วนลดท้ายบิลตอนซื้อ (BR-19)</h3>
      {(['sep', 'alloc'] as const).map((m) => (
        <label key={m} className="row"><input type="radio" name="bdm" checked={s.data?.billDiscountMode === m} onChange={() => void set(m)} />
          {m === 'sep' ? 'บันทึกเป็นส่วนลดรับแยก ไม่ลดทุนรายสินค้า (ค่าเริ่มต้น)' : 'กระจายเข้าทุนสินค้าตามสัดส่วนมูลค่า'}</label>
      ))}
      <p className="small muted" style={{ margin: 0 }}>ยอดเจ้าหนี้และภาษีซื้อคิดจากยอดหลังหักส่วนลดเสมอ · การเปลี่ยนมีผลกับใบรับที่บันทึกหลังจากนี้</p>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn pri" onClick={onClose}>ปิด</button></div>
    </Modal>
  );
}
