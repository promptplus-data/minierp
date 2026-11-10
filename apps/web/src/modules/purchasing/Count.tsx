/**
 * M06 "นับสต็อก" (REQ-M06-05/06, BR-09): open a round per warehouse (optionally one category), scan or type counts
 * (several people at once), the system quantity stays hidden while counting, submit → variances become one
 * adjustment request. The owner / manager approves it line by line (here or on the stock page): approve some lines,
 * reject some, send others back to recount (สั่งนับใหม่) without rejecting the round (REQ-M06-06).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AdjustRequest, StockCount, StockCountSummary, StockDoc, page } from '@erp/contracts';
import { z } from 'zod';
import { d } from '@erp/core';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { useCatalog, useAllWarehouses } from '../../data';
import { fq, Modal, Pill, SkeletonRows, thTime, useToast } from '../../ui';
import { LoadMore, useLoadMore } from '../../ui/lists';
import { DecideModal } from '../../stock/Stock';
import '../../stock/stock.css';
import { DocLink } from '../../doclink';
import './purchasing.css';

const STATUS = { counting: ['กำลังนับ', 'warn'], submitted: ['ส่งผลแล้ว', 'ok'], cancelled: ['ยกเลิก', 'mut'] } as const;
type Summary = z.infer<typeof StockCountSummary>;
const statusOf = (c: Pick<Summary, 'status' | 'review' | 'round'>): [string, 'warn' | 'ok' | 'mut' | 'acc'] =>
  c.status === 'submitted' ? (c.review > 0 ? ['รออนุมัติ', 'warn'] : ['ปิดแล้ว', 'ok']) : c.status === 'counting' && c.round > 1 ? ['นับใหม่', 'acc'] : [...STATUS[c.status]];
type LineState = StockCount['items'][number]['state'];
const LINE_ST: Record<LineState, [string, 'warn' | 'ok' | 'mut' | 'acc' | 'bad']> = {
  counting: ['กำลังนับ', 'acc'], review: ['รออนุมัติ', 'warn'], approved: ['อนุมัติปรับยอด', 'ok'], rejected: ['ไม่ปรับ', 'mut'], done: ['ตรง / ปิด', 'mut'],
};

export default function Count() {
  const { can } = useAuth();
  const whs = useAllWarehouses();
  const [open, setOpen] = useState<string | null>(null);
  const [start, setStart] = useState(false);
  // ?no=CNT… (links from the ledger, audit log and adjust requests) opens that round
  const [sp, setSp] = useSearchParams();
  const wantNo = sp.get('no');
  const byNo = useQuery({
    queryKey: ['pu', 'count-by-no', wantNo], enabled: !!wantNo,
    queryFn: async () => (await api('GET', '/api/stock-counts', { query: { q: wantNo ?? '' }, schema: page(StockCountSummary) })).items.find((c) => c.no === wantNo)?.id ?? null,
  });
  useEffect(() => { if (byNo.data) { setOpen(byNo.data); setSp({}, { replace: true }); } }, [byNo.data, setSp]);
  const list = useLoadMore<Summary>(['pu', 'counts', 'list'], '/api/stock-counts', StockCountSummary, {}, 20);
  const loading = list.isLoading;
  const wName = (id: string) => whs.data?.find((w) => w.id === id)?.name ?? '';
  if (open) return <CountSheet id={open} onBack={() => setOpen(null)} />;
  return (
    <div className="card">
      <h2><span>รอบนับสต็อก</span>{can('inv.count') === 1 && <button className="btn sm pri" onClick={() => setStart(true)} data-testid="btn-open-count">+ เปิดรอบนับ</button>}</h2>
      <div className="tw">
        <table data-testid="count-list">
          <thead><tr><th>เลขที่</th><th>คลัง</th><th>หมวด</th><th>สถานะ</th><th className="n">นับแล้ว</th><th>เปิดโดย</th><th>ผลต่าง</th><th /></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={8} rows={3} /> : list.rows.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.no}{c.note && <div className="small muted">{c.note}</div>}</td><td>{wName(c.warehouseId)}</td><td>{c.category ?? 'ทั้งคลัง'}</td>
                <td><Pill k={statusOf(c)[1]}>{statusOf(c)[0]}</Pill>{c.round > 1 && <div className="small muted">รอบนับใหม่ {c.round - 1}</div>}</td><td className="n">{c.counted} / {c.lines}</td>
                <td className="small">{c.openedBy}<div className="muted">{thTime(c.openedAt)}</div></td>
                <td className="mono small">{c.adjustRequestNo ? <DocLink no={c.adjustRequestNo} type="RQ" /> : c.status === 'submitted' ? 'ตรงทุกรายการ' : '-'}</td>
                <td><button className="btn sm" onClick={() => setOpen(c.id)} data-testid={`count-open-${c.no}`}>{c.status === 'counting' ? 'นับต่อ' : 'ดูผล'}</button></td>
              </tr>
            ))}
            {!loading && !list.rows.length && <tr><td colSpan={8} className="empty">ยังไม่มีรอบนับ</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onMore={() => void list.fetchNextPage()} count={list.rows.length} testId="count-more" />
      <p className="small muted" style={{ margin: '8px 0 0' }}>ระหว่างนับระบบซ่อนยอดตามระบบ (BR-09) · ผลต่างคิดเทียบยอด ณ เวลาเปิดรอบ และหักการขาย / รับเข้าระหว่างนับให้แล้ว · ผลต่างทุกรายการต้องให้เจ้าของร้านหรือผู้จัดการอนุมัติก่อนปรับสต็อก · อนุมัติบางรายการได้ และสั่งนับใหม่เฉพาะรายการได้โดยไม่ต้องยกเลิกทั้งรอบ</p>
      {start && <OpenModal onClose={() => setStart(false)} onOpened={(id) => { setStart(false); setOpen(id); }} />}
    </div>
  );
}

function OpenModal({ onClose, onOpened }: { onClose: () => void; onOpened: (id: string) => void }) {
  const whs = useAllWarehouses();
  const cat = useCatalog();
  const qc = useQueryClient();
  const active = (whs.data ?? []).filter((w) => w.active);
  const cats = useMemo(() => [...new Set((cat.data ?? []).filter((p) => p.kind === 'stock').map((p) => p.category))].filter(Boolean).sort(), [cat.data]);
  const [wh, setWh] = useState('');
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const whId = wh || active[0]?.id || '';
  const go = async () => {
    try {
      const r = await api('POST', '/api/stock-counts', { body: { warehouseId: whId, ...(category ? { category } : {}), ...(note.trim() ? { note: note.trim() } : {}) }, schema: StockCount });
      await qc.invalidateQueries({ queryKey: ['pu', 'counts'] });
      onOpened(r.id);
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <Modal onClose={onClose} label="เปิดรอบนับ">
      <h3>เปิดรอบนับสต็อก</h3>
      <div className="fgrid">
        <label className="f">คลัง<select value={whId} onChange={(e) => setWh(e.target.value)} data-testid="count-wh">{active.map((w) => <option key={w.id} value={w.id}>{w.name}{w.kind === 'damaged' ? ' (ของเสีย)' : ''}</option>)}</select></label>
        <label className="f">นับเฉพาะหมวด<select value={category} onChange={(e) => setCategory(e.target.value)} data-testid="count-cat"><option value="">ทั้งคลัง</option>{cats.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="f">หมายเหตุ<input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="ไม่บังคับ" data-testid="count-note" /></label>
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" onClick={() => void go()} data-testid="count-start">เปิดรอบนับ</button></div>
    </Modal>
  );
}

function CountSheet({ id, onBack }: { id: string; onBack: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const whs = useAllWarehouses();
  const [show, setShow] = useState(false);
  const [scan, setScan] = useState('');
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [deciding, setDeciding] = useState<z.infer<typeof AdjustRequest> | null>(null);
  const [busy, setBusy] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);
  const key = ['pu', 'count', id, show];
  const c = useQuery({ queryKey: key, queryFn: () => api('GET', `/api/stock-counts/${id}`, { query: { showSystem: show ? 'true' : undefined }, schema: StockCount }) });
  const x = c.data;
  const counting = x?.status === 'counting';
  const canCount = can('inv.count') === 1 && counting;
  const canApprove = can('inv.adjApprove') === 1;
  // สั่งนับใหม่: while counting, counted lines (counter or approver); once submitted, lines not approved yet (approver).
  const recountable = (st: LineState, counted: boolean) => (counting ? st === 'counting' && counted && (canCount || canApprove) : x?.status === 'submitted' && canApprove && ['review', 'done', 'rejected'].includes(st));
  const refresh = async () => {
    setSel(new Set());
    await Promise.all([c.refetch(), qc.invalidateQueries({ queryKey: ['pu', 'counts'] }), qc.invalidateQueries({ queryKey: ['adjust'] }), qc.invalidateQueries({ queryKey: ['stock'] })]);
  };
  const recount = async () => {
    setBusy(true);
    setErr('');
    try {
      await api('POST', `/api/stock-counts/${id}/recount`, { body: { productIds: [...sel] }, schema: StockCount });
      toast(`สั่งนับใหม่ ${sel.size} รายการแล้ว`);
      await refresh();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const openDecide = async () => {
    if (!x?.adjustRequestNo) return;
    try {
      const r = await api('GET', '/api/stock/adjust-requests', { query: { q: x.adjustRequestNo, limit: 5 }, schema: page(AdjustRequest) });
      const a = r.items.find((i) => i.no === x.adjustRequestNo && i.status === 'pending');
      if (a) setDeciding(a);
      else setErr('คำขอปรับยอดนี้ตัดสินแล้ว');
    } catch (e) {
      setErr(errText(e));
    }
  };
  const decide = async (b: { approve: string[]; reject: string[]; recount: string[]; note?: string }) => {
    if (!deciding) return;
    setBusy(true);
    try {
      const r = await api('POST', `/api/stock/adjust-requests/${deciding.id}/decide`, { body: b, schema: z.object({ request: AdjustRequest, doc: StockDoc.nullable() }) });
      toast(r.doc ? `อนุมัติแล้ว · ปรับสต็อก ${r.doc.no}${b.recount.length ? ` · สั่งนับใหม่ ${b.recount.length} รายการ` : ''}` : b.recount.length ? `สั่งนับใหม่ ${b.recount.length} รายการ` : 'ไม่อนุมัติแล้ว');
      setDeciding(null);
      await refresh();
    } catch (e) {
      setDeciding(null);
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const entry = async (productId: string, qty: string, mode: 'set' | 'add') => {
    setErr('');
    try {
      await api('POST', `/api/stock-counts/${id}/entries`, { body: { productId, qty, mode } });
      await c.refetch();
      return true;
    } catch (e) {
      setErr(errText(e));
      return false;
    }
  };
  const onScan = async () => {
    const code = scan.trim();
    if (!code || !x) return;
    const it = x.items.find((i) => i.barcode === code || i.sku.toLowerCase() === code.toLowerCase());
    if (!it) { toast('ไม่พบบาร์โค้ดนี้ในรอบนับ'); return; }
    if (await entry(it.productId, '1', 'add')) toast(`${it.name} นับได้ ${fq(d(it.countedQty ?? 0).plus(1))}`);
    setScan('');
    scanRef.current?.focus();
  };
  const submit = async () => {
    if (!window.confirm('ปิดรอบนับและส่งผลต่างให้เจ้าของร้านอนุมัติ?')) return;
    try {
      const r = await api('POST', `/api/stock-counts/${id}/submit`, { schema: StockCount });
      qc.setQueryData(key, r);
      setSel(new Set());
      await qc.invalidateQueries({ queryKey: ['pu', 'counts'] });
      await qc.invalidateQueries({ queryKey: ['adjust'] });
      toast(r.review > 0 ? `ส่งผลต่างแล้ว ${r.adjustRequestNo} รออนุมัติ` : 'นับตรงทุกรายการ');
    } catch (e) {
      setErr(errText(e));
    }
  };
  const cancel = async () => {
    if (!window.confirm('ยกเลิกรอบนับนี้?')) return;
    try {
      await api('POST', `/api/stock-counts/${id}/cancel`);
      await qc.invalidateQueries({ queryKey: ['pu', 'counts'] });
      onBack();
    } catch (e) {
      setErr(errText(e));
    }
  };
  const items = (x?.items ?? []).filter((i) => !filter || `${i.sku} ${i.name}`.toLowerCase().includes(filter.toLowerCase()));
  const sys = x && !x.systemHidden;
  return (
    <div className="card">
      <h2>
        <span className="row"><button className="btn sm" onClick={onBack}>‹ กลับ</button> นับสต็อก {x?.no ?? ''} {x && <Pill k={statusOf(x)[1]}>{statusOf(x)[0]}</Pill>}{x && x.round > 1 && <span className="small muted">รอบนับใหม่ {x.round - 1}</span>}</span>
        <span className="row small">
          {x && <span className="muted">{whs.data?.find((w) => w.id === x.warehouseId)?.name} · {x.category ?? 'ทั้งคลัง'} · นับแล้ว {x.counted}/{x.lines}</span>}
          {counting && <label className="row"><input type="checkbox" checked={!show} disabled={can('inv.seeSys') !== 1} onChange={(e) => setShow(!e.target.checked)} data-testid="count-hide" /> ซ่อนยอดตามระบบระหว่างนับ</label>}
        </span>
      </h2>
      {canCount && (
        <div className="pu-count-scan">
          <input ref={scanRef} type="text" placeholder="สแกนบาร์โค้ด หรือพิมพ์รหัสสินค้า เพื่อนับเพิ่มทีละ 1" value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void onScan(); }} aria-label="สแกนบาร์โค้ด" data-testid="count-scan" />
        </div>
      )}
      {x?.note && <div className="note small" style={{ marginBottom: 8 }}>หมายเหตุ: {x.note}</div>}
      <input type="search" placeholder="กรองรายการ" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="กรองรายการนับ" style={{ width: '100%', marginBottom: 10 }} />
      {err && <div className="err" role="alert">{err}</div>}
      <div className="tw">
        <table data-testid="count-sheet">
          <thead><tr><th aria-label="เลือก" />{/* recount selection */}<th>สินค้า</th><th>หน่วย</th>{sys && <><th className="n">ตามระบบ</th><th className="n">ขาย/รับระหว่างนับ</th></>}<th className="n">นับได้</th>{sys && <th className="n">ผลต่าง</th>}<th>สถานะ</th><th>ผู้นับ</th></tr></thead>
          <tbody>
            {c.isLoading ? <SkeletonRows cols={7} rows={6} /> : items.map((i) => (
              <tr key={i.productId} data-state={i.state}>
                <td>{recountable(i.state, i.countedQty != null) && (
                  <input type="checkbox" checked={sel.has(i.productId)} aria-label={`เลือก ${i.name} เพื่อสั่งนับใหม่`} data-testid={`count-sel-${i.sku}`}
                    onChange={(e) => setSel((s0) => { const n = new Set(s0); if (e.target.checked) n.add(i.productId); else n.delete(i.productId); return n; })} />
                )}</td>
                <td>{i.name}<div className="small muted mono">{i.sku}</div></td>
                <td>{i.unitName}</td>
                {sys && <><td className="n">{fq(i.systemQty)}</td><td className="n">{i.movedQty && !d(i.movedQty).isZero() ? fq(i.movedQty) : '-'}</td></>}
                <td className="n">{canCount && i.state === 'counting' ? (
                  <input key={`${i.productId}:${i.countedQty ?? ''}`} className="pu-qty-in" type="text" inputMode="decimal" placeholder="-" defaultValue={i.countedQty ?? ''} aria-label={`นับได้ ${i.name}`}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== (i.countedQty ?? '') && /^\d+(\.\d+)?$/.test(v)) void entry(i.productId, v, 'set'); }} data-testid={`count-q-${i.sku}`} />
                ) : (i.countedQty != null ? fq(i.countedQty) : <span className="muted">ยังไม่นับ</span>)}
                {i.prevCountedQty != null && <div className="small muted">นับครั้งก่อน {fq(i.prevCountedQty)}</div>}</td>
                {sys && <td className="n">{i.variance == null ? <span className="muted">-</span> : d(i.variance).isZero() ? <Pill k="ok">ตรง</Pill> : <b style={{ color: d(i.variance).lt(0) ? 'var(--bad)' : 'var(--ok)' }}>{d(i.variance).gt(0) ? '+' : ''}{fq(i.variance)}</b>}</td>}
                <td className="stk-state"><Pill k={LINE_ST[i.state][1]}>{LINE_ST[i.state][0]}</Pill>{i.round > 1 && <div className="small muted">นับใหม่ครั้งที่ {i.round - 1}</div>}</td>
                <td className="small muted">{i.countedBy ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {x?.adjustRequestNo && <div className="note small" style={{ marginTop: 10 }}>ผลต่างส่งเป็นคำขอปรับยอด <DocLink no={x.adjustRequestNo} type="RQ" /> · ผู้จัดการหรือเจ้าของร้านตัดสินรายรายการได้ที่นี่หรือหน้า "คลังสินค้า"</div>}
      {(sel.size > 0 || (x?.status === 'submitted' && x.review > 0 && canApprove)) && (
        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          {sel.size > 0 && <button className="btn" disabled={busy} onClick={() => void recount()} data-testid="count-recount">สั่งนับใหม่ {sel.size} รายการ</button>}
          {x?.status === 'submitted' && x.review > 0 && canApprove && <button className="btn pri" disabled={busy} onClick={() => void openDecide()} data-testid="count-decide">อนุมัติ / ไม่อนุมัติ / นับใหม่ รายรายการ</button>}
        </div>
      )}
      {deciding && <DecideModal a={deciding} busy={busy} onClose={() => setDeciding(null)} onSubmit={(b) => void decide(b)} />}
      {canCount && (
        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          {x?.round === 1 && <button className="btn bad" onClick={() => void cancel()}>ยกเลิกรอบนับ</button>}
          <button className="btn pri" disabled={!x?.counted} onClick={() => void submit()} data-testid="count-submit">{x && x.round > 1 ? 'ส่งผลนับใหม่ให้อนุมัติ' : 'ปิดรอบและส่งผลต่างให้อนุมัติ'}</button>
        </div>
      )}
    </div>
  );
}
