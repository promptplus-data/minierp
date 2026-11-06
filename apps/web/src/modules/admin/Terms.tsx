/**
 * M02 terms of use and consent (BR-15): read and sign (owner only, every required consent, signer name), the signed
 * copy as a printable A4 page (save as PDF), version history; on cloud also the SCG support-access consent (M14-05).
 * The legal text is a placeholder until OQ-04 (PDPA) is answered.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { SupportGrant, TermsStatus, type TermsAcceptance } from '@erp/contracts';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { IS_CLOUD } from '../../cloud';
import { useMeta } from '../../data';
import { Pill, thTime, useToast } from '../../ui';
import { admErr, usePrintA4 } from './common';
import { ErrorBanner } from '../../errors';

export const useTerms = () => {
  const { user } = useAuth();
  return useQuery({ queryKey: ['terms', user?.id], queryFn: () => api('GET', '/api/terms', { schema: TermsStatus }), staleTime: 60_000, enabled: !!user });
};

/** The sign form; `gate` = shown instead of every screen until the owner signs. */
export function TermsSign({ st, gate }: { st: TermsStatus; gate?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const [consents, setConsents] = useState<Record<string, boolean>>({});
  const [name, setName] = useState(gate ? user?.name ?? '' : '');
  const [title, setTitle] = useState('เจ้าของกิจการ');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const missing = st.current.consents.filter((c) => c.required && !consents[c.id]);
  const sign = async () => {
    if (missing.length) return setErr('ต้องติ๊กยินยอมทุกข้อที่บังคับ');
    if (!name.trim()) return setErr('กรอกชื่อผู้มีอำนาจลงนาม');
    setBusy(true);
    setErr('');
    try {
      const out = await api('POST', '/api/terms/accept', { body: { version: st.current.version, signerName: name.trim(), signerTitle: title.trim(), consents }, schema: TermsStatus });
      qc.setQueryData(['terms', user?.id], out);
      toast('ลงนามสัญญาเรียบร้อย ใช้งานระบบได้แล้ว');
    } catch (e) {
      setErr(admErr(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" data-testid="terms-sign">
      <h2>{st.current.title} <span className="row"><Pill k="warn">ยังไม่ได้ลงนาม</Pill><span className="small muted mono">v{st.current.version}</span></span></h2>
      {gate && <div className="note warn small" style={{ marginBottom: 10 }}>ร้านนี้ต้องให้เจ้าของร้านอ่านและลงนามสัญญาการใช้งานก่อน จึงใช้เมนูอื่นได้ (BR-15)</div>}
      <div className="adm-terms">{st.current.body.map((p) => <p key={p}>{p}</p>)}{st.current.placeholder && <p className="muted"><i>(ข้อความรอฝ่ายกฎหมายร่าง · OQ-04)</i></p>}</div>
      {st.canAccept ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          {st.current.consents.map((c) => (
            <label key={c.id} className="adm-check">
              <input type="checkbox" checked={!!consents[c.id]} onChange={(e) => setConsents({ ...consents, [c.id]: e.target.checked })} data-testid={`consent-${c.id}`} />
              <span>{c.label} {c.required ? <b>(จำเป็น)</b> : <span className="muted">(เลือกได้)</span>}</span>
            </label>
          ))}
          <div className="fgrid">
            <label className="f">ชื่อผู้มีอำนาจลงนาม *<input type="text" value={name} onChange={(e) => setName(e.target.value)} data-testid="terms-signer" /></label>
            <label className="f">ตำแหน่ง<input type="text" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          </div>
          <p className="small muted" style={{ margin: 0 }}>ระบบบันทึกชื่อผู้ลงนาม เวลา IP และเวอร์ชันสัญญา และพิมพ์ฉบับที่ลงนามเป็น PDF ได้จากหน้านี้ตลอดเวลา</p>
          {err && <div className="err" role="alert">{err}</div>}
          <div><button className="btn pri" disabled={busy} onClick={() => void sign()} data-testid="terms-accept">ลงนามและยอมรับ</button></div>
        </div>
      ) : (
        <div className="note small" style={{ marginTop: 12 }} data-testid="terms-ask-owner">สัญญาต้องให้เจ้าของร้าน (ผู้มีอำนาจลงนาม) เข้าระบบมาลงนาม แจ้งเจ้าของร้านเพื่อเริ่มใช้งาน</div>
      )}
    </div>
  );
}

export default function Terms() {
  const st = useTerms();
  if (st.isLoading) return <div className="card"><div className="sk" /><div className="sk" /></div>;
  if (st.isError || !st.data) return <div className="card"><ErrorBanner error={st.error} onRetry={() => void st.refetch()} retrying={st.isFetching} /></div>;
  const s = st.data;
  const acc = s.acceptance;
  return (
    <>
      {acc ? <Signed st={s} acc={acc} /> : <TermsSign st={s} />}
      <div className="card">
        <h2>ประวัติการลงนาม</h2>
        <div className="tw">
          <table data-testid="terms-history">
            <thead><tr><th>เวลา</th><th>เวอร์ชัน</th><th>ผู้ลงนาม</th><th>ยินยอม</th><th>บันทึกโดย</th><th>IP</th></tr></thead>
            <tbody>
              {s.history.map((h) => (
                <tr key={h.version + h.acceptedAt}>
                  <td className="small mono">{thTime(h.acceptedAt)}</td><td className="mono small">v{h.version}</td><td>{h.signerName}<div className="small muted">{h.signerTitle}</div></td>
                  <td className="small">{s.current.consents.map((c) => `${h.consents[c.id] ? '✓' : '✗'} ${c.label.split(' ').slice(0, 3).join(' ')}`).join(' · ')}</td>
                  <td className="small">{h.acceptedBy}</td><td className="small mono">{h.ip ?? '-'}</td>
                </tr>
              ))}
              {!s.history.length && <tr><td colSpan={6} className="empty">ยังไม่มีการลงนาม {s.required ? '' : '(ร้านนี้ไม่ได้ถูกกำหนดให้ต้องลงนาม)'}</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="small muted">เมื่อ SCG เผยแพร่สัญญาเวอร์ชันใหม่ ผู้มีอำนาจต้องลงนามอีกครั้งก่อนใช้งานต่อ · ทุกเวอร์ชันเก็บไว้ในประวัติ</p>
      </div>
      {IS_CLOUD && <SupportAccess />}
    </>
  );
}

function Signed({ st, acc }: { st: TermsStatus; acc: TermsAcceptance }) {
  return (
    <div className="card" data-testid="terms-signed">
      <h2>{st.current.title} <span className="row"><Pill k="ok">ลงนามแล้ว</Pill><Link className="btn sm" to="/terms/signed" data-testid="terms-pdf">ดาวน์โหลด PDF ที่ลงนามแล้ว</Link></span></h2>
      <div className="kv">
        <span>เวอร์ชัน</span><span className="mono">v{acc.version}</span>
        <span>ผู้ลงนาม</span><span>{acc.signerName}{acc.signerTitle ? ` (${acc.signerTitle})` : ''}</span>
        <span>เวลา</span><span>{thTime(acc.acceptedAt)} · IP {acc.ip ?? '-'}</span>
        <span>บันทึกโดยผู้ใช้</span><span>{acc.acceptedBy}</span>
        {st.current.consents.map((c) => [<span key={`${c.id}l`}>{c.label}</span>, <span key={`${c.id}v`}>{acc.consents[c.id] ? <Pill k="ok">ยินยอม</Pill> : <Pill k="mut">ไม่ยินยอม</Pill>}</span>])}
      </div>
    </div>
  );
}

/** REQ-M02-02 the signed copy, one A4 page (print → save as PDF). */
export function TermsSigned() {
  usePrintA4();
  const st = useTerms();
  const meta = useMeta();
  const acc = st.data?.acceptance;
  return (
    <div className="card">
      <h2 className="no-print">สัญญาที่ลงนามแล้ว <span className="row"><Link className="btn sm" to="/terms">‹ กลับ</Link><button className="btn sm pri" disabled={!acc} onClick={() => window.print()}>พิมพ์ / บันทึก PDF</button></span></h2>
      {st.isLoading && <div className="sk" />}
      {st.data && !acc && <div className="empty">ยังไม่ได้ลงนามสัญญาเวอร์ชันปัจจุบัน</div>}
      {st.data && acc && (
        <div className="tw">
          <div className="paper" data-testid="terms-paper">
            <div className="ph">
              <div><b style={{ fontSize: 15 }}>{meta.data?.shop.name}</b><div>เลขประจำตัวผู้เสียภาษี {meta.data?.shop.taxId || '-'}</div></div>
              <div style={{ textAlign: 'right' }}><h4>{st.data.current.title}</h4><div>เวอร์ชัน <b>v{acc.version}</b></div></div>
            </div>
            {st.data.current.body.map((p) => <p key={p}>{p}</p>)}
            <table style={{ marginTop: 10 }}>
              <thead><tr><th>การยินยอม</th><th>ผล</th></tr></thead>
              <tbody>{st.data.current.consents.map((c) => <tr key={c.id}><td>{c.label}{c.required ? ' (จำเป็น)' : ''}</td><td>{acc.consents[c.id] ? 'ยินยอม' : 'ไม่ยินยอม'}</td></tr>)}</tbody>
            </table>
            <div className="sig">
              <div>{acc.signerName}<br /><span className="pm">{acc.signerTitle || 'ผู้มีอำนาจลงนาม'} · ลงนามอิเล็กทรอนิกส์ {thTime(acc.acceptedAt)} · IP {acc.ip ?? '-'}</span></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** REQ-M14-05 (cloud): the owner allows SCG support to view the shop read-only for N days; every view is logged. */
function SupportAccess() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const grants = useQuery({ queryKey: ['support-grants'], queryFn: () => api('GET', '/api/support-grants', { schema: z.object({ items: z.array(SupportGrant) }) }), enabled: user?.role === 'owner' });
  const [days, setDays] = useState(3);
  const [note, setNote] = useState('');
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      void qc.invalidateQueries({ queryKey: ['support-grants'] });
    } catch (e) {
      toast(admErr(e));
    }
  };
  if (user?.role !== 'owner') return null;
  return (
    <div className="card">
      <h2>อนุญาตให้ทีม SCG เข้าดูร้าน (support)</h2>
      <p className="small muted" style={{ marginTop: 0 }}>ทีม SCG เห็นข้อมูลร้านแบบอ่านอย่างเดียวเฉพาะช่วงที่อนุญาต และทุกการเข้าดูถูกบันทึกในประวัติการทำรายการของร้าน</p>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="f">จำนวนวัน<select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[1, 3, 7, 14, 30].map((n) => <option key={n} value={n}>{n} วัน</option>)}</select></label>
        <label className="f" style={{ flex: 1, minWidth: 200 }}>หมายเหตุ<input type="text" value={note} placeholder="เช่น ให้ช่วยดูยอดสต็อกไม่ตรง" onChange={(e) => setNote(e.target.value)} /></label>
        <button className="btn pri" style={{ alignSelf: 'flex-end' }} onClick={() => void act(() => api('POST', '/api/support-grants', { body: { days, note } }), `อนุญาตให้ SCG เข้าดู ${days} วันแล้ว`)}>อนุญาต</button>
      </div>
      <div className="tw">
        <table>
          <thead><tr><th>อนุญาตเมื่อ</th><th>โดย</th><th>หมดอายุ</th><th>หมายเหตุ</th><th>สถานะ</th><th /></tr></thead>
          <tbody>
            {(grants.data?.items ?? []).map((g) => (
              <tr key={g.id}>
                <td className="small">{thTime(g.createdAt)}</td><td className="small">{g.grantedBy}</td><td className="small">{thTime(g.expiresAt)}</td><td className="small">{g.note}</td>
                <td>{g.active ? <Pill k="ok">ใช้งานอยู่</Pill> : <Pill k="mut">{g.revokedAt ? 'ยกเลิกแล้ว' : 'หมดอายุ'}</Pill>}</td>
                <td>{g.active && <button className="btn sm bad" onClick={() => void act(() => api('POST', `/api/support-grants/${g.id}/revoke`, { body: {} }), 'ยกเลิกการอนุญาตแล้ว')}>ยกเลิก</button>}</td>
              </tr>
            ))}
            {grants.data && !grants.data.items.length && <tr><td colSpan={6} className="empty">ยังไม่เคยอนุญาต</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
