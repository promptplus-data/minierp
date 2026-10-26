/** M08-06 customer returns: searchable bill picker (not a dropdown), return lines, credit note. */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { DocSummary, SalesDoc, page } from '@erp/contracts';
import { d, sum } from '@erp/core';
import { ApiFail, api, errText } from '../api';
import { useAuth } from '../auth';
import { useShift, useWarehouses } from '../data';
import { Slip } from '../pos/Receipt';
import { ApprovalModal, fmt, fq, Modal, Pager, Pill, ReasonField, reasonInit, reasonText, SkeletonRows, th, useCursorPager, useDebounced, useToast, type ApprovalInput } from '../ui';

export default function Returns() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const pager = useCursorPager('cn');
  const cns = useQuery({
    queryKey: ['docs', 'CN', '', pager.cursor],
    queryFn: () => api('GET', '/api/sales/docs', { query: { type: 'CN', limit: 20, cursor: pager.cursor }, schema: page(DocSummary) }),
  });
  return (
    <>
      <div className="card">
        <h2>รับคืนสินค้าจากลูกค้า / ใบลดหนี้ <button className="btn sm pri" onClick={() => setOpen(true)} disabled={!can('sales.return')} data-testid="new-return">+ รับคืนสินค้า</button></h2>
        <div className="tw">
          <table data-testid="cn-table">
            <thead><tr><th>เลขที่</th><th>วันที่</th><th>ลูกค้า</th><th>สินค้า</th><th className="n">ยอด</th><th>สถานะ</th></tr></thead>
            <tbody>
              {cns.isLoading ? <SkeletonRows cols={6} rows={3} /> : (cns.data?.items ?? []).map((x) => (
                <tr key={x.id}>
                  <td className="mono"><Link to={`/sales/${encodeURIComponent(x.no)}`}>{x.no}</Link></td>
                  <td>{th(x.date)}</td><td>{x.customer.name}</td><td className="small">{x.itemsPreview}</td><td className="n">{fmt(x.total)}</td>
                  <td>{x.status === 'void' ? <Pill k="bad">ยกเลิก</Pill> : <Pill k="ok">ปกติ</Pill>}</td>
                </tr>
              ))}
              {cns.data && !cns.data.items.length && <tr><td colSpan={6} className="empty">ยังไม่มีการรับคืน</td></tr>}
            </tbody>
          </table>
        </div>
        <Pager page={pager.page} hasNext={!!cns.data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(cns.data?.nextCursor ?? null)} />
      </div>
      <div className="card">
        <h2>หลักการ</h2>
        <div className="small">
          • บิลเงินสด / หน้าร้าน → คืนเงินสดหรือโอน (เงินสดหักจากกะที่เปิดอยู่)<br />
          • ร้านจด VAT ออก "ใบลดหนี้" อ้างอิงใบกำกับเดิม · ร้านไม่จด VAT ออก "ใบรับคืนสินค้า / ใบคืนเงิน"<br />
          • สินค้าสภาพดีคืนเข้าคลังที่ต้นทุนเดิมของบิล · สินค้าชำรุดไม่เข้าสต็อกขาย
        </div>
      </div>
      {open && <ReturnModal onClose={() => setOpen(false)} />}
    </>
  );
}

type Days = '7' | '30' | '90' | 'all';
const PERIODS: [Days, string][] = [['7', '7 วัน'], ['30', '30 วัน'], ['90', '90 วัน'], ['all', 'ทั้งหมด']];
const eligiblePage = page(DocSummary);

