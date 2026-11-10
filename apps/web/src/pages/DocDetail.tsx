/** Sales document detail + void with reason (mockup voidModal), PIN approval when the role has 'apv'. */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SalesDoc } from '@erp/contracts';
import { d } from '@erp/core';
import { ApiFail, api, errText } from '../api';
import { useAuth } from '../auth';
import { DOC_TITLE, METHOD_TH, Slip } from '../pos/Receipt';
import { ApprovalModal, fmt, fq, Modal, Pill, ReasonField, reasonInit, reasonText, th, thTime, useToast, type ApprovalInput } from '../ui';
import { ErrorBanner } from '../errors';
import { DocLink, DocLinks } from '../doclink';

export default function DocDetail() {
  const { no = '' } = useParams();
  const { can } = useAuth();
  const [voiding, setVoiding] = useState(false);
  const [slip, setSlip] = useState(false);
  const q = useQuery({ queryKey: ['doc', no], queryFn: () => api('GET', `/api/sales/docs/${encodeURIComponent(no)}`, { schema: SalesDoc }) });
  if (q.isLoading) return <div className="card"><div className="sk" /><div className="sk" /><div className="sk" /></div>;
  if (q.isError || !q.data) return <div className="card"><ErrorBanner error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} /><p><Link to="/sales">‹ กลับไปเอกสารขาย</Link></p></div>;
  const doc = q.data;
  const t = doc.totals;
  const canVoid = !!can('sales.voidDoc') && doc.status === 'active' && doc.type !== 'CN';
  return (
    <>
      <div className="card">
        <h2>
          <span className="row"><Link to="/sales" className="btn sm">‹ กลับ</Link> <span>{DOC_TITLE[doc.type]}</span> <b className="mono" data-testid="doc-no">{doc.no}</b>
            {doc.status === 'void' ? <Pill k="bad">ยกเลิก</Pill> : <Pill k="ok">ปกติ</Pill>}</span>
          <span className="row">
            <button className="btn sm" onClick={() => setSlip(true)}>พิมพ์</button>
            {canVoid && <button className="btn sm bad" onClick={() => setVoiding(true)} data-testid="void">ยกเลิกเอกสาร{can('sales.voidDoc') === 1 ? '' : ' (ขออนุมัติ)'}</button>}
          </span>
        </h2>
        <div className="kv">
          <span>วันที่</span><span>{th(doc.date)}</span>
          <span>ลูกค้า</span><span>{doc.customer.name}{doc.customer.phone ? ` · ${doc.customer.phone}` : ''}</span>
          {doc.ref && <><span>อ้างอิง</span><span className="mono" data-testid="doc-ref">{/* a POS full tax invoice has no B2B page: open it here instead of probing /b2b/inv (404) */}<DocLink no={doc.ref} type={doc.refB2b === false && doc.ref.startsWith('INV') ? 'ABB' : undefined} /></span></>}
          {!!doc.related?.length && <><span>เอกสารต่อเนื่อง</span><span className="mono" data-testid="doc-related">{doc.related.map((x, i) => <span key={x.no}>{i > 0 && ', '}<span style={x.status === 'void' ? { textDecoration: 'line-through' } : undefined}><DocLink no={x.no} type={x.kind} /></span></span>)}</span></>}
          <span>ภาษี</span><span>{doc.vatMode === 'inc' ? 'ราคารวม VAT 7%' : doc.vatMode === 'exc' ? 'ราคาไม่รวม VAT' : 'ร้านไม่จด VAT'}</span>
          <span>ชำระโดย</span><span>{doc.payments.map((p) => `${METHOD_TH[p.method] ?? p.method} ${fmt(p.amount)}`).join(' + ') || '-'}</span>
          {doc.payments.some((p) => p.method === 'credit') && <><span>ค้างชำระ (ลูกหนี้)</span><span data-testid="doc-ar">{d(doc.arBalance ?? '0').gt(0) ? <Pill k="warn">฿{fmt(doc.arBalance ?? '0')}</Pill> : <Pill k="ok">ชำระครบแล้ว</Pill>}</span></>}
          {doc.discReason && <><span>เหตุผลส่วนลด</span><span data-testid="doc-disc-reason">{doc.discReason}</span></>}
          {doc.note && <><span>หมายเหตุ</span><span data-testid="doc-note">{doc.note}</span></>}
        </div>
        {doc.voided && <div className="note bad small" style={{ marginTop: 12 }} data-testid="voided">ยกเลิกเมื่อ {thTime(doc.voided.at)} · เหตุผล: {doc.voided.reason}</div>}
      </div>
      <div className="card">
        <h2>รายการ</h2>
        <div className="tw">
          <table>
            <thead><tr><th>สินค้า</th><th className="n">จำนวน</th><th className="n">ราคา/หน่วย</th><th className="n">ส่วนลด</th><th className="n">สุทธิ</th><th className="n">คืนแล้ว</th>{doc.lines.some((l) => l.cogs != null) && <th className="n">ต้นทุน (FIFO)</th>}</tr></thead>
            <tbody>
              {doc.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td><td className="n">{fq(l.qty)} {l.unitName}</td><td className="n">{fmt(l.unitPrice)}</td>
                  <td className="n">{d(l.discount).gt(0) ? fmt(l.discount) : '-'}</td><td className="n">{fmt(l.net)}</td><td className="n">{d(l.returnedQty).gt(0) ? fq(l.returnedQty) : '-'}</td>
                  {doc.lines.some((x) => x.cogs != null) && <td className="n">{l.cogs != null ? fmt(l.cogs) : '-'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="tot" style={{ maxWidth: 360, marginLeft: 'auto' }}>
          <span className="muted">รวมเป็นเงิน (ก่อนส่วนลด)</span><span>{fmt(t.gross)}</span>
          {d(t.lineDisc).gt(0) && <><span className="muted">ส่วนลดรายการ</span><span>−{fmt(t.lineDisc)}</span></>}
          {d(t.billDisc).gt(0) && <><span className="muted">ส่วนลดท้ายบิล</span><span>−{fmt(t.billDisc)}</span></>}
          {doc.vatMode !== 'none' && <><span className="muted">มูลค่าก่อนภาษี</span><span>{fmt(d(t.base7).plus(d(t.exempt)))}</span><span className="muted">ภาษีมูลค่าเพิ่ม 7%</span><span>{fmt(t.vat)}</span></>}
          <span style={{ fontWeight: 600 }}>จำนวนเงินรวมทั้งสิ้น</span><span className="big">฿{fmt(t.total)}</span>
        </div>
      </div>
      {slip && <Modal onClose={() => setSlip(false)} label="พิมพ์"><h3>พิมพ์ซ้ำ · {doc.no}</h3><Slip doc={doc} /><div className="act"><button className="btn" onClick={() => window.print()}>พิมพ์</button><button className="btn pri" onClick={() => setSlip(false)}>ปิด</button></div></Modal>}
      {voiding && <VoidModal doc={doc} onClose={() => setVoiding(false)} />}
    </>
  );
}

function VoidModal({ doc, onClose }: { doc: SalesDoc; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState(reasonInit('void'));
  const [extra, setExtra] = useState('');
  const [err, setErr] = useState('');
  const [blocked, setBlocked] = useState<string[] | null>(null);
  const [apv, setApv] = useState(false);
  const needPin = can('sales.voidDoc') === 'apv';
  const fx = [
    doc.type !== 'CN' ? 'คืนสต็อกกลับเข้าคลังตามต้นทุนเดิมของบิล' : '',
    doc.vatMode !== 'none' ? 'ใบกำกับภาษีที่ยกเลิก ต้องเก็บต้นฉบับและสำเนาไว้ครบชุด แล้วออกใบใหม่แทน (เลขที่เดิมไม่นำกลับมาใช้)' : '',
    doc.payments.some((p) => p.method === 'cash') ? 'ยอดเงินสดที่ควรมีของกะที่ขายบิลนี้ลดลงตามบิล' : '',
  ].filter(Boolean);

  const text = () => {
    const r = reasonText(reason);
    return r === null ? null : extra.trim() ? `${r} · ${extra.trim()}` : r;
  };
  /** Returns an approval error for the PIN modal, or null when done. */
  const submit = async (a?: ApprovalInput): Promise<string | null> => {
    const r = text();
    if (r === null) {
      setErr('เลือก "อื่น ๆ" แล้ว ต้องพิมพ์เหตุผลก่อน');
      return null;
    }
    try {
      await api('POST', `/api/sales/docs/${encodeURIComponent(doc.no)}/void`, { body: { reason: r, ...(a ?? {}) }, schema: SalesDoc });
      await Promise.all(['doc', 'docs', 'today', 'stock', 'shift'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      toast(`${doc.no} ยกเลิกแล้ว · คืนสต็อกแล้ว`);
      onClose();
      return null;
    } catch (e) {
      if (e instanceof ApiFail && e.detail('approvalError')) return e.message;
      setApv(false);
      if (e instanceof ApiFail && e.code === 'DOWNSTREAM_FIRST' && e.claim()) setBlocked(e.detail<string[]>('docs') ?? []);
      else setErr(errText(e));
      return null;
    }
  };

  if (blocked) {
    return (
      <Modal onClose={onClose} label="ยกเลิกไม่ได้">
        <h3>ยกเลิก {doc.no} ไม่ได้</h3>
        <div className="note bad" data-testid="downstream">มีเอกสารอ้างอิงบิลนี้แล้ว ให้จัดการเอกสารนั้นก่อน: <DocLinks nos={blocked} /> · ถ้าต้องการคืนของเพิ่ม ให้ทำใบลดหนี้ / รับคืนสินค้าแทน</div>
        <div className="act"><button className="btn pri" onClick={onClose}>ตกลง</button></div>
      </Modal>
    );
  }
  if (apv) {
    return <ApprovalModal onClose={() => setApv(false)} onSubmit={submit} label={<p style={{ margin: 0 }}>"ยกเลิกเอกสาร {doc.no} ฿{fmt(doc.totals.total)}"</p>} />;
  }
  return (
    <Modal onClose={onClose} label="ยกเลิกเอกสาร">
      <h3>ยกเลิกเอกสาร {doc.no}</h3>
      <p className="small muted" style={{ margin: 0 }}>ระบบไม่ลบเอกสารทิ้ง แต่ติดสถานะ "ยกเลิก" และเก็บผู้ยกเลิก เวลา และเหตุผลไว้ดูย้อนหลังที่ "ประวัติการทำรายการ"</p>
      <div className="tot">
        <span className="muted">{DOC_TITLE[doc.type]}</span><span>{doc.customer.name}</span>
        <span className="muted">ยอด</span><span>฿{fmt(doc.totals.total)}</span>
        <span className="muted">วันที่</span><span>{th(doc.date)}</span>
      </div>
      {fx.length > 0 && <div className="note small">{fx.map((x) => <div key={x}>• {x}</div>)}</div>}
      <ReasonField kind="void" value={reason} onChange={setReason} testId="void-reason" />
      <label className="f">รายละเอียดเพิ่มเติม<input type="text" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="เช่น คีย์จำนวน 50 เป็น 500" /></label>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act">
        <button className="btn" onClick={onClose}>ไม่ยกเลิก</button>
        <button className="btn bad" data-testid="void-ok" onClick={() => {
          if (text() === null) return setErr('เลือก "อื่น ๆ" แล้ว ต้องพิมพ์เหตุผลก่อน');
          if (needPin) setApv(true);
          else void submit();
        }}>ยืนยันยกเลิก{needPin ? ' (ขออนุมัติ)' : ''}</button>
      </div>
    </Modal>
  );
}
