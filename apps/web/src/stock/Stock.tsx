/** M06 stock: balances per warehouse, FIFO lots, multi-line forms, adjustment requests with approve / reject. */
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AdjustRequest, StockBalance, StockDoc, StockLot, page } from '@erp/contracts';
import { d } from '@erp/core';
import { z } from 'zod';
import { ApiFail, api, errText } from '../api';
import { useAuth } from '../auth';
import { CloudIncomingCard, CloudReorderButton, IS_CLOUD } from '../cloud';
import { useCatalog, useAllWarehouses } from '../data';
import { fmt, fq, Modal, Pill, ShortageModal, SkeletonRows, th, useDebounced, useToast, type Shortage } from '../ui';
import { LoadMore, useLoadMore } from '../ui/lists';
import './stock.css';
import { ReceiptModal, StockFormModal, type StockKind } from './forms';
import { ErrorBanner } from '../errors';
import { DocLink, DocText, RouteLink } from '../doclink';

const PAGE = 20; // products per page (NFR-12); the API pages product × warehouse rows

type Bal = z.infer<typeof StockBalance>;

export default function Stock() {
  const { can } = useAuth();
  const cat = useCatalog();
  const whs = useAllWarehouses();
  const active = (whs.data ?? []).filter((w) => w.active);
  const sellable = active.filter((w) => w.kind !== 'damaged');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const [form, setForm] = useState<StockKind | 'gr' | null>(null);
  const [lotsOf, setLotsOf] = useState<string | null>(null);
  const seeCost = can('data.cost') === 1;
  const rowsPerPage = Math.min(100, PAGE * Math.max(1, active.length));

  // REQ: long lists load 20 products at a time (the API pages product × warehouse rows, damaged warehouses included).
  const bal = useLoadMore<Bal>(['stock', 'balances', dq], '/api/stock', StockBalance, { q: dq, damaged: 'include' }, rowsPerPage, !!whs.data);
  const rows = useMemo(() => {
    const m = new Map<string, Map<string, Bal>>();
    for (const b of bal.rows) {
      if (!m.has(b.productId)) m.set(b.productId, new Map());
      m.get(b.productId)!.set(b.warehouseId, b);
    }
    return [...m.entries()];
  }, [bal.rows]);
  const loading = bal.isLoading || !whs.data;
  const cols = 6 + active.length + (seeCost ? 2 : 0);

  return (
    <>
      {!IS_CLOUD && (
        <div className="card">
          <h2>รับของจากผู้แทนจำหน่าย SCG</h2>
          <div className="note small">On-premise · รับของ SCG ด้วย "ซื้อเข้าแบบบันทึกเอง" แล้วระบบรับเข้าสต็อกทันที</div>
          {can('inv.receive') === 1 && <div className="act" style={{ marginTop: 10, justifyContent: 'flex-start' }}><button className="btn sm pri" onClick={() => setForm('gr')}>+ ซื้อเข้าแบบบันทึกเอง</button></div>}
        </div>
      )}
      {CloudIncomingCard && <Suspense fallback={null}><CloudIncomingCard /></Suspense>}
      <div className="card">
        <h2>
          <span className="row">สต็อกคงเหลือ <Pill k="acc">ต้นทุน: FIFO ตามล็อต</Pill></span>
          <span className="row">
            {can('inv.receive') === 1 && <button className="btn sm" onClick={() => setForm('gr')} data-testid="btn-gr">ซื้อเข้าแบบบันทึกเอง</button>}
            {(can('inv.adj') === 1 || can('inv.receive') === 1) && <button className="btn sm" onClick={() => setForm('tr')} data-testid="btn-tr">โอนคลัง</button>}
            {can('inv.adj') === 1 && <button className="btn sm" onClick={() => setForm('iss')} data-testid="btn-iss">เบิกใช้</button>}
            {(can('inv.adj') === 1 || can('inv.count') === 1) && <button className="btn sm" onClick={() => setForm('adj')} data-testid="btn-adj">ปรับยอด</button>}
            {CloudReorderButton && <Suspense fallback={null}><CloudReorderButton /></Suspense>}
          </span>
        </h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <input type="search" placeholder="ค้นหาชื่อสินค้าหรือรหัส" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 200 }} aria-label="ค้นหาสต็อก" />
        </div>
        {bal.isError && <ErrorBanner error={bal.error} onRetry={() => void bal.refetch()} retrying={bal.isFetching} />}
        <div className="tw">
          <table data-testid="stock-table" className="stk-table">
            <thead>
              <tr>
                <th>สินค้า</th><th>หน่วยหลัก</th>
                {active.map((w) => <th key={w.id} className={`n${w.kind === 'damaged' ? ' stk-dmg' : ''}`}>{w.name}{w.kind === 'damaged' && <div className="small">ไม่นับเป็นสต็อกขาย</div>}</th>)}
                <th className="n">รวม (ขายได้)</th>
                <th className="n" title="สั่งขายแล้ว (ใบสั่งขายที่ยังส่งไม่ครบ)">จอง (SO)</th>
                <th className="n" title="คงเหลือ − จอง">พร้อมขาย</th>
                {seeCost && <><th className="n">ทุนถัวเฉลี่ย</th><th className="n">มูลค่า</th></>}
                <th />
              </tr>
            </thead>
            <tbody>
              {loading ? <SkeletonRows cols={cols} rows={8} /> : rows.map(([pid, byWh]) => {
                const p = cat.byId.get(pid);
                const of = (k: 'qty' | 'reserved' | 'available') => sellable.reduce((a, w) => a.plus(d(byWh.get(w.id)?.[k] ?? '0')), d(0));
                const total = of('qty');
                const reserved = of('reserved');
                const avail = of('available');
                const low = p && total.lt(d(p.reorderPoint));
                return (
                  <tr key={pid} data-product={pid}>
                    <td><RouteLink to={`/stock-ledger?productId=${encodeURIComponent(pid)}`}>{p?.name ?? pid}</RouteLink> {p?.isScg && <Pill k="acc">SCG</Pill>}</td>
                    <td>{p?.units[0]?.name}{p && p.units.length > 1 && <div className="small muted">{p.units.slice(1).map((u) => `1 ${u.name} = ${fq(u.factor)} ${p.units[0]!.name}`).join(' · ')}</div>}</td>
                    {active.map((w) => {
                      const b = byWh.get(w.id);
                      return (
                        <td key={w.id} className={`n${w.kind === 'damaged' ? ' stk-dmg' : ''}`}>
                          {fq(b?.qty ?? '0')}
                          {b && w.kind !== 'damaged' && d(b.reserved ?? 0).gt(0) && <div className="small muted">จอง {fq(b.reserved!)}</div>}
                        </td>
                      );
                    })}
                    <td className="n"><b>{fq(total)}</b></td>
                    <td className="n" data-testid="stk-reserved">{reserved.isZero() ? <span className="muted">-</span> : fq(reserved)}</td>
                    <td className="n" data-testid="stk-available"><b style={avail.lt(0) ? { color: 'var(--bad)' } : undefined}>{fq(avail)}</b></td>
                    {seeCost && <><td className="n">{p?.cost != null ? fmt(p.cost) : '-'}</td><td className="n">{p?.cost != null ? fmt(total.times(d(p.cost))) : '-'}</td></>}
                    <td>
                      <div className="row" style={{ flexWrap: 'nowrap' }}>
                        {low && <Pill k="warn">ต่ำกว่าจุดสั่งซื้อ</Pill>}
                        {avail.lt(0) && <Pill k="bad">จองเกินคงเหลือ</Pill>}
                        {seeCost && <button className="btn sm" onClick={() => setLotsOf(pid)}>ล็อต</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!loading && !rows.length && <tr><td colSpan={cols} className="empty">ไม่พบสินค้า</td></tr>}
            </tbody>
          </table>
        </div>
        <LoadMore hasMore={!!bal.hasNextPage} loading={bal.isFetchingNextPage} onMore={() => void bal.fetchNextPage()} count={rows.length} testId="stock-more" />
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          จอง = สั่งขายแล้วแต่ยังไม่ส่ง (ใบสั่งขาย) · พร้อมขาย = คงเหลือ − จอง ใช้ดูไม่ให้รับปากของซ้ำ (การขายตัดได้ตามคงเหลือจริง) · คลังสินค้าชำรุดไม่นับเป็นสต็อกขาย
          {!seeCost && ' · ล็อตและต้นทุนแสดงเฉพาะบทบาทที่มีสิทธิ์ "เห็นต้นทุนและกำไร"'}
        </p>
      </div>
      {(can('inv.adj') || can('inv.adjApprove') || can('inv.count')) ? <AdjustCard /> : null}
      {form === 'gr' && <ReceiptModal onClose={() => setForm(null)} />}
      {form && form !== 'gr' && <StockFormModal kind={form} onClose={() => setForm(null)} />}
      {lotsOf && <LotsModal productId={lotsOf} onClose={() => setLotsOf(null)} />}
    </>
  );
}

function LotsModal({ productId, onClose }: { productId: string; onClose: () => void }) {
  const cat = useCatalog();
  const whs = useAllWarehouses();
  const p = cat.byId.get(productId);
  const lots = useQuery({
    queryKey: ['lots', productId],
    queryFn: async () => {
      const out: z.infer<typeof StockLot>[] = [];
      let cursor: string | undefined;
      do {
        const r = await api('GET', '/api/stock/lots', { query: { productId, limit: 100, cursor }, schema: page(StockLot) });
        out.push(...r.items);
        cursor = r.nextCursor ?? undefined;
      } while (cursor);
      return out;
    },
  });
  const seen = new Set<string>();
  const totalQ = (lots.data ?? []).reduce((a, l) => a.plus(d(l.qty)), d(0));
  const totalV = (lots.data ?? []).reduce((a, l) => a.plus(d(l.qty).times(d(l.unitCost))), d(0));
  const today = Date.now();
  return (
    <Modal onClose={onClose} wide label="ล็อตสินค้า">
      <h3>ล็อตสินค้า · {p?.name}</h3>
      <p className="small muted" style={{ margin: 0 }}>ระบบเก็บสต็อกเป็นล็อตตามวันที่รับเข้า ขาย เบิก หรือส่งของจะตัดล็อตที่เก่าที่สุดของคลังนั้นก่อน (FIFO) และใช้ทุนของล็อตนั้นเป็นต้นทุนขาย · โอนคลังแล้วล็อตย้ายไปพร้อมวันที่เดิม</p>
      {lots.isError && <ErrorBanner error={lots.error} onRetry={() => void lots.refetch()} retrying={lots.isFetching} />}
      <div className="tw">
        <table data-testid="lots-table">
          <thead><tr><th>ลำดับตัด</th><th>วันที่รับ</th><th>คลัง</th><th>อ้างอิง</th><th className="n">คงเหลือ</th><th className="n">ทุน/หน่วย</th><th className="n">มูลค่า</th><th className="n">อายุ (วัน)</th></tr></thead>
          <tbody>
            {lots.isLoading ? <SkeletonRows cols={8} rows={3} /> : (lots.data ?? []).map((l) => {
              const first = !seen.has(l.warehouseId);
              seen.add(l.warehouseId);
              return (
                <tr key={l.id}>
                  <td className="lot-first">{first ? <Pill k="acc">ตัดก่อน</Pill> : 'ถัดไป'}</td>
                  <td>{th(l.receivedAt)}</td>
                  <td>{whs.data?.find((w) => w.id === l.warehouseId)?.name}</td>
                  <td className="mono small"><DocLink no={l.ref} /></td>
                  <td className="n">{fq(l.qty)} {p?.units[0]?.name}</td>
                  <td className="n">{fmt(l.unitCost)}</td>
                  <td className="n">{fmt(d(l.qty).times(d(l.unitCost)))}</td>
                  <td className="n">{Math.max(0, Math.floor((today - new Date(l.receivedAt).getTime()) / 864e5))}</td>
                </tr>
              );
            })}
            {lots.data && !lots.data.length && <tr><td colSpan={8} className="empty">ไม่มีล็อตคงเหลือ</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <RouteLink className="small" to={`/stock-ledger?productId=${encodeURIComponent(productId)}`}>ดูความเคลื่อนไหวของสินค้านี้ (สมุดคุมสต็อก)</RouteLink>
        <span className="small muted">ทุนเฉลี่ยของล็อตคงเหลือ (FIFO) {fmt(totalQ.gt(0) ? totalV.div(totalQ) : 0)}</span>
        <b>มูลค่าตาม FIFO {fmt(totalV)}</b>
      </div>
      <div className="act"><button className="btn pri" onClick={onClose}>ปิด</button></div>
    </Modal>
  );
}

type Status = 'pending' | 'approved' | 'rejected';
const ST_TH: Record<Status, string> = { pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ' };
type Adj = z.infer<typeof AdjustRequest>;
type LineState = NonNullable<Adj['lines'][number]['state']>;
const LINE_TH: Record<LineState, [string, 'ok' | 'mut' | 'warn']> = { approved: ['อนุมัติ', 'ok'], rejected: ['ไม่อนุมัติ', 'mut'], recount: ['สั่งนับใหม่', 'warn'] };
const Decided = z.object({ request: AdjustRequest, doc: StockDoc.nullable() });

function AdjustCard() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const cat = useCatalog();
  const whs = useAllWarehouses();
  const [status, setStatus] = useState<Status>('pending');
  // ?req=RQ… (home approvals card, audit log, stock count): open the tab that holds that request and highlight it
  const [sp] = useSearchParams();
  const req = sp.get('req');
  const found = useQuery({
    queryKey: ['adjust', 'by-no', req], enabled: !!req,
    queryFn: async () => (await api('GET', '/api/stock/adjust-requests', { query: { q: req ?? '', limit: 5 }, schema: page(AdjustRequest) })).items.find((a) => a.no === req)?.status ?? null,
  });
  useEffect(() => { if (found.data) setStatus(found.data); }, [found.data]);
  const [short, setShort] = useState<Shortage[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<Adj | null>(null);
  const list = useLoadMore<Adj>(['adjust', 'list', status], '/api/stock/adjust-requests', AdjustRequest, { status }, 20);
  const canApprove = can('inv.adjApprove') === 1;

  const run = async (id: string, body: { approve: string[]; reject: string[]; recount: string[]; note?: string }) => {
    setBusy(id);
    try {
      const r = await api('POST', `/api/stock/adjust-requests/${id}/decide`, { body, schema: Decided });
      toast(r.doc ? `อนุมัติแล้ว · ปรับสต็อก ${r.doc.no}` : body.recount.length ? 'ส่งกลับให้นับใหม่แล้ว' : 'ไม่อนุมัติคำขอปรับยอดแล้ว');
      setDeciding(null);
      await Promise.all([qc.invalidateQueries({ queryKey: ['adjust'] }), qc.invalidateQueries({ queryKey: ['stock'] }), qc.invalidateQueries({ queryKey: ['pu'] })]);
    } catch (e) {
      if (e instanceof ApiFail && e.code === 'INSUFFICIENT_STOCK' && e.claim()) setShort(e.details as Shortage[]);
      else toast(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const open = (a: Adj) => a.lines.filter((l) => !l.state).map((l) => l.productId);

  const items = list.rows;
  return (
    <div className="card">
      <h2>คำขอปรับยอดสต็อก {status === 'pending' && items.length > 0 && <Pill k="warn">{items.length}{list.hasNextPage ? '+' : ''} รายการ</Pill>}</h2>
      <div className="steps" style={{ marginBottom: 12 }}>
        {(['pending', 'approved', 'rejected'] as Status[]).map((s) => (
          <span key={s} role="button" tabIndex={0} className={status === s ? 'on' : ''} onClick={() => setStatus(s)} onKeyDown={(e) => { if (e.key === 'Enter') setStatus(s); }}>{ST_TH[s]}</span>
        ))}
      </div>
      <div className="tw">
        <table data-testid="adjust-table">
          <thead><tr><th>เลขที่</th><th>วันที่</th><th>คลัง</th><th>สินค้า / ผลต่าง</th><th>เหตุผล / หมายเหตุ</th><th>สถานะ</th><th /></tr></thead>
          <tbody>
            {list.isLoading ? <SkeletonRows cols={7} rows={2} /> : items.map((a) => (
              <tr key={a.id} id={`adj-${a.no}`} style={a.no === req ? { background: 'var(--acc-soft, #fff7d6)' } : undefined}>
                <td className="mono">{a.no}{a.countNo && <div className="small"><DocLink no={a.countNo} type="CNT" /></div>}</td>
                <td className="small">{th(a.createdAt)}</td>
                <td>{whs.data?.find((w) => w.id === a.warehouseId)?.name}</td>
                <td className="small">{a.lines.map((l) => {
                  const neg = d(l.qtyDelta).lt(0);
                  return (
                    <div key={l.productId}>
                      {cat.byId.get(l.productId)?.name ?? l.productId} <b style={{ color: neg ? 'var(--bad)' : 'var(--ok)' }}>{neg ? '' : '+'}{fq(l.qtyDelta)}</b>
                      {l.state && <> <Pill k={LINE_TH[l.state][1]}>{LINE_TH[l.state][0]}</Pill></>}
                    </div>
                  );
                })}</td>
                <td className="small"><DocText text={a.reason} />{a.note && <div className="muted">{a.note}</div>}</td>
                <td>{a.status === 'pending' ? <Pill k="warn">รออนุมัติ</Pill> : a.status === 'approved' ? <><Pill k="ok">อนุมัติแล้ว</Pill>{a.resultDocNo && <div className="mono small"><DocLink no={a.resultDocNo} type="ADJ" /></div>}</> : <Pill k="mut">ไม่อนุมัติ</Pill>}<div className="small muted">{a.requestedBy}{a.decidedBy ? ` → ${a.decidedBy}` : ''}</div></td>
                <td>
                  {a.status === 'pending' && (canApprove ? (
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <button className="btn sm pri" disabled={busy === a.id} onClick={() => void run(a.id, { approve: open(a), reject: [], recount: [] })}>อนุมัติ</button>
                      {open(a).length > 1 || a.countNo ? <button className="btn sm" disabled={busy === a.id} onClick={() => setDeciding(a)} data-testid={`adj-pick-${a.no}`}>เลือกรายการ…</button> : null}
                      <button className="btn sm bad" disabled={busy === a.id} onClick={() => void run(a.id, { approve: [], reject: open(a), recount: [] })}>ไม่อนุมัติ</button>
                    </div>
                  ) : <Pill k="warn">รอผู้จัดการ/เจ้าของอนุมัติ</Pill>)}
                </td>
              </tr>
            ))}
            {!list.isLoading && !items.length && <tr><td colSpan={7} className="empty">ไม่มีคำขอ{ST_TH[status]}</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onMore={() => void list.fetchNextPage()} count={items.length} testId="adjust-more" />
      <p className="small muted" style={{ margin: '8px 0 0' }}>ปุ่มอนุมัติแสดงเฉพาะบทบาทที่มีสิทธิ์ "อนุมัติปรับยอด" · ผู้ขออนุมัติเองไม่ได้ · "เลือกรายการ…" อนุมัติบางรายการได้ ที่เหลือไม่อนุมัติ หรือส่งกลับให้นับใหม่ (คำขอจากรอบนับ)</p>
      {deciding && <DecideModal a={deciding} busy={busy === deciding.id} onClose={() => setDeciding(null)} onSubmit={(b) => void run(deciding.id, b)} />}
      {short && <ShortageModal shortages={short} what="อนุมัติปรับยอดไม่ได้" onClose={() => setShort(null)} />}
    </div>
  );
}

/** Line-by-line decision (partial approval, REQ-M06-06). */
export function DecideModal({ a, busy, onClose, onSubmit }: {
  a: Adj; busy: boolean; onClose: () => void; onSubmit: (b: { approve: string[]; reject: string[]; recount: string[]; note?: string }) => void;
}) {
  const cat = useCatalog();
  const lines = a.lines.filter((l) => !l.state);
  const [pick, setPick] = useState<Record<string, LineState>>(() => Object.fromEntries(lines.map((l) => [l.productId, 'approved' as LineState])));
  const [note, setNote] = useState('');
  const opts: LineState[] = a.countNo ? ['approved', 'rejected', 'recount'] : ['approved', 'rejected'];
  const of = (st: LineState) => lines.filter((l) => pick[l.productId] === st).map((l) => l.productId);
  return (
    <Modal onClose={onClose} wide label="ตัดสินคำขอปรับยอดรายรายการ">
      <h3>ตัดสินรายรายการ · {a.no}</h3>
      <p className="small muted" style={{ margin: 0 }}>{a.reason}{a.countNo ? ' · รายการที่ "สั่งนับใหม่" จะกลับไปให้นับในรอบเดิม (ยอดขาย/รับระหว่างนับยังหักให้)' : ''}</p>
      <div className="tw">
        <table data-testid="decide-table">
          <thead><tr><th>สินค้า</th><th className="n">ผลต่าง</th>{opts.map((o) => <th key={o}>{LINE_TH[o][0]}</th>)}</tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.productId}>
                <td>{cat.byId.get(l.productId)?.name ?? l.productId}</td>
                <td className="n"><b style={{ color: d(l.qtyDelta).lt(0) ? 'var(--bad)' : 'var(--ok)' }}>{d(l.qtyDelta).gt(0) ? '+' : ''}{fq(l.qtyDelta)}</b></td>
                {opts.map((o) => (
                  <td key={o}><input type="radio" name={`dec-${l.productId}`} checked={pick[l.productId] === o} onChange={() => setPick((p) => ({ ...p, [l.productId]: o }))}
                    aria-label={`${LINE_TH[o][0]} ${cat.byId.get(l.productId)?.name ?? ''}`} data-testid={`dec-${o}-${cat.byId.get(l.productId)?.sku ?? l.productId}`} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <label className="f">หมายเหตุ<input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="ไม่บังคับ เช่น เหตุผลที่ให้นับใหม่" data-testid="dec-note" /></label>
      <div className="act">
        <button className="btn" onClick={onClose}>ยกเลิก</button>
        <button className="btn pri" disabled={busy} data-testid="dec-save"
          onClick={() => onSubmit({ approve: of('approved'), reject: of('rejected'), recount: of('recount'), ...(note.trim() ? { note: note.trim() } : {}) })}>
          บันทึก (อนุมัติ {of('approved').length} · ไม่อนุมัติ {of('rejected').length}{a.countNo ? ` · นับใหม่ ${of('recount').length}` : ''})
        </button>
      </div>
    </Modal>
  );
}
