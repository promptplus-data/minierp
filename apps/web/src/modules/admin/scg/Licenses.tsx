/**
 * REQ-M19-11 issue on-prem license keys (expiring / lifetime, bound to shop name + tax id, signed by the cloud
 * server's private key) and the key registry; REQ-M19-10 the sales summaries shops chose to send.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { AdmLicense, AdmShare, FEATURE_KEYS, page, type FeatureKey } from '@erp/contracts';
import { FeaturePicker, featureSummary } from './FeaturePicker';
import { addDays } from '@erp/core';
import { Modal, Pill, SkeletonRows, fmt, fq, th, thTime, useDebounced, useToast } from '../../../ui';
import { LoadMore } from '../../../ui/lists';
import { SearchSelect, type RemotePage } from '../../../ui/SearchSelect';
import { admErr, todayYmd } from '../common';
import { admApi, useAdmLoadMore, admCan, useAdm } from './admApi';
import { checkFields, requiredMsg } from '../../../errors';

type Lic = z.infer<typeof AdmLicense>;
const REGIONS = ['', 'ภาคเหนือ', 'ภาคกลาง', 'ภาคตะวันออกเฉียงเหนือ', 'ภาคตะวันออก', 'ภาคตะวันตก', 'ภาคใต้', 'กรุงเทพและปริมณฑล'];

export default function Licenses() {
  const { admin } = useAdm();
  const qc = useQueryClient();
  const write = admCan(admin, 'licenseWrite');
  const [sp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const dq = useDebounced(q.trim(), 300);
  const list = useAdmLoadMore(['scg', 'licenses'], '/api/adm/licenses', AdmLicense, { q: dq });
  const [issued, setIssued] = useState<Lic | null>(null);
  const [show, setShow] = useState<Lic | null>(null);
  const [revoke, setRevoke] = useState<Lic | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['scg'] }); };
  const loading = list.isLoading;
  const today = todayYmd();
  return (
    <>
      {write && <IssueForm onIssued={(l) => { setIssued(l); refresh(); }} />}
      <div className="card">
        <h2>ทะเบียน license</h2>
        <input type="search" style={{ width: '100%', marginBottom: 10 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นชื่อร้าน เลขผู้เสียภาษี เลขที่ license หรือภาค" aria-label="ค้นหา license" />
        <div className="tw">
          <table data-testid="license-table">
            <thead><tr><th>เลขที่</th><th>ร้าน</th><th>ประเภท</th><th>หมดอายุ</th><th>ออกเมื่อ / โดย</th><th>ส่งยอดล่าสุด</th><th>สถานะ</th><th /></tr></thead>
            <tbody>
              {loading ? <SkeletonRows cols={8} /> : list.rows.map((l) => {
                const expired = !!l.expiresAt && l.expiresAt < today;
                const soon = !!l.expiresAt && !expired && l.expiresAt <= addDays(today, 30);
                return (
                  <tr key={l.licenseId} className={l.revokedAt ? 'off' : ''}>
                    <td className="mono small">{l.licenseId}</td>
                    <td><Link to={`/scg/shops?q=${encodeURIComponent(l.taxId)}`}>{l.shopName}</Link><div className="small muted">{l.taxId}{l.region ? ` · ${l.region}` : ''}</div></td>
                    <td className="small">{l.type === 'lifetime' ? 'ตลอดชีพ' : 'มีวันหมดอายุ'}<div className="muted">{l.edition === 'cloud' ? 'Cloud' : `On-premise · ${featureSummary(l.features)}`}</div></td>
                    <td className="small">{l.expiresAt ? th(l.expiresAt) : '-'}</td>
                    <td className="small">{thTime(l.issuedAt)}<div className="muted">{l.issuedBy}</div></td>
                    <td className="small">{l.lastShareAt ? thTime(l.lastShareAt) : '-'}</td>
                    <td>{l.revokedAt ? <Pill k="mut">ยกเลิกแล้ว</Pill> : expired ? <Pill k="bad">หมดอายุ</Pill> : soon ? <Pill k="warn">ใกล้หมดอายุ</Pill> : <Pill k="ok">ใช้งาน</Pill>}</td>
                    <td><div className="row"><button className="btn sm" onClick={() => setShow(l)}>ดูคีย์</button>{write && !l.revokedAt && <button className="btn sm bad" onClick={() => setRevoke(l)}>ยกเลิก</button>}</div></td>
                  </tr>
                );
              })}
              {!loading && list.data && !list.rows.length && <tr><td colSpan={8} className="empty">ยังไม่มี license</td></tr>}
            </tbody>
          </table>
        </div>
        <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onMore={() => void list.fetchNextPage()} count={list.rows.length} />
        <p className="small muted">คีย์ตรวจในเครื่องของร้านโดยไม่ต่อเน็ต การยกเลิกจึงไม่ปิดเครื่องของร้าน แต่ SCG จะไม่รับสรุปยอดขายจากคีย์ที่ยกเลิก · ต่ออายุ = ออกคีย์ใหม่ให้ร้านใส่แทน</p>
      </div>
      {(issued ?? show) && <KeyModal l={(issued ?? show)!} fresh={!!issued} onClose={() => { setIssued(null); setShow(null); }} />}
      {revoke && <RevokeModal l={revoke} onClose={() => setRevoke(null)} onDone={() => { setRevoke(null); refresh(); }} />}
    </>
  );
}

/** Shops that already hold a license (renewal): searched on the server by name / tax ID / license no. / region. */
const licPage = page(AdmLicense);
const fetchLicensedShops = (q: string, cursor: string | undefined, limit: number): Promise<RemotePage<Lic>> =>
  admApi('GET', '/api/adm/licenses', { query: { q: q || undefined, cursor, limit }, schema: licPage });

