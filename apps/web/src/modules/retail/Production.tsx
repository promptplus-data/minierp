/** M16 production (mockup VIEWS.production / moModal / outModal / bomModal): MO list, BOM versions, per-MO cost report. */
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { RouteLink } from '../../doclink';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bom, Mo, MoReport, MoSuggest, MoSummary, page } from '@erp/contracts';
import { d, moUnitCost, sum, yieldPct } from '@erp/core';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { useCatalog, useWarehouses } from '../../data';
import { fmt, fq, Modal, Pager, Pill, SkeletonRows, th, thTime, useCursorPager, useDebounced, useToast } from '../../ui';
import './retail.css';
import { ErrorBanner } from '../../errors';

const STATUS: Record<Mo['status'], [string, 'ok' | 'warn' | 'mut']> = { wip: ['กำลังผลิต · เบิกแล้ว', 'warn'], closed: ['ผลิตเสร็จ · รับเข้าแล้ว', 'ok'], cancelled: ['ยกเลิก', 'mut'] };
const isNum = (s: string) => /^\d+(\.\d+)?$/.test(s.trim());

export default function Production() {
  const [tab, setTab] = useState<'mo' | 'bom' | 'rep'>('mo');
  return (
    <div className="card">
      <div className="tabs" role="tablist">
        <button className={tab === 'mo' ? 'on' : ''} onClick={() => setTab('mo')}>ใบสั่งผลิต</button>
        <button className={tab === 'bom' ? 'on' : ''} onClick={() => setTab('bom')} data-testid="tab-bom">สูตรการผลิต (BOM)</button>
        <button className={tab === 'rep' ? 'on' : ''} onClick={() => setTab('rep')} data-testid="tab-morep">ต้นทุนผลิตเทียบแผน</button>
      </div>
      {tab === 'mo' ? <MoList /> : tab === 'bom' ? <BomList /> : <MoReportView />}
    </div>
  );
}

// ---------- MO list ----------