/** Searchable bill picker: debounced server search (pg_trgm), period filter, cursor "แสดงเพิ่ม", Enter on an exact bill no. */
function BillPicker({ onPick }: { onPick: (no: string) => void }) {
  const [q, setQ] = useState('');
  const [days, setDays] = useState<Days>('30');
  const dq = useDebounced(q.trim(), 250);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const res = useInfiniteQuery({
    queryKey: ['eligible', dq, days],
    queryFn: ({ pageParam }) => api('GET', '/api/returns/eligible', { query: { q: dq, days, limit: 10, cursor: pageParam }, schema: eligiblePage }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const items = res.data?.pages.flatMap((p) => p.items) ?? [];

  const onEnter = async () => {
    const v = q.trim();
    if (!v) return;
    const loaded = items.find((x) => x.no.toLowerCase() === v.toLowerCase());
    if (loaded) return onPick(loaded.no);
    try {
      const r = await api('GET', '/api/returns/eligible', { query: { q: v, days: 'all', limit: 10 }, schema: eligiblePage });
      const exact = r.items.find((x) => x.no.toLowerCase() === v.toLowerCase());
      if (exact) return onPick(exact.no);
      if (r.items.length === 1 && dq === v) return onPick(r.items[0]!.no);
    } catch {
      // keep the list as is; the query below shows the error
    }
  };

  return (
    <div>
      <div className="row" style={{ gap: 8 }}>
        <input ref={input} type="text" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void onEnter(); } }}
          placeholder="ค้นหรือสแกนเลขบิล · ชื่อ/เบอร์ลูกค้า · สินค้า · ยอดเงิน" style={{ flex: 1, minWidth: 220 }} aria-label="ค้นหาบิลขาย" autoComplete="off" data-testid="bill-search" />
        <select value={days} onChange={(e) => setDays(e.target.value as Days)} aria-label="ช่วงเวลา" data-testid="bill-days">
          {PERIODS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </select>
      </div>
      <div style={{ marginTop: 8 }} className={res.isFetching && !res.isFetchingNextPage ? 'pgload' : undefined}>
        {res.isError && <div className="note bad small">{errText(res.error)}</div>}
        {res.isLoading ? <table><tbody><SkeletonRows cols={5} rows={3} /></tbody></table> : items.length ? (
          <div className="tw">
            <table data-testid="bill-results">
              <thead><tr><th>เลขที่บิล</th><th>วันที่</th><th>ลูกค้า</th><th>สินค้า</th><th className="n">ยอด</th><th /></tr></thead>
              <tbody>
                {items.map((x) => (
                  <tr key={x.id} className="click" onClick={() => onPick(x.no)}>
                    <td className="mono">{x.no}</td><td>{th(x.date)}</td>
                    <td>{x.customer.name}{x.customer.phone && <div className="small muted">{x.customer.phone}</div>}</td>
                    <td className="small">{x.itemsPreview}</td><td className="n">{fmt(x.total)}</td>
                    <td><button className="btn sm" onClick={(e) => { e.stopPropagation(); onPick(x.no); }}>เลือก</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !res.isError && (
          <div className="empty">ไม่พบบิลที่ตรงกับคำค้น<br /><span className="small">ลองค้นด้วยเลขบิล ชื่อหรือเบอร์ลูกค้า ชื่อสินค้า หรือยอดเงิน · หรือเปลี่ยนช่วงเวลาเป็น "ทั้งหมด"</span></div>
        )}
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
          <span className="small muted">{items.length ? `แสดง ${items.length} บิล${res.hasNextPage ? ' · พิมพ์เพิ่มเพื่อกรองให้แคบลง' : ''}` : ''}</span>
          {res.hasNextPage && <button className="btn sm" onClick={() => void res.fetchNextPage()} disabled={res.isFetchingNextPage} data-testid="bill-more">แสดงเพิ่ม</button>}
        </div>
      </div>
    </div>
  );
}

function ReturnModal({ onClose }: { onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const whs = useWarehouses();
  const shift = useShift();
  const [src, setSrc] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [cond, setCond] = useState<'good' | 'bad'>('good');
  const [wh, setWh] = useState('');
  const [refund, setRefund] = useState<'cash' | 'transfer'>('cash');
  const [reason, setReason] = useState(reasonInit('ret'));
  const [err, setErr] = useState('');
  const [apv, setApv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SalesDoc | null>(null);
  const doc = useQuery({ queryKey: ['doc', src], enabled: !!src, queryFn: () => api('GET', `/api/sales/docs/${encodeURIComponent(src!)}`, { schema: SalesDoc }) });
  const posWh = whs.data?.find((w) => w.isPos && w.active) ?? whs.data?.[0];
  const whId = wh || posWh?.id || '';
  const needPin = can('sales.return') === 'apv';

  const s = doc.data;
  const sub = s ? sum(s.lines.map((l) => l.net)) : d(0);
  const k = s && sub.gt(0) ? d(1).minus(d(s.totals.billDisc).div(sub)) : d(1);
  const rows = (s?.lines ?? []).map((l) => {
    const max = d(l.qty).minus(d(l.returnedQty));
    const unit = d(l.qty).gt(0) ? d(l.net).times(k).div(d(l.qty)) : d(0);
    return { l, max, unit };
  }).filter((x) => x.max.gt(0));
  const valid = (v: string | undefined) => !!v && /^\d+(\.\d+)?$/.test(v.trim()) && d(v).gt(0);
  const picked = rows.filter((x) => valid(qty[x.l.id]));
  const overMax = picked.some((x) => d(qty[x.l.id]!).gt(x.max));
  const total = sum(picked.map((x) => d(qty[x.l.id]!).times(x.unit))).toDecimalPlaces(2);
  const cashNoShift = refund === 'cash' && !shift.data;

  const pick = (no: string) => { setSrc(no); setQty({}); setErr(''); };

  const submit = async (a?: ApprovalInput): Promise<string | null> => {
    const r = reasonText(reason);
    if (r === null) { setErr('เลือก "อื่น ๆ" แล้ว ต้องพิมพ์เหตุผลก่อน'); return null; }
    setBusy(true);
    try {
      const cn = await api('POST', '/api/returns', {
        body: {
          sourceDocNo: s!.no, lines: picked.map((x) => ({ lineId: x.l.id, qty: qty[x.l.id]!.trim() })), condition: cond,
          ...(cond === 'good' ? { warehouseId: whId } : {}), refund, reason: r, ...(a ? { approval: a } : {}),
        },
        schema: SalesDoc,
      });
      await Promise.all(['docs', 'eligible', 'stock', 'shift', 'doc', 'today'].map((key) => qc.invalidateQueries({ queryKey: [key] })));
      toast(`${cn.no} บันทึกรับคืนแล้ว`);
      setApv(false);
      setDone(cn);
      return null;
    } catch (e) {
      if (e instanceof ApiFail && e.detail('approvalError')) return e.message;
      setApv(false);
      setErr(errText(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    if (!picked.length) return setErr('ใส่จำนวนที่รับคืนอย่างน้อย 1 รายการ');
    if (overMax) return setErr('จำนวนรับคืนเกินที่ขายไปหักที่คืนแล้ว');
    if (reasonText(reason) === null) return setErr('เลือก "อื่น ๆ" แล้ว ต้องพิมพ์เหตุผลก่อน');
    setErr('');
    if (needPin) setApv(true);
    else void submit();
  };

  if (done) {
    return (
      <Modal onClose={onClose} label="รับคืนสำเร็จ">
        <h3>บันทึกรับคืนแล้ว · <span className="mono" data-testid="cn-no">{done.no}</span></h3>
        <Slip doc={done} />
        <div className="act"><button className="btn" onClick={() => window.print()}>พิมพ์</button><button className="btn pri" onClick={onClose}>ปิด</button></div>
      </Modal>
    );
  }
  if (apv && s) return <ApprovalModal onClose={() => setApv(false)} onSubmit={submit} label={<p style={{ margin: 0 }}>"รับคืนสินค้าจาก {s.no} ฿{fmt(total)}"</p>} />;

  return (
    <Modal onClose={onClose} wide label="รับคืนสินค้า">
      <h3>รับคืนสินค้าจากลูกค้า</h3>
      {!src ? <BillPicker onPick={pick} /> : (
        <div className="note picker-sel" data-testid="bill-selected">
          <span>อ้างอิงบิล <b className="mono">{src}</b>{s && <> · {s.customer.name} · {th(s.date)} · ฿{fmt(s.totals.total)}</>}</span>
          <button className="btn sm" onClick={() => setSrc(null)}>เปลี่ยนบิล</button>
        </div>
      )}
      {src && doc.isLoading && <div className="sk" />}
      {src && doc.isError && <div className="note bad small">{errText(doc.error)}</div>}
      {s && (
        <>
          <div className="tw">
            <table data-testid="return-lines">
              <thead><tr><th>สินค้า</th><th className="n">ขายไป</th><th className="n">คืนแล้ว</th><th className="n">ราคาสุทธิ/หน่วย</th><th className="n">รับคืนครั้งนี้</th></tr></thead>
              <tbody>
                {rows.map((x, i) => {
                  const v = qty[x.l.id] ?? '';
                  const bad = v !== '' && (!valid(v) || d(v).gt(x.max));
                  return (
                    <tr key={x.l.id}>
                      <td>{x.l.name}</td><td className="n">{fq(x.l.qty)} {x.l.unitName}</td><td className="n">{fq(x.l.returnedQty)}</td><td className="n">{fmt(x.unit)}</td>
                      <td className="n">
                        <input className={`qty${bad ? ' bad' : ''}`} type="text" inputMode="decimal" placeholder="0" value={v} aria-label={`คืน ${x.l.name}`} data-testid={`rq-${i}`}
                          onChange={(e) => setQty((qs) => ({ ...qs, [x.l.id]: e.target.value }))} />
                        <div className="small muted">สูงสุด {fq(x.max)}</div>
                      </td>
                    </tr>
                  );
                })}
                {!rows.length && <tr><td colSpan={5} className="empty">บิลนี้รับคืนครบแล้ว</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="fgrid">
            <ReasonField kind="ret" value={reason} onChange={setReason} testId="ret-reason" />
            <label className="f">สภาพสินค้า<select value={cond} onChange={(e) => setCond(e.target.value as 'good' | 'bad')}><option value="good">ดี · คืนเข้าคลัง</option><option value="bad">ชำรุด · ไม่คืนเข้าสต็อกขาย</option></select></label>
            {cond === 'good' && <label className="f">คืนเข้าคลัง<select value={whId} onChange={(e) => setWh(e.target.value)}>{(whs.data ?? []).filter((w) => w.active).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
            <label className="f">คืนเงิน<select value={refund} onChange={(e) => setRefund(e.target.value as 'cash' | 'transfer')} data-testid="ret-refund"><option value="cash">เงินสด</option><option value="transfer">โอนเงิน</option></select></label>
          </div>
          {cashNoShift && <div className="note warn small">คืนเงินสดต้องมีกะเปิดอยู่ ไปเปิดกะที่หน้าขายหน้าร้านก่อน หรือเลือกคืนด้วยการโอน</div>}
          <div className="tot">
            <span style={{ fontWeight: 600 }}>รวมคืนเงิน (ประมาณ)</span><span className="big">฿{fmt(total)}</span>
            <span className="small muted">ยอดจริงและ VAT คำนวณโดยเซิร์ฟเวอร์ตอนบันทึก</span><span />
          </div>
        </>
      )}
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act">
        <button className="btn" onClick={onClose}>ยกเลิก</button>
        <button className="btn pri" disabled={!s || !picked.length || busy} onClick={save} data-testid="ret-save">{needPin ? 'บันทึกรับคืน (ขออนุมัติ)' : 'บันทึกรับคืน'}</button>
      </div>
    </Modal>
  );
}