function IssueForm({ onIssued }: { onIssued: (l: Lic) => void }) {
  const [from, setFrom] = useState<Lic | null>(null);
  const [f, setF] = useState({ shopName: '', taxId: '', edition: 'onprem' as 'onprem' | 'cloud', type: 'expiring' as 'expiring' | 'lifetime', expiresAt: addDays(todayYmd(), 365), region: '', note: '' });
  const [features, setFeatures] = useState<FeatureKey[]>([...FEATURE_KEYS]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!checkFields({ shopName: requiredMsg(f.shopName, 'ชื่อร้านให้ตรงกับที่ร้านตั้งในโปรแกรม'), taxId: !/^\d{13}$/.test(f.taxId) && 'เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก' })) return;
    setBusy(true);
    setErr('');
    try {
      const body = { ...f, shopName: f.shopName.trim(), expiresAt: f.type === 'lifetime' ? null : f.expiresAt,
        features: f.edition === 'onprem' && features.length < FEATURE_KEYS.length ? features : null };
      const l = await admApi('POST', '/api/adm/licenses', { body, schema: AdmLicense });
      setF({ ...f, shopName: '', taxId: '', note: '' });
      setFrom(null);
      onIssued(l);
    } catch (e) {
      setErr(admErr(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h2>ออก license key</h2>
      <div className="fgrid">
        <label className="f" style={{ gridColumn: '1/-1' }}>ต่ออายุให้ร้านเดิม (ไม่บังคับ)
          <SearchSelect<Lic> value={from?.licenseId ?? null} selected={from} fetchPage={fetchLicensedShops} queryKey={['scg', 'pick-licensed']}
            getId={(l) => l.licenseId} getLabel={(l) => l.shopName} getSub={(l) => `${l.taxId}${l.region ? ` · ${l.region}` : ''} · ${l.licenseId}${l.expiresAt ? ` · หมดอายุ ${th(l.expiresAt)}` : ' · ตลอดชีพ'}`}
            emptyLabel="— ร้านใหม่ (กรอกเอง) —" placeholder="ค้นชื่อร้าน / เลขผู้เสียภาษี / เลขที่ license" testId="lic-from" ariaLabel="ต่ออายุให้ร้านเดิม"
            onChange={(_, l) => {
              setFrom(l);
              if (!l) return;
              setF((x) => ({ ...x, shopName: l.shopName, taxId: l.taxId, region: l.region ?? '', edition: l.edition === 'cloud' ? 'cloud' : 'onprem' }));
              setFeatures(l.features ?? [...FEATURE_KEYS]);
            }} />
        </label>
        <label className="f">รุ่นของร้าน
          <select value={f.edition} onChange={(e) => setF({ ...f, edition: e.target.value as typeof f.edition })} data-testid="lic-edition">
            <option value="onprem">On-premise (ติดตั้งในร้าน)</option><option value="cloud">Cloud</option>
          </select>
        </label>
        <label className="f">ชื่อร้าน (ตรงกับในโปรแกรมของร้าน) *<input type="text" name="shopName" value={f.shopName} onChange={(e) => setF({ ...f, shopName: e.target.value })} data-testid="lic-shop" /></label>
        <label className="f">เลขผู้เสียภาษี *<input type="text" inputMode="numeric" maxLength={13} name="taxId" value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value.replace(/\D/g, '') })} data-testid="lic-tax" /></label>
        <label className="f">ประเภท
          <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as typeof f.type })} data-testid="lic-type">
            <option value="expiring">มีวันหมดอายุ</option><option value="lifetime">ตลอดชีพ</option>
          </select>
        </label>
        {f.type === 'expiring' && <label className="f">หมดอายุ<input type="date" value={f.expiresAt} min={addDays(todayYmd(), 1)} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} data-testid="lic-expires" /></label>}
        <label className="f">ภาค / เขตขาย<select value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })}>{REGIONS.map((r) => <option key={r} value={r}>{r || 'ไม่ระบุ'}</option>)}</select></label>
        <label className="f">หมายเหตุ<input type="text" value={f.note} placeholder="เช่น เลขที่ใบสั่งซื้อ" onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
      </div>
      {f.edition === 'onprem' ? (
        <>
          <h4 className="sec" style={{ marginTop: 12 }}>เมนูที่เปิดให้ร้านนี้ (ฝังอยู่ในคีย์)</h4>
          <FeaturePicker value={features} onChange={setFeatures} />
        </>
      ) : <div className="note small" style={{ marginTop: 10 }}>ร้าน Cloud ตั้งสิทธิ์เมนูที่หน้า "ร้านค้า" ปุ่ม "สิทธิ์เมนู" มีผลทันทีโดยไม่ต้องออกคีย์ใหม่</div>}
      {err && <div className="err" role="alert" style={{ marginTop: 6 }} data-testid="lic-error">{err}</div>}
      <button className="btn pri" style={{ marginTop: 10 }} disabled={busy} onClick={() => void go()} data-testid="lic-issue">ออกคีย์</button>
      <p className="small muted">คีย์ผูกชื่อร้าน + เลขผู้เสียภาษี และเซ็นดิจิทัลด้วยกุญแจของ SCG (เก็บเฉพาะบนเซิร์ฟเวอร์ Cloud) · ร้าน On-premise ใส่คีย์ในหน้า "ระบบและข้อมูลร้าน" ร้าน Cloud ใส่ในหน้า "สัญญาและการยินยอม" · ตลอดชีพใช้ได้จนกว่าจะยกเลิก · เตือนก่อนหมดอายุ 30 วัน · เปลี่ยนเมนูของร้าน On-premise = ออกคีย์ใหม่ให้ร้านใส่แทน</p>
    </div>
  );
}