function MoList() {
  const { can } = useAuth();
  const manage = can('inv.produce') === 1;
  const see = can('data.cost') === 1;
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<Mo['status'] | ''>('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const pager = useCursorPager(`${status}|${dq}`);
  // /production/:no opens that order (document links from the stock ledger, audit log, lots)
  const { no: routeNo } = useParams();
  const nav = useNavigate();
  const [modal, setModalRaw] = useState<null | { k: 'new' } | { k: 'out' | 'close' | 'view' | 'cancel'; no: string }>(routeNo ? { k: 'view', no: routeNo } : null);
  const setModal = (m: typeof modal) => { setModalRaw(m); if (!m && routeNo) nav('/production', { replace: true }); };
  const list = useQuery({
    queryKey: ['mos', status, dq, pager.cursor],
    queryFn: () => api('GET', '/api/mos', { query: { status, q: dq, limit: 20, cursor: pager.cursor }, schema: page(MoSummary) }),
    placeholderData: keepPreviousData,
  });
  const loading = list.isLoading || (list.isFetching && list.isPlaceholderData);
  const done = (msg: string) => {
    setModal(null);
    void Promise.all(['mos', 'mo', 'stock', 'boms', 'mo-report'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    toast(msg);
  };
  return (
    <>
      <div className="rt-head" style={{ marginTop: 12 }}>
        <p className="small muted" style={{ margin: 0 }}>เบิกวัตถุดิบตามสูตร → ผลิต → บันทึกผลผลิตจริง (ดี / เสีย) ได้หลายครั้ง → ปิดใบสั่งผลิต ระบบรับสินค้าเข้าสต็อกเป็นล็อตใหม่ ทุนต่อชิ้น = (ทุนวัตถุดิบที่ใช้จริงตามล็อต + ค่าแรง/ค่าใช้จ่าย) ÷ จำนวนดี</p>
        <button className="btn pri" disabled={!manage} onClick={() => setModal({ k: 'new' })} data-testid="mo-new">+ สร้างใบสั่งผลิต</button>
      </div>
      <div className="rt-filters">
        <div className="steps">
          {([['', 'ทั้งหมด'], ['wip', 'กำลังผลิต'], ['closed', 'ผลิตเสร็จ'], ['cancelled', 'ยกเลิก']] as const).map(([k, l]) => (
            <span key={k} role="button" tabIndex={0} className={status === k ? 'on' : ''} onClick={() => setStatus(k)} onKeyDown={(e) => { if (e.key === 'Enter') setStatus(k); }}>{l}</span>
          ))}
        </div>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นเลขที่ หรือสินค้าที่ผลิต" aria-label="ค้นหาใบสั่งผลิต" />
      </div>
      {list.isError && <ErrorBanner error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
      <div className="tw">
        <table data-testid="mo-table">
          <thead><tr><th>เลขที่</th><th>วันที่</th><th>สินค้าที่ผลิต</th><th className="n">แผน</th><th>สถานะ</th>{see && <th className="n">ทุนวัตถุดิบ</th>}<th className="n">ได้จริง (ดี / เสีย)</th><th className="n">ผลได้</th>{see && <th className="n">ทุน/ชิ้น</th>}<th>โดย</th><th /></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={see ? 11 : 9} /> : (list.data?.items ?? []).map((m) => (
              <tr key={m.id}>
                <td className="mono"><a href="#" onClick={(e) => { e.preventDefault(); setModal({ k: 'view', no: m.no }); }}>{m.no}</a></td>
                <td>{th(m.date)}</td>
                <td>{m.productName}</td>
                <td className="n">{fq(m.planQty)} {m.unitName}</td>
                <td><Pill k={STATUS[m.status][1]}>{STATUS[m.status][0]}</Pill></td>
                {see && <td className="n">{fmt(m.materialsCost)}</td>}
                <td className="n">{d(m.goodQty).plus(d(m.rejectQty)).gt(0) ? `${fq(m.goodQty)} / ${fq(m.rejectQty)}` : '-'}</td>
                <td className="n">{d(m.goodQty).gt(0) ? `${m.yieldPct}%` : '-'}</td>
                {see && <td className="n">{m.unitCost ? fmt(m.unitCost) : '-'}</td>}
                <td className="small rt-who">{m.createdBy}{m.closedBy && <div className="muted">ปิดโดย {m.closedBy}</div>}</td>
                <td><div className="rt-actions">
                  {m.status === 'wip' && manage && <>
                    <button className="btn sm pri" onClick={() => setModal({ k: 'out', no: m.no })} data-testid={`mo-out-${m.no}`}>บันทึกผลผลิต</button>
                    <button className="btn sm" disabled={!d(m.goodQty).gt(0)} onClick={() => setModal({ k: 'close', no: m.no })} data-testid={`mo-close-${m.no}`}>ปิดรับเข้า</button>
                    {!d(m.goodQty).plus(d(m.rejectQty)).gt(0) && <button className="btn sm bad" onClick={() => setModal({ k: 'cancel', no: m.no })}>ยกเลิก</button>}
                  </>}
                  <button className="btn sm" onClick={() => setModal({ k: 'view', no: m.no })}>ดู / พิมพ์</button>
                </div></td>
              </tr>
            ))}
            {!loading && list.data && !list.data.items.length && <tr><td colSpan={11} className="empty">ยังไม่มีใบสั่งผลิต</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!list.data?.nextCursor} count={list.data?.items.length} loading={list.isFetching} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor ?? null)} />
      {modal?.k === 'new' && <MoModal onClose={() => setModal(null)} onDone={(m) => done(`เปิดใบสั่งผลิต ${m.no} และเบิกวัตถุดิบแล้ว`)} />}
      {modal && modal.k !== 'new' && <MoDetail no={modal.no} mode={modal.k} onClose={() => setModal(null)} onDone={done} />}
    </>
  );
}

/** REQ-M16-02: product + plan qty → BOM suggestion with editable issue qty, stock on hand and FIFO cost. */
function MoModal({ onClose, onDone }: { onClose: () => void; onDone: (m: Mo) => void }) {
  const { can } = useAuth();
  const see = can('data.cost') === 1;
  const whs = useWarehouses();
  const boms = useQuery({ queryKey: ['boms', 'active'], queryFn: () => api('GET', '/api/boms', { query: { limit: 100 }, schema: page(Bom) }) });
  const back = (whs.data ?? []).find((w) => !w.isPos && w.active) ?? whs.data?.[0];
  const [pid, setPid] = useState('');
  const [plan, setPlan] = useState('20');
  const [wh, setWh] = useState('');
  const [out, setOut] = useState('');
  const [iss, setIss] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const productId = pid || boms.data?.items[0]?.productId || '';
  const issueWh = wh || back?.id || '';
  const outWh = out || back?.id || '';
  const dplan = useDebounced(plan.trim(), 250);
  const sug = useQuery({
    queryKey: ['mo-suggest', productId, dplan, issueWh],
    enabled: !!productId && !!issueWh && isNum(dplan) && d(dplan).gt(0),
    queryFn: () => api('POST', '/api/mos/suggest', { body: { productId, planQty: dplan, issueWarehouseId: issueWh }, schema: MoSuggest, silent: true }),
  });
  const lines = (sug.data?.lines ?? []).map((l) => ({ ...l, issue: iss[l.productId] ?? l.stdQty }));
  const short = lines.filter((l) => isNum(l.issue) && d(l.issue).gt(d(l.available)));
  const bad = lines.some((l) => !isNum(l.issue));
  const estMat = see ? sum(lines.map((l) => (l.estCost && d(l.stdQty).gt(0) && isNum(l.issue) ? d(l.estCost).div(d(l.stdQty)).times(d(l.issue)) : d(0)))) : null;
  const labour = see && sug.data?.labourPerUnit ? d(sug.data.labourPerUnit).plus(d(sug.data.overheadPerUnit ?? 0)) : null;

  const go = async () => {
    setBusy(true);
    setErr('');
    try {
      onDone(await api('POST', '/api/mos', {
        body: { productId, planQty: plan.trim(), issueWarehouseId: issueWh, outputWarehouseId: outWh, issues: lines.map((l) => ({ productId: l.productId, qty: l.issue.trim() })), note },
        schema: Mo,
      }));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} wide label="สร้างใบสั่งผลิต">
      <h3>สร้างใบสั่งผลิต · เบิกวัตถุดิบ</h3>
      {boms.data && !boms.data.items.length && <div className="note warn small">ยังไม่มีสูตรการผลิต ตั้งสูตรที่แท็บ "สูตรการผลิต (BOM)" ก่อน</div>}
      <div className="fgrid">
        <label className="f">สินค้าที่จะผลิต<select value={productId} onChange={(e) => { setPid(e.target.value); setIss({}); }} data-testid="mo-product">{(boms.data?.items ?? []).map((b) => <option key={b.id} value={b.productId}>{b.productName} (สูตร v{b.version})</option>)}</select></label>
        <label className="f">จำนวนที่จะผลิต<input type="text" inputMode="decimal" value={plan} onChange={(e) => { setPlan(e.target.value); setIss({}); }} data-testid="mo-plan" /></label>
        <label className="f">เบิกวัตถุดิบจากคลัง<select value={issueWh} onChange={(e) => setWh(e.target.value)}>{(whs.data ?? []).filter((w) => w.active).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        <label className="f">รับสินค้าผลิตเสร็จเข้าคลัง<select value={outWh} onChange={(e) => setOut(e.target.value)}>{(whs.data ?? []).filter((w) => w.active).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
      </div>
      <div className="tw">
        <table>
          <thead><tr><th>วัตถุดิบ</th><th className="n">ตามสูตร</th><th className="n">เบิกจริง</th><th className="n">คงเหลือในคลัง</th>{see && <th className="n">ทุน (FIFO)</th>}</tr></thead>
          <tbody>
            {sug.isLoading ? <SkeletonRows cols={see ? 5 : 4} rows={3} /> : lines.map((l) => (
              <tr key={l.productId}>
                <td>{l.name}</td>
                <td className="n">{fq(l.stdQty)} {l.unitName}</td>
                <td className="n"><input className={`qty${!isNum(l.issue) ? ' bad' : ''}`} type="text" inputMode="decimal" value={l.issue} aria-label={`เบิก ${l.name}`} onChange={(e) => setIss((x) => ({ ...x, [l.productId]: e.target.value }))} /></td>
                <td className="n" style={short.includes(l) ? { color: 'var(--bad)' } : undefined}>{fq(l.available)}</td>
                {see && <td className="n">{l.estCost && isNum(l.issue) && d(l.stdQty).gt(0) ? fmt(d(l.estCost).div(d(l.stdQty)).times(d(l.issue))) : '-'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sug.isError && <ErrorBanner error={sug.error} onRetry={() => void sug.refetch()} retrying={sug.isFetching} />}
      {see && estMat && isNum(plan) && d(plan).gt(0) && (
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="small muted">ค่าแรง/ค่าใช้จ่ายตามสูตร {fmt(labour ?? 0)} ต่อหน่วย (แก้ได้ตอนปิดใบสั่งผลิต)</span>
          <b>ทุนวัตถุดิบที่เบิก ฿{fmt(estMat)} · ประมาณ {fmt(estMat.plus((labour ?? d(0)).times(d(plan))).div(d(plan)))} ต่อหน่วย</b>
        </div>
      )}
      {short.length > 0 && <div className="note bad small">วัตถุดิบไม่พอ: {short.map((x) => x.name).join(', ')} · ลดจำนวนผลิต หรือรับวัตถุดิบเข้าก่อน (สต็อกห้ามติดลบ)</div>}
      <label className="f">หมายเหตุ<input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น ล็อตสำหรับงานหมู่บ้านลานนา" /></label>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={busy || !lines.length || !!short.length || bad} onClick={() => void go()} data-testid="mo-issue">เบิกวัตถุดิบและเริ่มผลิต</button></div>
    </Modal>
  );
}

/** MO detail; also hosts the output / close / cancel actions (REQ-M16-03). */
function MoDetail({ no, mode, onClose, onDone }: { no: string; mode: 'out' | 'close' | 'view' | 'cancel'; onClose: () => void; onDone: (msg: string) => void }) {
  const { can } = useAuth();
  const see = can('data.cost') === 1;
  const mo = useQuery({ queryKey: ['mo', no], queryFn: () => api('GET', `/api/mos/${encodeURIComponent(no)}`, { schema: Mo }) });
  const [good, setGood] = useState('');
  const [rej, setRej] = useState('0');
  const [note, setNote] = useState('');
  const [ret, setRet] = useState<Record<string, string>>({});
  const [labour, setLabour] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const m = mo.data;
  const call = async (path: string, body: unknown, msg: string) => {
    setBusy(true);
    setErr('');
    try {
      await api('POST', `/api/mos/${encodeURIComponent(no)}/${path}`, { body, schema: Mo });
      onDone(msg);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!m) return <Modal onClose={onClose} label="ใบสั่งผลิต"><div className="sk" /><div className="sk" /></Modal>;
  const goodNum = mode === 'out' && isNum(good) ? d(m.goodQty).plus(d(good)) : d(m.goodQty);
  const lab = labour ?? (m.labourPerUnit != null ? d(m.labourPerUnit).plus(d(m.overheadPerUnit ?? 0)).toString() : '0');
  const retCost = see ? sum(m.materials.map((x) => (isNum(ret[x.productId] ?? '') && d(x.issueQty).gt(0) && x.cost ? d(x.cost).div(d(x.issueQty)).times(d(ret[x.productId]!)) : d(0)))) : d(0);
  const used = see && m.materialsCost ? d(m.materialsCost).minus(retCost) : null;
  const unit = used && goodNum.gt(0) && isNum(lab) ? moUnitCost({ materials: used, labour: d(lab).times(goodNum), good: goodNum }) : null;
  return (
    <Modal onClose={onClose} wide label={`ใบสั่งผลิต ${no}`}>
      <div className="print-area">
        <h3>{mode === 'out' ? 'บันทึกผลผลิต' : mode === 'close' ? 'ปิดใบสั่งผลิต · รับสินค้าผลิตเสร็จเข้าสต็อก' : mode === 'cancel' ? 'ยกเลิกใบสั่งผลิต' : m.status === 'closed' ? 'ใบสั่งผลิต / ใบรับสินค้าผลิตเสร็จ' : 'ใบสั่งผลิต / ใบเบิกวัตถุดิบ'} · <span className="mono">{m.no}</span></h3>
        <p className="small muted" style={{ margin: '4px 0 10px' }}><RouteLink to={`/stock-ledger?productId=${encodeURIComponent(m.productId)}`}>{m.productName}</RouteLink> · แผน {fq(m.planQty)} {m.unitName} · สูตร v{m.bomVersion} · เบิกจาก {m.issueWarehouse.name} เมื่อ {th(m.date)} โดย {m.createdBy} · รับเข้า {m.outputWarehouse.name} <Pill k={STATUS[m.status][1]}>{STATUS[m.status][0]}</Pill></p>
        <div className="tw">
          <table className="rt-mt">
            <thead><tr><th>วัตถุดิบ</th><th className="n">ตามสูตร</th><th className="n">เบิก</th><th className="n">คืน</th>{mode === 'close' && <th className="n">คืนที่เหลือ</th>}{see && <th className="n">ทุนที่ใช้</th>}<th>ล็อตที่ใช้</th></tr></thead>
            <tbody>{m.materials.map((x) => (
              <tr key={x.productId}>
                <td>{x.name}</td><td className="n">{fq(x.stdQty)}</td><td className="n">{fq(x.issueQty)} {x.unitName}</td><td className="n">{d(x.returnedQty).gt(0) ? fq(x.returnedQty) : '-'}</td>
                {mode === 'close' && <td className="n"><input className="qty" type="text" inputMode="decimal" placeholder="0" value={ret[x.productId] ?? ''} aria-label={`คืน ${x.name}`} onChange={(e) => setRet((r) => ({ ...r, [x.productId]: e.target.value }))} /></td>}
                {see && <td className="n">{x.cost ? fmt(d(x.cost).minus(d(x.returnedCost ?? 0))) : '-'}</td>}
                <td className="small muted">{x.lots.map((l) => `${th(l.receivedAt.slice(0, 10))} ×${fq(l.qty)}${see && l.unitCost ? ` @${fmt(l.unitCost)}` : ''}`).join(', ') || '-'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {m.outputs.length > 0 && (
          <div className="small" style={{ marginTop: 8 }}>
            <b>บันทึกผลผลิต</b>
            {m.outputs.map((o) => <div key={o.id}>{thTime(o.at)} · ดี {fq(o.good)} เสีย {fq(o.reject)} · {o.by}{o.note ? ` · ${o.note}` : ''}</div>)}
          </div>
        )}
        {m.status === 'closed' && <div className="rt-sum" style={{ marginTop: 10 }}>
          <span className="muted">ผลิตได้ (ดี / เสีย)</span><span>{fq(m.goodQty)} / {fq(m.rejectQty)} · ผลได้ {m.yieldPct}%</span>
          {see && <><span className="muted">ทุนวัตถุดิบที่ใช้</span><span>{fmt(m.materialsCost)}</span><span className="muted">ค่าแรง / ค่าใช้จ่าย</span><span>{fmt(d(m.labourCost ?? 0).plus(d(m.overheadCost ?? 0)))}</span><span style={{ fontWeight: 600 }}>ทุนต่อหน่วยของล็อตนี้</span><span className="big">฿{fmt(m.unitCost)}</span></>}
        </div>}
        {m.cancelReason && <div className="note small">ยกเลิก: {m.cancelReason} · คืนวัตถุดิบเข้าล็อตเดิมแล้ว</div>}
      </div>

      {mode === 'out' && m.status === 'wip' && (
        <>
          <div className="fgrid">
            <label className="f">ผลิตได้ (ดี) *<input type="text" inputMode="decimal" value={good} onChange={(e) => setGood(e.target.value)} placeholder={fq(d(m.planQty).minus(d(m.goodQty)).toString())} data-testid="mo-good" /></label>
            <label className="f">เสีย / ใช้ไม่ได้<input type="text" inputMode="decimal" value={rej} onChange={(e) => setRej(e.target.value)} data-testid="mo-reject" /></label>
            <label className="f">หมายเหตุ<input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น รอบเช้า" /></label>
          </div>
          <div className="note small">รวมแล้วดี {fq(goodNum.toString())} · ผลได้ {yieldPct(goodNum, m.planQty)}% ของแผน · บันทึกได้หลายครั้ง ของเสียไม่เข้าสต็อก ต้นทุนของเสียรวมอยู่ในทุนของชิ้นดี</div>
        </>
      )}
      {mode === 'close' && m.status === 'wip' && (
        <>
          <div className="fgrid">
            <label className="f">ค่าแรง / ค่าใช้จ่ายต่อหน่วย (บาท)<input type="text" inputMode="decimal" value={lab} onChange={(e) => setLabour(e.target.value)} data-testid="mo-labour" /></label>
            <div><div className="small muted">ผลได้</div><b>{fq(m.goodQty)} ดี / {fq(m.rejectQty)} เสีย · {m.yieldPct}%</b></div>
          </div>
          {see && used && <div className="rt-sum"><span className="muted">ทุนวัตถุดิบที่ใช้ (หักที่คืน)</span><span>{fmt(used)}</span><span className="muted">ค่าแรงรวม</span><span>{isNum(lab) ? fmt(d(lab).times(d(m.goodQty))) : '-'}</span><span style={{ fontWeight: 600 }}>ทุนต่อหน่วยของล็อตนี้</span><span className="big" data-testid="mo-unit">฿{unit ? fmt(unit) : '-'}</span></div>}
          <div className="note small">ระบบรับ {fq(m.goodQty)} {m.unitName} เข้า {m.outputWarehouse.name} เป็นล็อต {m.no} · วัตถุดิบที่คืนกลับเข้าคลังที่ทุนเดิมที่เบิก</div>
        </>
      )}
      {mode === 'cancel' && m.status === 'wip' && <label className="f">เหตุผลที่ยกเลิก *<input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="เช่น สั่งผิดสินค้า" /></label>}
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act">
        <button className="btn" onClick={onClose}>{mode === 'view' ? 'ปิด' : 'ไว้ทีหลัง'}</button>
        {mode === 'view' && <button className="btn" onClick={() => window.print()}>พิมพ์</button>}
        {mode === 'out' && m.status === 'wip' && <button className="btn pri" disabled={busy || !(isNum(good) || isNum(rej)) || !d(isNum(good) ? good : 0).plus(d(isNum(rej) ? rej : 0)).gt(0)} onClick={() => void call('outputs', { good: isNum(good) ? good.trim() : '0', reject: isNum(rej) ? rej.trim() : '0', note }, `บันทึกผลผลิต ${no} แล้ว`)} data-testid="mo-out-ok">บันทึกผลผลิต</button>}
        {mode === 'close' && m.status === 'wip' && <button className="btn pri" disabled={busy || !isNum(lab)} onClick={() => void call('close', {
          returns: Object.entries(ret).filter(([, v]) => isNum(v) && d(v).gt(0)).map(([productId, qty]) => ({ productId, qty: qty.trim() })), labourPerUnit: lab.trim(), overheadPerUnit: '0',
        }, `ปิด ${no} รับสินค้าเข้าสต็อกแล้ว`)} data-testid="mo-close-ok">รับสินค้าผลิตเสร็จเข้าสต็อก</button>}
        {mode === 'cancel' && m.status === 'wip' && <button className="btn bad" disabled={busy || !reason.trim()} onClick={() => void call('cancel', { reason: reason.trim() }, `ยกเลิก ${no} แล้ว`)}>ยกเลิกและคืนวัตถุดิบ</button>}
      </div>
    </Modal>
  );
}

// ---------- BOM ----------

function BomList() {
  const { can } = useAuth();
  const manage = can('inv.produce') === 1;
  const see = can('data.cost') === 1;
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const [all, setAll] = useState(false);
  const pager = useCursorPager(`${dq}|${all}`);
  const [edit, setEdit] = useState<Bom | 'new' | null>(null);
  const list = useQuery({
    queryKey: ['boms', dq, all, pager.cursor],
    queryFn: () => api('GET', '/api/boms', { query: { q: dq, all: all || undefined, limit: 20, cursor: pager.cursor }, schema: page(Bom) }),
    placeholderData: keepPreviousData,
  });
  const activate = async (b: Bom) => {
    try {
      await api('POST', `/api/boms/${b.id}/activate`, { schema: Bom });
      void qc.invalidateQueries({ queryKey: ['boms'] });
      toast(`ใช้สูตร v${b.version} ของ ${b.productName} แล้ว`);
    } catch (e) {
      toast(errText(e));
    }
  };
  return (
    <>
      <div className="rt-head" style={{ marginTop: 12 }}>
        <p className="small muted" style={{ margin: 0 }}>สูตรการผลิตต่อ 1 หน่วยหลัก · แก้สูตรแล้วระบบเก็บเป็นเวอร์ชันใหม่ ใช้ได้ครั้งละ 1 เวอร์ชัน ใบสั่งผลิตที่เปิดแล้วใช้สูตรเดิม · สินค้าที่ผลิตขายได้เหมือนสินค้าทั่วไป และตรวจขายต่ำกว่าทุนด้วยทุนจริงของล็อตที่ผลิต</p>
        <button className="btn pri" disabled={!manage} onClick={() => setEdit('new')} data-testid="bom-new">+ ตั้งสูตรสินค้า</button>
      </div>
      <div className="rt-filters">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นสินค้าที่ผลิต" aria-label="ค้นหาสูตร" />
        <label className="row small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> แสดงทุกเวอร์ชัน</label>
      </div>
      <div className="rt-cards">
        {list.isLoading && Array.from({ length: 2 }, (_, i) => <div key={i} className="card"><div className="sk" /><div className="sk" /><div className="sk" /></div>)}
        {(list.data?.items ?? []).map((b) => (
          <div className="card" key={b.id} data-testid={`bom-${b.version}`}>
            <h2 style={{ fontSize: 14 }}>{b.productName} <span className="row" style={{ gap: 6 }}>{b.active ? <Pill k="ok">v{b.version} · ใช้อยู่</Pill> : <Pill k="mut">v{b.version}</Pill>}
              {manage && (b.active ? <button className="btn sm" onClick={() => setEdit(b)}>แก้สูตร</button> : <button className="btn sm" onClick={() => void activate(b)}>ใช้สูตรนี้</button>)}</span></h2>
            <div className="tw">
              <table className="rt-mt">
                <thead><tr><th>วัตถุดิบต่อ 1 {b.unitName}</th><th className="n">ใช้</th>{see && <th className="n">ทุนปัจจุบัน</th>}</tr></thead>
                <tbody>
                  {b.components.map((c) => <tr key={c.productId}><td>{c.name}</td><td className="n">{fq(c.qtyPerUnit)} {c.unitName}</td>{see && <td className="n">{c.unitCost ? fmt(d(c.unitCost).times(d(c.qtyPerUnit))) : '-'}</td>}</tr>)}
                  <tr><td>ค่าแรง / ค่าใช้จ่ายการผลิต</td><td />{see && <td className="n">{fmt(d(b.labourPerUnit).plus(d(b.overheadPerUnit)))}</td>}</tr>
                </tbody>
              </table>
            </div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="small muted">{see && b.stdUnitCost ? `ทุนมาตรฐานต่อหน่วย ${fmt(b.stdUnitCost)} · ` : ''}ราคาขาย {fmt(b.price)}</span>
              <span className="small muted">{b.createdBy} · {th(b.createdAt.slice(0, 10))}</span>
            </div>
          </div>
        ))}
        {list.data && !list.data.items.length && <div className="empty">ยังไม่มีสูตรการผลิต</div>}
      </div>
      <Pager page={pager.page} hasNext={!!list.data?.nextCursor} count={list.data?.items.length} loading={list.isFetching} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor ?? null)} />
      {edit && <BomModal bom={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={(b) => { setEdit(null); void qc.invalidateQueries({ queryKey: ['boms'] }); toast(`บันทึกสูตร ${b.productName} v${b.version} แล้ว`); }} />}
    </>
  );
}

function BomModal({ bom, onClose, onSaved }: { bom: Bom | null; onClose: () => void; onSaved: (b: Bom) => void }) {
  const cat = useCatalog();
  const stock = (cat.data ?? []).filter((p) => p.kind === 'stock' && p.active);
  const [pid, setPid] = useState(bom?.productId ?? '');
  const productId = pid || stock[0]?.id || '';
  const [comps, setComps] = useState<{ productId: string; qty: string }[]>(bom ? bom.components.map((c) => ({ productId: c.productId, qty: c.qtyPerUnit })) : []);
  const [labour, setLabour] = useState(bom ? d(bom.labourPerUnit).plus(d(bom.overheadPerUnit)).toString() : '0');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const mats = stock.filter((p) => p.id !== productId);
  const ok = !!productId && comps.length > 0 && comps.every((c) => isNum(c.qty) && d(c.qty).gt(0)) && isNum(labour);
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      onSaved(await api('POST', '/api/boms', { body: { productId, components: comps.map((c) => ({ productId: c.productId, qtyPerUnit: c.qty.trim() })), labourPerUnit: labour.trim(), overheadPerUnit: '0', note }, schema: Bom }));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const unitOf = (id: string) => cat.byId.get(id)?.units[0]?.name ?? '';
  return (
    <Modal onClose={onClose} label="สูตรการผลิต">
      <h3>สูตรการผลิต{bom ? ` · ${bom.productName} (เวอร์ชันใหม่ต่อจาก v${bom.version})` : ''}</h3>
      {!bom && <label className="f">สินค้าที่ผลิต<select value={productId} onChange={(e) => setPid(e.target.value)} data-testid="bom-product">{stock.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
      <p className="small muted" style={{ margin: 0 }}>ใช้วัตถุดิบเท่าไรต่อ 1 {unitOf(productId)} (หน่วยหลักของวัตถุดิบ)</p>
      <div className="tw">
        <table className="rt-mt">
          <thead><tr><th>วัตถุดิบ</th><th className="n">ใช้ต่อหน่วย</th><th /></tr></thead>
          <tbody>{comps.map((c, i) => (
            <tr key={i}>
              <td><select value={c.productId} aria-label={`วัตถุดิบ ${i + 1}`} onChange={(e) => setComps((x) => x.map((y, j) => (j === i ? { ...y, productId: e.target.value } : y)))}>{mats.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></td>
              <td className="n"><input className="qty" type="text" inputMode="decimal" value={c.qty} aria-label={`ใช้ต่อหน่วย ${i + 1}`} onChange={(e) => setComps((x) => x.map((y, j) => (j === i ? { ...y, qty: e.target.value } : y)))} /> {unitOf(c.productId)}</td>
              <td>{comps.length > 1 && <button className="btn sm bad" aria-label="ลบวัตถุดิบ" onClick={() => setComps((x) => x.filter((_, j) => j !== i))}>✕</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="row"><button className="btn sm" onClick={() => setComps((x) => [...x, { productId: mats.find((p) => !x.some((y) => y.productId === p.id))?.id ?? mats[0]!.id, qty: '1' }])} data-testid="bom-add">+ เพิ่มวัตถุดิบ</button></div>
      <label className="f">ค่าแรง / ค่าใช้จ่ายการผลิตต่อหน่วย (บาท)<input type="text" inputMode="decimal" value={labour} onChange={(e) => setLabour(e.target.value)} /></label>
      <label className="f">หมายเหตุเวอร์ชัน<input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น ลดเหล็กเส้นตามแบบใหม่" /></label>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={!ok || busy} onClick={() => void save()} data-testid="bom-save">บันทึกสูตร</button></div>
    </Modal>
  );
}

// ---------- REQ-M16-04 report ----------

function MoReportView() {
  const { can } = useAuth();
  const see = can('data.cost') === 1;
  const rep = useQuery({ queryKey: ['mo-report'], queryFn: () => api('GET', '/api/mos/report', { schema: MoReport }) });
  return (
    <>
      <p className="small muted" style={{ margin: '12px 0' }}>ต่อใบสั่งผลิต: วัตถุดิบตามสูตรเทียบใช้จริง (เบิก − คืน) ผลได้เทียบแผน และทุนต่อหน่วยจริงเทียบทุนมาตรฐาน (สูตร × ทุนที่เบิกจริง + ค่าแรงตามสูตร)</p>
      <div className="tw">
        <table data-testid="morep-table">
          <thead><tr><th>เลขที่</th><th>สินค้า</th><th className="n">แผน / ดี / เสีย</th><th className="n">ผลได้</th><th>วัตถุดิบ: สูตร → ใช้จริง</th>{see && <><th className="n">ทุนมาตรฐาน/หน่วย</th><th className="n">ทุนจริง/หน่วย</th></>}</tr></thead>
          <tbody>
            {rep.isLoading ? <SkeletonRows cols={see ? 7 : 5} /> : (rep.data?.items ?? []).map((r) => (
              <tr key={r.no}>
                <td className="mono">{r.no}<div className="rt-desc">{th(r.date)} · {STATUS[r.status][0]}</div></td>
                <td>{r.productName}</td>
                <td className="n">{fq(r.planQty)} / {fq(r.goodQty)} / {fq(r.rejectQty)}</td>
                <td className="n">{r.yieldPct}%</td>
                <td className="small">{r.materials.map((x) => <div key={x.name}>{x.name}: {fq(x.stdQty)} → {fq(x.usedQty)}{!d(x.varianceQty).isZero() && <b style={{ color: d(x.varianceQty).gt(0) ? 'var(--bad)' : 'var(--ok)' }}> ({d(x.varianceQty).gt(0) ? '+' : ''}{fq(x.varianceQty)})</b>}</div>)}</td>
                {see && <><td className="n">{fmt(r.stdUnitCost)}</td><td className="n"><b>{fmt(r.unitCost)}</b></td></>}
              </tr>
            ))}
            {rep.data && !rep.data.items.length && <tr><td colSpan={7} className="empty">ยังไม่มีใบสั่งผลิต</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
