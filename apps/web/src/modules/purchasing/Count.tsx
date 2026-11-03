/**
 * M06 "นับสต็อก" (REQ-M06-05/06, BR-09): open a round per warehouse (optionally one category), scan or type counts
 * (several people at once), the system quantity stays hidden while counting, submit → variances become one
 * adjustment request that the owner / manager approves on the stock page.
 */
import { useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { StockCount, StockCountSummary, page } from '@erp/contracts';
import { d } from '@erp/core';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { useCatalog, useWarehouses } from '../../data';
import { fq, Modal, Pager, Pill, SkeletonRows, thTime, useCursorPager, useToast } from '../../ui';
import './purchasing.css';

const STATUS = { counting: ['กำลังนับ', 'warn'], submitted: ['ส่งผลแล้ว', 'ok'], cancelled: ['ยกเลิก', 'mut'] } as const;

export default function Count() {
  const { can } = useAuth();
  const whs = useWarehouses();
  const [open, setOpen] = useState<string | null>(null);
  const [start, setStart] = useState(false);
  const pager = useCursorPager('');
  const list = useQuery({
    queryKey: ['pu', 'counts', pager.cursor],
    queryFn: () => api('GET', '/api/stock-counts', { query: { cursor: pager.cursor }, schema: page(StockCountSummary) }),
    placeholderData: keepPreviousData,
  });
  const loading = list.isLoading || (list.isFetching && list.isPlaceholderData);
  const wName = (id: string) => whs.data?.find((w) => w.id === id)?.name ?? '';
  if (open) return <CountSheet id={open} onBack={() => setOpen(null)} />;
  return (
    <div className="card">
      <h2><span>รอบนับสต็อก</span>{can('inv.count') === 1 && <button className="btn sm pri" onClick={() => setStart(true)} data-testid="btn-open-count">+ เปิดรอบนับ</button>}</h2>
      <div className="tw">
        <table data-testid="count-list">
          <thead><tr><th>เลขที่</th><th>คลัง</th><th>หมวด</th><th>สถานะ</th><th className="n">นับแล้ว</th><th>เปิดโดย</th><th>ผลต่าง</th><th /></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={8} rows={3} /> : (list.data?.items ?? []).map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.no}</td><td>{wName(c.warehouseId)}</td><td>{c.category ?? 'ทั้งคลัง'}</td>
                <td><Pill k={STATUS[c.status][1]}>{STATUS[c.status][0]}</Pill></td><td className="n">{c.counted} / {c.lines}</td>
                <td className="small">{c.openedBy}<div className="muted">{thTime(c.openedAt)}</div></td>
                <td className="mono small">{c.adjustRequestNo ?? (c.status === 'submitted' ? 'ตรงทุกรายการ' : '-')}</td>
                <td><button className="btn sm" onClick={() => setOpen(c.id)} data-testid={`count-open-${c.no}`}>{c.status === 'counting' ? 'นับต่อ' : 'ดูผล'}</button></td>
              </tr>
            ))}
            {!loading && !list.data?.items.length && <tr><td colSpan={8} className="empty">ยังไม่มีรอบนับ</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!list.data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor ?? null)} />
      <p className="small muted" style={{ margin: '8px 0 0' }}>ระหว่างนับระบบซ่อนยอดตามระบบ (BR-09) · ผลต่างคิดเทียบยอด ณ เวลาเปิดรอบ และหักการขาย / รับเข้าระหว่างนับให้แล้ว · ผลต่างทุกรายการต้องให้เจ้าของร้านหรือผู้จัดการอนุมัติก่อนปรับสต็อก</p>
      {start && <OpenModal onClose={() => setStart(false)} onOpened={(id) => { setStart(false); setOpen(id); }} />}
    </div>
  );
}

