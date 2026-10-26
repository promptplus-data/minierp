/** M06 stock: balances per warehouse, FIFO lots, multi-line forms, adjustment requests with approve / reject. */
import { Suspense, useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdjustRequest, StockBalance, StockDoc, StockLot, page } from '@erp/contracts';
import { d } from '@erp/core';
import { z } from 'zod';
import { ApiFail, api, errText } from '../api';
import { useAuth } from '../auth';
import { CloudIncomingCard, CloudReorderButton, IS_CLOUD } from '../cloud';
import { useCatalog, useWarehouses } from '../data';
import { fmt, fq, Modal, Pager, Pill, ShortageModal, SkeletonRows, th, useCursorPager, useDebounced, useToast, type Shortage } from '../ui';
import { ReceiptModal, StockFormModal, type StockKind } from './forms';

const PAGE = 20; // products per page (NFR-12); the API pages product × warehouse rows

export default function Stock() {
  const { can } = useAuth();
  const cat = useCatalog();
  const whs = useWarehouses();
  const active = (whs.data ?? []).filter((w) => w.active);
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const pager = useCursorPager(dq);
  const [form, setForm] = useState<StockKind | 'gr' | null>(null);
  const [lotsOf, setLotsOf] = useState<string | null>(null);
  const seeCost = can('data.cost') === 1;
  const rowsPerPage = Math.min(100, PAGE * Math.max(1, active.length));

  const bal = useQuery({
    queryKey: ['stock', 'balances', dq, pager.cursor, rowsPerPage],
    enabled: !!whs.data,
    queryFn: () => api('GET', '/api/stock', { query: { q: dq, limit: rowsPerPage, cursor: pager.cursor }, schema: page(StockBalance) }),
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => {
    const m = new Map<string, Map<string, string>>();
    for (const b of bal.data?.items ?? []) {
      if (!m.has(b.productId)) m.set(b.productId, new Map());
      m.get(b.productId)!.set(b.warehouseId, b.qty);
    }
    return [...m.entries()];
  }, [bal.data]);
  const loading = bal.isLoading || !whs.data || (bal.isFetching && bal.isPlaceholderData);
  const cols = 4 + active.length + (seeCost ? 2 : 0);

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
        {bal.isError && <div className="note bad small">{errText(bal.error)}</div>}
        <div className="tw">
          <table data-testid="stock-table">
            <thead>
              <tr>
                <th>สินค้า</th><th>หน่วยหลัก</th>
                {active.map((w) => <th key={w.id} className="n">{w.name}</th>)}
                <th className="n">รวม</th>
                {seeCost && <><th className="n">ทุนถัวเฉลี่ย</th><th className="n">มูลค่า</th></>}
                <th />
              </tr>
            </thead>
            <tbody>
              {loading ? <SkeletonRows cols={cols} rows={8} /> : rows.map(([pid, byWh]) => {
                const p = cat.byId.get(pid);
                const total = active.reduce((a, w) => a.plus(d(byWh.get(w.id) ?? '0')), d(0));
                const low = p && total.lt(d(p.reorderPoint));
                return (
                  <tr key={pid}>
                    <td>{p?.name ?? pid} {p?.isScg && <Pill k="acc">SCG</Pill>}</td>
                    <td>{p?.units[0]?.name}{p && p.units.length > 1 && <div className="small muted">{p.units.slice(1).map((u) => `1 ${u.name} = ${fq(u.factor)} ${p.units[0]!.name}`).join(' · ')}</div>}</td>
                    {active.map((w) => <td key={w.id} className="n">{fq(byWh.get(w.id) ?? '0')}</td>)}
                    <td className="n"><b>{fq(total)}</b></td>
                    {seeCost && <><td className="n">{p?.cost != null ? fmt(p.cost) : '-'}</td><td className="n">{p?.cost != null ? fmt(total.times(d(p.cost))) : '-'}</td></>}
                    <td>
                      <div className="row" style={{ flexWrap: 'nowrap' }}>
                        {low && <Pill k="warn">ต่ำกว่าจุดสั่งซื้อ</Pill>}
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
        <Pager page={pager.page} hasNext={!!bal.data?.nextCursor} count={rows.length} loading={bal.isFetching} onPrev={pager.prev} onNext={() => pager.next(bal.data?.nextCursor ?? null)} />
        {!seeCost && <p className="small muted" style={{ margin: '8px 0 0' }}>ล็อตและต้นทุนแสดงเฉพาะบทบาทที่มีสิทธิ์ "เห็นต้นทุนและกำไร"</p>}
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
  const whs = useWarehouses();
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
      {lots.isError && <div className="note bad small">{errText(lots.error)}</div>}
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
                  <td className="mono small">{l.ref}</td>
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
        <span className="small muted">ทุนเฉลี่ยของล็อตคงเหลือ (FIFO) {fmt(totalQ.gt(0) ? totalV.div(totalQ) : 0)}</span>
        <b>มูลค่าตาม FIFO {fmt(totalV)}</b>
      </div>
      <div className="act"><button className="btn pri" onClick={onClose}>ปิด</button></div>
    </Modal>
  );
}

type Status = 'pending' | 'approved' | 'rejected';
const ST_TH: Record<Status, string> = { pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ' };

function AdjustCard() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const cat = useCatalog();
  const whs = useWarehouses();
  const [status, setStatus] = useState<Status>('pending');
  const pager = useCursorPager(status);
  const [short, setShort] = useState<Shortage[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['adjust', status, pager.cursor],
    queryFn: () => api('GET', '/api/stock/adjust-requests', { query: { status, limit: 20, cursor: pager.cursor }, schema: page(AdjustRequest) }),
  });
  const canApprove = can('inv.adjApprove') === 1;

  const act = async (id: string, kind: 'approve' | 'reject') => {
    setBusy(id);
    try {
      if (kind === 'approve') {
        const { doc } = await api('POST', `/api/stock/adjust-requests/${id}/approve`, { body: {}, schema: z.object({ request: AdjustRequest, doc: StockDoc }) });
        toast(`อนุมัติแล้ว · ปรับสต็อก ${doc.no}`);
      } else {
        await api('POST', `/api/stock/adjust-requests/${id}/reject`, { body: {}, schema: AdjustRequest });
        toast('ไม่อนุมัติคำขอปรับยอดแล้ว');
      }
      await Promise.all([qc.invalidateQueries({ queryKey: ['adjust'] }), qc.invalidateQueries({ queryKey: ['stock'] })]);
    } catch (e) {
      if (e instanceof ApiFail && e.code === 'INSUFFICIENT_STOCK') setShort(e.details as Shortage[]);
      else toast(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const items = list.data?.items ?? [];
  return (
    <div className="card">
      <h2>คำขอปรับยอดสต็อก {status === 'pending' && items.length > 0 && <Pill k="warn">{items.length} รายการ</Pill>}</h2>
      <div className="steps" style={{ marginBottom: 12 }}>
        {(['pending', 'approved', 'rejected'] as Status[]).map((s) => (
          <span key={s} role="button" tabIndex={0} className={status === s ? 'on' : ''} onClick={() => setStatus(s)} onKeyDown={(e) => { if (e.key === 'Enter') setStatus(s); }}>{ST_TH[s]}</span>
        ))}
      </div>
      <div className="tw">
        <table data-testid="adjust-table">
          <thead><tr><th>เลขที่</th><th>วันที่</th><th>คลัง</th><th>สินค้า / ผลต่าง</th><th>เหตุผล</th><th>สถานะ</th><th /></tr></thead>
          <tbody>
            {list.isLoading ? <SkeletonRows cols={7} rows={2} /> : items.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.no}</td>
                <td className="small">{th(a.createdAt)}</td>
                <td>{whs.data?.find((w) => w.id === a.warehouseId)?.name}</td>
                <td className="small">{a.lines.map((l) => {
                  const neg = d(l.qtyDelta).lt(0);
                  return <div key={l.productId}>{cat.byId.get(l.productId)?.name ?? l.productId} <b style={{ color: neg ? 'var(--bad)' : 'var(--ok)' }}>{neg ? '' : '+'}{fq(l.qtyDelta)}</b></div>;
                })}</td>
                <td className="small">{a.reason}</td>
                <td>{a.status === 'pending' ? <Pill k="warn">รออนุมัติ</Pill> : a.status === 'approved' ? <Pill k="ok">อนุมัติแล้ว{a.resultDocNo ? ` · ${a.resultDocNo}` : ''}</Pill> : <Pill k="mut">ไม่อนุมัติ</Pill>}</td>
                <td>
                  {a.status === 'pending' && (canApprove ? (
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <button className="btn sm pri" disabled={busy === a.id} onClick={() => void act(a.id, 'approve')}>อนุมัติ</button>
                      <button className="btn sm bad" disabled={busy === a.id} onClick={() => void act(a.id, 'reject')}>ไม่อนุมัติ</button>
                    </div>
                  ) : <Pill k="warn">รอผู้จัดการ/เจ้าของอนุมัติ</Pill>)}
                </td>
              </tr>
            ))}
            {list.data && !items.length && <tr><td colSpan={7} className="empty">ไม่มีคำขอ{ST_TH[status]}</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!list.data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor ?? null)} />
      <p className="small muted" style={{ margin: '8px 0 0' }}>ปุ่มอนุมัติแสดงเฉพาะบทบาทที่มีสิทธิ์ "อนุมัติปรับยอด"</p>
      {short && <ShortageModal shortages={short} what="อนุมัติปรับยอดไม่ได้" onClose={() => setShort(null)} />}
    </div>
  );
}