function KeyModal({ l, fresh, onClose }: { l: Lic; fresh: boolean; onClose: () => void }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(l.key);
      toast('คัดลอกคีย์แล้ว');
    } catch {
      toast('คัดลอกไม่ได้ ให้เลือกข้อความแล้วคัดลอกเอง');
    }
  };
  return (
    <Modal onClose={onClose} label="license key">
      <h3>{fresh ? 'ออกคีย์แล้ว' : 'license key'} · {l.licenseId}</h3>
      <div className="kv"><span>ร้าน</span><span>{l.shopName} · {l.taxId}</span><span>ประเภท</span><span>{l.type === 'lifetime' ? 'ตลอดชีพ' : `หมดอายุ ${l.expiresAt ? th(l.expiresAt) : '-'}`}</span></div>
      <div className="adm-key" data-testid="lic-key">{l.key}</div>
      <div className="act"><button className="btn" onClick={() => void copy()}>คัดลอกคีย์</button><button className="btn pri" onClick={onClose}>ปิด</button></div>
    </Modal>
  );
}

function RevokeModal({ l, onClose, onDone }: { l: Lic; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const go = async () => {
    if (!reason.trim()) return setErr('ใส่เหตุผล');
    try {
      await admApi('POST', `/api/adm/licenses/${encodeURIComponent(l.licenseId)}/revoke`, { body: { reason: reason.trim() }, schema: AdmLicense });
      onDone();
    } catch (e) {
      setErr(admErr(e));
    }
  };
  return (
    <Modal onClose={onClose} label="ยกเลิก license">
      <h3>ยกเลิก license · {l.licenseId}</h3>
      <label className="f">เหตุผล *<input type="text" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      {err && <div className="err">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ไม่ยกเลิก</button><button className="btn bad" onClick={() => void go()}>ยืนยันยกเลิก</button></div>
    </Modal>
  );
}

export function Shares() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const list = useAdmLoadMore(['scg', 'shares'], '/api/adm/sales-shares', AdmShare, { q: dq });
  const [open, setOpen] = useState<z.infer<typeof AdmShare> | null>(null);
  const loading = list.isLoading;
  return (
    <div className="card">
      <h2>สรุปยอดขายที่ร้าน On-premise ส่งให้ SCG</h2>
      <input type="search" style={{ width: '100%', marginBottom: 10 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นชื่อร้าน เลขผู้เสียภาษี หรือเลขที่ license" aria-label="ค้นหา" />
      <div className="tw">
        <table data-testid="shares-table">
          <thead><tr><th>รับเมื่อ</th><th>ร้าน</th><th>license</th><th>ช่วงข้อมูล</th><th className="n">ยอดรวม</th><th /></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={6} /> : list.rows.map((s) => (
              <tr key={s.id}>
                <td className="small">{thTime(s.receivedAt)}</td><td>{s.shopName}<div className="small muted">{s.taxId}</div></td><td className="mono small">{s.licenseId}</td>
                <td className="small">{th(s.from)} – {th(s.to)}</td><td className="n">{fmt(s.total)}</td><td><button className="btn sm" onClick={() => setOpen(s)}>ดูรายละเอียด</button></td>
              </tr>
            ))}
            {!loading && list.data && !list.rows.length && <tr><td colSpan={6} className="empty">ยังไม่มีร้านส่งสรุปยอดขาย</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onMore={() => void list.fetchNextPage()} count={list.rows.length} />
      <p className="small muted">ร้านเลือกส่งเองและกดส่งเอง · มีเฉพาะยอดขายรายวันต่อสินค้า SCG และยอดรวมสินค้าอื่น ไม่มีข้อมูลลูกค้า</p>
      {open && (
        <Modal onClose={() => setOpen(null)} wide label="สรุปยอดขาย">
          <h3>{open.shopName} · {th(open.from)} – {th(open.to)}</h3>
          <div className="tw">
            <table>
              <thead><tr><th>วันที่</th><th>สินค้า SCG</th><th className="n">จำนวน</th><th className="n">มูลค่า</th></tr></thead>
              <tbody>
                {open.payload.days.map((dd) => [
                  ...dd.scg.map((x, i) => <tr key={dd.date + x.sku}><td className="small">{i === 0 ? th(dd.date) : ''}</td><td>{x.name}<div className="small muted mono">{x.sku}</div></td><td className="n">{fq(x.qty)} {x.unit}</td><td className="n">{fmt(x.amount)}</td></tr>),
                  <tr key={`${dd.date}o`}><td className="small">{dd.scg.length ? '' : th(dd.date)}</td><td className="muted">สินค้าอื่นรวม</td><td /><td className="n">{fmt(dd.otherAmount)}</td></tr>,
                ])}
                <tr><td /><td><b>รวม</b></td><td className="n">{fq(open.payload.totals.scgQty)}</td><td className="n"><b>{fmt(open.payload.totals.total)}</b></td></tr>
              </tbody>
            </table>
          </div>
          <div className="act"><button className="btn pri" onClick={() => setOpen(null)}>ปิด</button></div>
        </Modal>
      )}
    </div>
  );
}