function OpenModal({ onClose, onOpened }: { onClose: () => void; onOpened: (id: string) => void }) {
  const whs = useWarehouses();
  const cat = useCatalog();
  const qc = useQueryClient();
  const active = (whs.data ?? []).filter((w) => w.active);
  const cats = useMemo(() => [...new Set((cat.data ?? []).filter((p) => p.kind === 'stock').map((p) => p.category))].filter(Boolean).sort(), [cat.data]);
  const [wh, setWh] = useState('');
  const [category, setCategory] = useState('');
  const [err, setErr] = useState('');
  const whId = wh || active[0]?.id || '';
  const go = async () => {
    try {
      const r = await api('POST', '/api/stock-counts', { body: { warehouseId: whId, ...(category ? { category } : {}) }, schema: StockCount });
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
        <label className="f">คลัง<select value={whId} onChange={(e) => setWh(e.target.value)} data-testid="count-wh">{active.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        <label className="f">นับเฉพาะหมวด<select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">ทั้งคลัง</option>{cats.map((c) => <option key={c}>{c}</option>)}</select></label>
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
  const whs = useWarehouses();
  const [show, setShow] = useState(false);
  const [scan, setScan] = useState('');
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState('');
  const scanRef = useRef<HTMLInputElement>(null);
  const key = ['pu', 'count', id, show];
  const c = useQuery({ queryKey: key, queryFn: () => api('GET', `/api/stock-counts/${id}`, { query: { showSystem: show ? 'true' : undefined }, schema: StockCount }) });
  const x = c.data;
  const counting = x?.status === 'counting';
  const canCount = can('inv.count') === 1 && counting;
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
      await qc.invalidateQueries({ queryKey: ['pu', 'counts'] });
      await qc.invalidateQueries({ queryKey: ['adjust'] });
      toast(r.adjustRequestNo ? `ส่งผลต่างแล้ว ${r.adjustRequestNo} รออนุมัติ` : 'นับตรงทุกรายการ');
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
        <span className="row"><button className="btn sm" onClick={onBack}>‹ กลับ</button> นับสต็อก {x?.no ?? ''} {x && <Pill k={STATUS[x.status][1]}>{STATUS[x.status][0]}</Pill>}</span>
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
      <input type="search" placeholder="กรองรายการ" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="กรองรายการนับ" style={{ width: '100%', marginBottom: 10 }} />
      {err && <div className="err" role="alert">{err}</div>}
      <div className="tw">
        <table data-testid="count-sheet">
          <thead><tr><th>สินค้า</th><th>หน่วย</th>{sys && <><th className="n">ตามระบบ</th><th className="n">ขาย/รับระหว่างนับ</th></>}<th className="n">นับได้</th>{sys && <th className="n">ผลต่าง</th>}<th>ผู้นับ</th></tr></thead>
          <tbody>
            {c.isLoading ? <SkeletonRows cols={5} rows={6} /> : items.map((i) => (
              <tr key={i.productId}>
                <td>{i.name}<div className="small muted mono">{i.sku}</div></td>
                <td>{i.unitName}</td>
                {sys && <><td className="n">{fq(i.systemQty)}</td><td className="n">{i.movedQty && !d(i.movedQty).isZero() ? fq(i.movedQty) : '-'}</td></>}
                <td className="n">{canCount ? (
                  <input key={`${i.productId}:${i.countedQty ?? ''}`} className="pu-qty-in" type="text" inputMode="decimal" placeholder="-" defaultValue={i.countedQty ?? ''} aria-label={`นับได้ ${i.name}`}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== (i.countedQty ?? '') && /^\d+(\.\d+)?$/.test(v)) void entry(i.productId, v, 'set'); }} data-testid={`count-q-${i.sku}`} />
                ) : (i.countedQty != null ? fq(i.countedQty) : <span className="muted">ยังไม่นับ</span>)}</td>
                {sys && <td className="n">{i.variance == null ? <span className="muted">-</span> : d(i.variance).isZero() ? <Pill k="ok">ตรง</Pill> : <b style={{ color: d(i.variance).lt(0) ? 'var(--bad)' : 'var(--ok)' }}>{d(i.variance).gt(0) ? '+' : ''}{fq(i.variance)}</b>}</td>}
                <td className="small muted">{i.countedBy ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {x?.adjustRequestNo && <div className="note small" style={{ marginTop: 10 }}>ผลต่างส่งเป็นคำขอปรับยอด {x.adjustRequestNo} แล้ว · ผู้จัดการหรือเจ้าของร้านอนุมัติได้ที่หน้า "คลังสินค้า"</div>}
      {canCount && (
        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="btn bad" onClick={() => void cancel()}>ยกเลิกรอบนับ</button>
          <button className="btn pri" disabled={!x?.counted} onClick={() => void submit()} data-testid="count-submit">ปิดรอบและส่งผลต่างให้อนุมัติ</button>
        </div>
      )}
    </div>
  );
}
