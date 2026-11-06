/**
 * REQ-M14-01 open a shop (owner user + employee together), REQ-M14-04 suspend / resume with a reason,
 * REQ-M14-05 read-only support view (needs the shop's grant), REQ-M19-07 import an on-prem export as a new shop.
 */
import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { AdmImportResult, AdmSupportView, AdmTenant, page } from '@erp/contracts';
import { ROLE_TH } from '../../../auth';
import { Modal, Pager, Pill, SkeletonRows, fmt, th, thTime, useCursorPager, useDebounced, useToast } from '../../../ui';
import { admErr } from '../common';
import { admApi, admCan, useAdm } from './admApi';
import { ErrorBanner, checkFields, requiredMsg } from '../../../errors';

const REGIONS = ['ภาคเหนือ', 'ภาคกลาง', 'ภาคตะวันออกเฉียงเหนือ', 'ภาคตะวันออก', 'ภาคตะวันตก', 'ภาคใต้', 'กรุงเทพและปริมณฑล'];

export default function Shops() {
  const { admin } = useAdm();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | 'active' | 'suspended'>('');
  const dq = useDebounced(q.trim(), 300);
  const pager = useCursorPager(`${dq}|${status}`);
  const list = useQuery({
    queryKey: ['scg', 'tenants', dq, status, pager.cursor], placeholderData: keepPreviousData,
    queryFn: () => admApi('GET', '/api/adm/tenants', { query: { q: dq, status: status || undefined, limit: 20, cursor: pager.cursor }, schema: page(AdmTenant) }),
  });
  const [modal, setModal] = useState<null | { kind: 'new' } | { kind: 'import' } | { kind: 'status'; t: AdmTenant } | { kind: 'support'; t: AdmTenant }>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['scg'] }); };
  const loading = list.isLoading || (list.isFetching && list.isPlaceholderData);
  const write = admCan(admin, 'shopsWrite');

  return (
    <div className="card">
      <h2>
        ร้านค้าที่ใช้ระบบ
        <span className="row">
          {write && <button className="btn sm" onClick={() => setModal({ kind: 'import' })} data-testid="shop-import">นำเข้าร้านจาก On-premise</button>}
          {write && <button className="btn sm pri" onClick={() => setModal({ kind: 'new' })} data-testid="shop-new">+ เปิดร้านใหม่</button>}
        </span>
      </h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <input type="search" style={{ flex: 1, minWidth: 180 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นชื่อร้าน รหัส เลขผู้เสียภาษี ภาค หรือรหัสลูกค้า SCG" aria-label="ค้นหาร้าน" />
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="สถานะร้าน"><option value="">ทุกสถานะ</option><option value="active">ใช้งาน</option><option value="suspended">ระงับ</option></select>
      </div>
      {list.isError && <ErrorBanner error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
      <div className="tw">
        <table data-testid="shops-table">
          <thead><tr><th>รหัส</th><th>ร้าน</th><th>ภาค</th><th>Edition</th><th>สถานะ</th><th className="n">ผู้ใช้</th><th className="n">บิล 30 วัน</th><th className="n">ยอดขายเดือนนี้</th><th>บิลล่าสุด</th><th /></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={10} /> : (list.data?.items ?? []).map((t) => (
              <tr key={t.id}>
                <td className="mono small">{t.code}</td>
                <td>{t.name}<div className="small muted">{t.taxId}{t.vatRegistered ? ' · จด VAT' : ''}{t.customerCode ? ` · ลูกค้า ${t.customerCode}` : ''}</div></td>
                <td className="small">{t.region || '-'}</td>
                <td><span className={`ed ${t.edition}`}>{t.edition === 'cloud' ? 'Cloud' : 'On-premise'}</span></td>
                <td>{t.status === 'active' ? <Pill k="ok">ใช้งาน</Pill> : <span title={t.statusReason ?? ''}><Pill k="bad">ระงับ</Pill></span>}</td>
                <td className="n">{t.users}</td><td className="n">{t.bills30d}</td><td className="n">{fmt(t.salesMonth)}</td>
                <td className="small">{t.lastBillAt ? thTime(t.lastBillAt) : '-'}</td>
                <td>
                  <div className="row">
                    {write && <button className={`btn sm${t.status === 'active' ? ' bad' : ''}`} onClick={() => setModal({ kind: 'status', t })} data-testid={`shop-status-${t.code}`}>{t.status === 'active' ? 'ระงับ' : 'เปิดกลับ'}</button>}
                    {admCan(admin, 'support') && <button className="btn sm" onClick={() => setModal({ kind: 'support', t })}>ดูแบบ support</button>}
                  </div>
                </td>
              </tr>
            ))}
            {!loading && list.data && !list.data.items.length && <tr><td colSpan={10} className="empty">ไม่พบร้าน</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!list.data?.nextCursor} count={list.data?.items.length} loading={list.isFetching} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor ?? null)} />
      <p className="small muted">ยอดขายเป็นยอดรวมของร้าน ไม่แสดงข้อมูลส่วนบุคคลของลูกค้าร้าน · การเข้าดูแบบ support ต้องได้รับอนุญาตจากเจ้าของร้านและบันทึกใน log ของร้าน</p>
      {modal?.kind === 'new' && <NewShop onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); }} />}
      {modal?.kind === 'import' && <ImportShop onClose={() => setModal(null)} onDone={refresh} />}
      {modal?.kind === 'status' && <StatusModal t={modal.t} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); }} />}
      {modal?.kind === 'support' && <SupportModal t={modal.t} onClose={() => setModal(null)} />}
    </div>
  );
}

function NewShop({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ code: '', name: '', taxId: '', branch: 'สำนักงานใหญ่', vat: true, region: REGIONS[0]!, customerCode: '', address: '', phone: '', oUser: '', oName: '', oPass: '', oPin: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    if (!checkFields({
      code: !/^[a-z0-9-]{3,30}$/.test(f.code) && 'รหัสร้าน a–z 0–9 - 3–30 ตัว', name: requiredMsg(f.name, 'ชื่อร้าน'),
      taxId: !/^\d{13}$/.test(f.taxId) && 'เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก',
      'owner.name': requiredMsg(f.oName, 'ชื่อเจ้าของร้าน'), 'owner.username': !/^[a-z0-9._]{3,20}$/.test(f.oUser) && 'ชื่อผู้ใช้เจ้าของร้าน a–z 0–9 . _ 3–20 ตัว',
      'owner.password': f.oPass.length < 6 && 'รหัสผ่านเริ่มต้นอย่างน้อย 6 ตัว', 'owner.pin': !/^\d{4,6}$/.test(f.oPin) && 'PIN อนุมัติ 4–6 หลัก',
    })) return;
    setBusy(true);
    setErr('');
    try {
      const t = await admApi('POST', '/api/adm/tenants', {
        body: {
          code: f.code, name: f.name.trim(), taxId: f.taxId, branch: f.branch, vatRegistered: f.vat, region: f.region, customerCode: f.customerCode.trim(),
          address: f.address.trim(), phone: f.phone.trim(), owner: { username: f.oUser, name: f.oName.trim(), password: f.oPass, pin: f.oPin },
        },
        schema: AdmTenant,
      });
      toast(`เปิดร้าน ${t.name} แล้ว · เจ้าของร้านเข้าระบบด้วย ${f.oUser} และลงนามสัญญาก่อนใช้งาน`);
      onDone();
    } catch (e) {
      setErr(admErr(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} wide label="เปิดร้านใหม่">
      <h3>เปิดร้านซับดีลเลอร์ใหม่</h3>
      <div className="fgrid">
        <label className="f">รหัสร้าน *<input type="text" name="code" value={f.code} placeholder="เช่น lampang-home" onChange={(e) => set('code', e.target.value.toLowerCase())} data-testid="ns-code" /></label>
        <label className="f">ชื่อร้าน *<input type="text" name="name" value={f.name} onChange={(e) => set('name', e.target.value)} data-testid="ns-name" /></label>
        <label className="f">เลขผู้เสียภาษี *<input type="text" inputMode="numeric" maxLength={13} name="taxId" value={f.taxId} onChange={(e) => set('taxId', e.target.value.replace(/\D/g, ''))} data-testid="ns-tax" /></label>
        <label className="f">สาขา<input type="text" value={f.branch} onChange={(e) => set('branch', e.target.value)} /></label>
        <label className="f">ภาค / เขตขาย<select value={f.region} onChange={(e) => set('region', e.target.value)}>{REGIONS.map((r) => <option key={r}>{r}</option>)}</select></label>
        <label className="f">รหัสลูกค้า SCG (customer code)<input type="text" value={f.customerCode} onChange={(e) => set('customerCode', e.target.value)} /></label>
        <label className="f">โทร<input type="text" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></label>
        <label className="row small"><input type="checkbox" checked={f.vat} onChange={(e) => set('vat', e.target.checked)} /> จดทะเบียน VAT</label>
        <label className="f" style={{ gridColumn: '1/-1' }}>ที่อยู่<input type="text" value={f.address} onChange={(e) => set('address', e.target.value)} /></label>
      </div>
      <h4 className="sec">เจ้าของร้าน (ผู้ใช้คนแรก · สร้างพร้อมพนักงาน)</h4>
      <div className="fgrid">
        <label className="f">ชื่อเจ้าของร้าน *<input type="text" data-field="owner.name" value={f.oName} onChange={(e) => set('oName', e.target.value)} data-testid="ns-oname" /></label>
        <label className="f">ชื่อผู้ใช้ *<input type="text" data-field="owner.username" value={f.oUser} autoComplete="off" onChange={(e) => set('oUser', e.target.value.toLowerCase())} data-testid="ns-ouser" /></label>
        <label className="f">รหัสผ่านเริ่มต้น *<input type="password" autoComplete="new-password" data-field="owner.password" value={f.oPass} onChange={(e) => set('oPass', e.target.value)} data-testid="ns-opass" /></label>
        <label className="f">PIN อนุมัติ *<input type="password" inputMode="numeric" maxLength={6} data-field="owner.pin" value={f.oPin} onChange={(e) => set('oPin', e.target.value)} data-testid="ns-opin" /></label>
      </div>
      <p className="small muted" style={{ margin: 0 }}>ระบบสร้างร้าน คลังหน้าร้าน (POS) และเจ้าของร้าน · เจ้าของร้านต้องลงนามสัญญาการใช้งานตอนเข้าระบบครั้งแรกก่อนใช้เมนูอื่น</p>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={busy} onClick={() => void save()} data-testid="ns-save">เปิดร้าน</button></div>
    </Modal>
  );
}

function StatusModal({ t, onClose, onDone }: { t: AdmTenant; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const suspend = t.status === 'active';
  const go = async () => {
    if (!reason.trim()) return setErr('ใส่เหตุผล (บันทึกใน log ของร้านและของ SCG)');
    try {
      await admApi('POST', `/api/adm/tenants/${t.id}/${suspend ? 'suspend' : 'resume'}`, { body: { reason: reason.trim() }, schema: AdmTenant });
      toast(suspend ? `ระงับร้าน ${t.name} แล้ว` : `เปิดร้าน ${t.name} กลับแล้ว`);
      onDone();
    } catch (e) {
      setErr(admErr(e));
    }
  };
  return (
    <Modal onClose={onClose} label={suspend ? 'ระงับร้าน' : 'เปิดร้านกลับ'}>
      <h3>{suspend ? 'ระงับร้าน' : 'เปิดร้านกลับ'} · {t.name}</h3>
      {suspend && <div className="note warn small">ผู้ใช้ทุกคนของร้านเข้าระบบไม่ได้ทันที (รวมคนที่เข้าอยู่) · ข้อมูลยังอยู่ครบ เปิดกลับได้ภายหลัง</div>}
      <label className="f">เหตุผล *<input type="text" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="status-reason" /></label>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className={`btn ${suspend ? 'bad' : 'pri'}`} onClick={() => void go()} data-testid="status-ok">{suspend ? 'ยืนยันระงับ' : 'เปิดกลับ'}</button></div>
    </Modal>
  );
}

function SupportModal({ t, onClose }: { t: AdmTenant; onClose: () => void }) {
  const v = useQuery({ queryKey: ['scg', 'support', t.id], retry: false, queryFn: () => admApi('POST', `/api/adm/tenants/${t.id}/support`, { body: {}, schema: AdmSupportView }) });
  const x = v.data;
  return (
    <Modal onClose={onClose} wide label="ดูร้านแบบ support">
      <h3>ดูร้านแบบอ่านอย่างเดียว · {t.name}</h3>
      {v.isLoading && <div className="sk" />}
      {v.isError && <div className="note warn small">{admErr(v.error)}</div>}
      {x && (
        <>
          <div className="note small">เจ้าของร้าน ({x.grant.grantedBy}) อนุญาตถึง {thTime(x.grant.expiresAt)} · การเข้าดูครั้งนี้บันทึกใน log ของร้านแล้ว</div>
          <div className="row small">{Object.entries(x.counts).map(([k, n]) => <span key={k} className="pill p-mut">{k} {n}</span>)}</div>
          <div className="grid g2">
            <div className="tw"><table><thead><tr><th>ผู้ใช้</th><th>บทบาท</th><th>สถานะ</th></tr></thead><tbody>{x.users.map((u) => <tr key={u.username}><td>{u.name}<div className="small muted mono">{u.username}</div></td><td className="small">{ROLE_TH[u.role]}</td><td>{u.locked ? <Pill k="bad">ล็อก</Pill> : u.status === 'active' ? <Pill k="ok">ใช้งาน</Pill> : <Pill k="mut">ลาออก</Pill>}</td></tr>)}</tbody></table></div>
            <div className="tw"><table><thead><tr><th>เอกสารล่าสุด</th><th>วันที่</th><th className="n">ยอด</th></tr></thead><tbody>{x.recentDocs.map((dd) => <tr key={dd.no}><td className="mono small">{dd.no}<div className="muted">{dd.type} · {dd.status}</div></td><td className="small">{th(dd.date)}</td><td className="n">{fmt(dd.total)}</td></tr>)}</tbody></table></div>
          </div>
          <div className="tw"><table><thead><tr><th>เวลา</th><th>ผู้ทำ</th><th>การกระทำ</th><th>เรื่อง</th><th>เลขที่</th></tr></thead><tbody>{x.recentAudit.map((a, i) => <tr key={i}><td className="small mono">{thTime(a.at)}</td><td className="small">{a.user}</td><td className="small">{a.action}</td><td className="small">{a.object}</td><td className="small mono">{a.ref ?? ''}</td></tr>)}</tbody></table></div>
        </>
      )}
      <div className="act"><button className="btn pri" onClick={onClose}>ปิด</button></div>
    </Modal>
  );
}

/** REQ-M19-07: the encrypted file exported by an on-prem shop becomes a new cloud shop; totals are verified. */
function ImportShop({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [region, setRegion] = useState(REGIONS[0]!);
  const [pass, setPass] = useState('');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<z.infer<typeof AdmImportResult> | null>(null);
  const go = async () => {
    if (!/^[a-z0-9-]{3,30}$/.test(code)) return setErr('รหัสร้านใหม่ a–z 0–9 - 3–30 ตัว');
    if (!file) return setErr('เลือกไฟล์ .scgshop');
    if (pass.length < 8) return setErr('รหัสผ่านไฟล์อย่างน้อย 8 ตัว');
    setBusy(true);
    setErr('');
    try {
      setRes(await admApi('POST', '/api/adm/tenants/import', { body: { code, region, passphrase: pass, file: file.text }, schema: AdmImportResult }));
      onDone();
    } catch (e) {
      setErr(admErr(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="นำเข้าร้านจาก On-premise">
      <h3>นำเข้าร้านจาก On-premise</h3>
      {res ? (
        <>
          <div className="note small" data-testid="import-result">
            นำเข้า <b>{res.tenant.name}</b> เป็นร้าน Cloud รหัส <span className="mono">{res.tenant.code}</span> แล้ว · ตรวจแล้ว {res.verified.tables} ตาราง {res.verified.rows} แถว
            ผลรวม {res.verified.numericColumns} คอลัมน์ตัวเลขตรงกับไฟล์ · log {res.verified.auditChainOk ? 'ต่อเนื่องครบถ้วน' : 'ไม่ครบ'}
          </div>
          <div className="act"><button className="btn pri" onClick={onClose}>ปิด</button></div>
        </>
      ) : (
        <>
          <div className="fgrid">
            <label className="f">รหัสร้านใหม่บน Cloud *<input type="text" value={code} onChange={(e) => setCode(e.target.value.toLowerCase())} /></label>
            <label className="f">ภาค / เขตขาย<select value={region} onChange={(e) => setRegion(e.target.value)}>{REGIONS.map((r) => <option key={r}>{r}</option>)}</select></label>
            <label className="f" style={{ gridColumn: '1/-1' }}>ไฟล์ส่งออกจากร้าน (.scgshop)
              <input type="file" accept=".scgshop,application/json" onChange={(e) => { const fl = e.target.files?.[0]; if (fl) void fl.text().then((text) => setFile({ name: fl.name, text })); }} />
            </label>
            <label className="f" style={{ gridColumn: '1/-1' }}>รหัสผ่านไฟล์ (ร้านแจ้งแยกช่องทาง)<input type="password" value={pass} onChange={(e) => setPass(e.target.value)} /></label>
          </div>
          <p className="small muted" style={{ margin: 0 }}>หลังนำเข้า ระบบตรวจจำนวนแถวทุกตาราง ผลรวมทุกคอลัมน์ตัวเลข และ log ต้องตรงกับไฟล์ 100% ไม่ตรงจะยกเลิกทั้งหมด</p>
          {err && <div className="err" role="alert">{err}</div>}
          <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={busy} onClick={() => void go()}>{busy ? 'กำลังนำเข้า…' : 'นำเข้า'}</button></div>
        </>
      )}
    </Modal>
  );
}
