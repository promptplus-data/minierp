/** ปรับปรุงต้นทุน: requests to change the unit cost of stock on hand, the approval list and the owner's on/off lock. */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { CostAdj, CostAdjPreview, CostAdjSettings, type Product } from '@erp/contracts';
import { d } from '@erp/core';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { useAllWarehouses, useCatalog } from '../../data';
import { fmt, fq, Modal, Pill, SkeletonRows, th, thTime, useToast } from '../../ui';
import { LoadMore, useLoadMore } from '../../ui/lists';
import { ProductPicker } from '../../ui/ProductPicker';

const isStock = (p: Product) => p.kind === 'stock';
const ST = { pending: ['รออนุมัติ', 'warn'], approved: ['อนุมัติแล้ว', 'ok'], rejected: ['ไม่อนุมัติ', 'mut'] } as const;

export function CostAdjTab() {
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [sp] = useSearchParams();
  const settings = useQuery({ queryKey: ['pu', 'cost-settings'], queryFn: () => api('GET', '/api/stock/cost-adjustments/settings', { schema: CostAdjSettings }) });
  const [status, setStatus] = useState<'pending' | 'all'>(sp.get('no') ? 'pending' : 'all');
  const r = useLoadMore(['pu', 'cost-adj', status], '/api/stock/cost-adjustments', CostAdj, { status }, 10);
  const [form, setForm] = useState(false);
  const [busy, setBusy] = useState('');
  const owner = user?.role === 'owner';
  const enabled = settings.data?.enabled ?? false;
  const canReq = can('inv.adj') === 1 || can('inv.adjApprove') === 1;
  const canApprove = can('inv.adjApprove') === 1;
  const refresh = () => qc.invalidateQueries({ queryKey: ['pu'] });
  const toggle = async () => {
    try {
      await api('PATCH', '/api/stock/cost-adjustments/settings', { body: { enabled: !enabled }, schema: CostAdjSettings });
      toast(enabled ? 'ปิด (ล็อก) การแก้ต้นทุนแล้ว' : 'เปิดให้ปรับปรุงต้นทุนแล้ว');
      void refresh();
    } catch (e) {
      toast(errText(e));
    }
  };
  const decide = async (x: CostAdj, approve: boolean) => {
    const note = approve ? '' : window.prompt('เหตุผลที่ไม่อนุมัติ') ?? '';
    setBusy(x.no);
    try {
      const res = await api('POST', `/api/stock/cost-adjustments/${x.no}/decide`, { body: { approve, note }, schema: CostAdj });
      toast(approve ? `อนุมัติ ${x.no} · มูลค่าสต็อกเปลี่ยน ฿${fmt(res.valueChange ?? '0')}` : `ไม่อนุมัติ ${x.no}`);
      void refresh();
    } catch (e) {
      toast(errText(e));
    } finally {
      setBusy('');
    }
  };
  return (
    <>
      <div className={`stk-summary small`} data-testid="cost-lock" style={{ alignItems: 'center' }}>
        <span>สถานะ: {enabled ? <Pill k="ok">เปิดให้ปรับปรุงต้นทุน</Pill> : <Pill k="bad">ปิด (ล็อก) ไม่ให้แก้ต้นทุน</Pill>}</span>
        {settings.data?.updatedBy && <span className="muted">ตั้งโดย {settings.data.updatedBy} · {thTime(settings.data.updatedAt!)}</span>}
        {owner && <button className={`btn sm${enabled ? '' : ' pri'}`} onClick={() => void toggle()} data-testid="cost-toggle">{enabled ? 'ปิด (ล็อก)' : 'เปิดให้ปรับปรุงต้นทุน'}</button>}
        {!owner && !enabled && <span className="muted">เจ้าของร้านเป็นผู้เปิด/ปิด</span>}
      </div>
      <div className="pu-filters">
        <select value={status} onChange={(e) => setStatus(e.target.value as 'pending' | 'all')} aria-label="สถานะคำขอ"><option value="all">ทั้งหมด</option><option value="pending">รออนุมัติ</option></select>
        {canReq && <button className="btn sm pri" disabled={!enabled} title={enabled ? '' : 'ปิด (ล็อก) อยู่'} onClick={() => setForm(true)} data-testid="btn-cost-adj">+ ขอปรับปรุงต้นทุน</button>}
      </div>
      <div className="tw">
        <table data-testid="cost-adj-table">
          <thead><tr><th>เลขที่</th><th>วันที่</th><th>รายการ</th><th className="n">มูลค่าเปลี่ยน</th><th>เหตุผล</th><th>สถานะ</th><th /></tr></thead>
          <tbody>
            {r.isLoading ? <SkeletonRows cols={7} rows={3} /> : r.rows.map((x) => {
              const change = x.valueChange ?? x.lines.reduce((a, l) => a.plus(d(l.change)), d(0)).toFixed(2);
              return (
                <tr key={x.id} data-testid={`ca-${x.no}`}>
                  <td className="mono">{x.no}</td><td>{th(x.date)}<div className="small muted">{x.requestedBy}</div></td>
                  <td className="small">{x.lines.map((l) => (
                    <div key={`${l.productId}${l.warehouseId}`}>{l.name} · {l.warehouseName ?? 'ทุกคลัง'} · {fq(l.qty)} {l.unitName} · ทุน {fmt(l.oldCost)} → <b>{fmt(l.newCost)}</b></div>
                  ))}</td>
                  <td className="n" style={{ color: d(change).lt(0) ? 'var(--bad)' : undefined }}>{d(change).gt(0) ? '+' : ''}{fmt(change)}</td>
                  <td className="small">{x.reason}{x.decideNote && <div className="muted">ผู้อนุมัติ: {x.decideNote}</div>}</td>
                  <td><Pill k={ST[x.status][1]}>{ST[x.status][0]}</Pill>{x.decidedBy && <div className="small muted">{x.decidedBy}</div>}</td>
                  <td>{x.status === 'pending' && canApprove && (
                    <span className="row" style={{ flexWrap: 'nowrap' }}>
                      <button className="btn sm pri" disabled={!!busy || !enabled} onClick={() => void decide(x, true)} data-testid={`ca-approve-${x.no}`}>อนุมัติ</button>
                      <button className="btn sm bad" disabled={!!busy} onClick={() => void decide(x, false)}>ไม่อนุมัติ</button>
                    </span>
                  )}</td>
                </tr>
              );
            })}
            {!r.isLoading && !r.rows.length && <tr><td colSpan={7} className="empty">ยังไม่มีคำขอปรับปรุงต้นทุน</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!r.hasNextPage} loading={r.isFetchingNextPage} onMore={() => void r.fetchNextPage()} count={r.rows.length} testId="ca-more" />
      <p className="small muted" style={{ margin: '8px 0 0' }}>อนุมัติแล้วระบบเปลี่ยนทุนของล็อตที่ยังเหลืออยู่ทุกล็อตเป็นทุนใหม่ ปรับทุนเฉลี่ยสินค้า และบันทึกในสมุดคุมสต็อก (จำนวน 0 · มูลค่าเปลี่ยน) ผู้ขออนุมัติคำขอของตัวเองไม่ได้ ยกเว้นเจ้าของร้าน</p>
      {form && <CostAdjModal onClose={() => setForm(false)} onDone={(no) => { setForm(false); toast(`ส่งคำขอ ${no} รออนุมัติ`); void refresh(); }} />}
    </>
  );
}

interface Line { productId: string; warehouseId: string; newCost: string }

function LineRow({ l, onChange, onRemove }: { l: Line; onChange: (l: Line) => void; onRemove: () => void }) {
  const whs = useAllWarehouses();
  const pre = useQuery({
    queryKey: ['pu', 'cost-preview', l.productId, l.warehouseId], enabled: !!l.productId,
    queryFn: () => api('GET', '/api/stock/cost-adjustments/preview', { query: { productId: l.productId, warehouseId: l.warehouseId || undefined }, schema: CostAdjPreview }),
  });
  const p = pre.data;
  const change = p && /^\d+(\.\d+)?$/.test(l.newCost) ? d(l.newCost).minus(d(p.avgCost)).times(d(p.qty)) : null;
  return (
    <tr>
      <td style={{ minWidth: 220 }}><ProductPicker value={l.productId || null} onChange={(id) => onChange({ ...l, productId: id ?? '' })} filter={isStock} showStock={false} testId="ca-product" ariaLabel="สินค้า" /></td>
      <td><select value={l.warehouseId} onChange={(e) => onChange({ ...l, warehouseId: e.target.value })} aria-label="คลัง" data-testid="ca-wh"><option value="">ทุกคลัง</option>{(whs.data ?? []).filter((w) => w.active).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></td>
      <td className="n">{p ? fq(p.qty) : '-'}</td>
      <td className="n">{p ? fmt(p.avgCost) : '-'}</td>
      <td className="n"><input className="pu-qty-in" type="text" inputMode="decimal" value={l.newCost} onChange={(e) => onChange({ ...l, newCost: e.target.value })} aria-label="ทุนใหม่ต่อหน่วย" data-testid="ca-cost" /></td>
      <td className="n" style={{ color: change?.lt(0) ? 'var(--bad)' : undefined }}>{change ? fmt(change.toFixed(2)) : '-'}</td>
      <td><button className="btn sm" onClick={onRemove} aria-label="ลบรายการ">×</button></td>
    </tr>
  );
}

function CostAdjModal({ onClose, onDone }: { onClose: () => void; onDone: (no: string) => void }) {
  const cat = useCatalog();
  const [lines, setLines] = useState<Line[]>([{ productId: '', warehouseId: '', newCost: '' }]);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = lines.filter((l) => l.productId && /^\d+(\.\d+)?$/.test(l.newCost));
  const save = async () => {
    if (!ready.length) return setErr('เลือกสินค้าและใส่ทุนใหม่อย่างน้อย 1 รายการ');
    if (!reason.trim()) return setErr('ระบุเหตุผล');
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/stock/cost-adjustments', { body: { lines: ready.map((l) => ({ productId: l.productId, warehouseId: l.warehouseId || null, newCost: l.newCost })), reason }, schema: CostAdj });
      onDone(r.no);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} wide label="ขอปรับปรุงต้นทุน">
      <h3>ขอปรับปรุงต้นทุนสินค้าคงเหลือ</h3>
      <div className="tw">
        <table>
          <thead><tr><th>สินค้า</th><th>คลัง</th><th className="n">คงเหลือ</th><th className="n">ทุนเฉลี่ยตอนนี้</th><th className="n">ทุนใหม่/หน่วย</th><th className="n">มูลค่าเปลี่ยน</th><th /></tr></thead>
          <tbody>{lines.map((l, i) => (
            <LineRow key={i} l={l} onChange={(n) => setLines(lines.map((x, k) => (k === i ? n : x)))} onRemove={() => setLines(lines.length > 1 ? lines.filter((_, k) => k !== i) : lines)} />
          ))}</tbody>
        </table>
      </div>
      <button className="btn sm" onClick={() => setLines([...lines, { productId: '', warehouseId: '', newCost: '' }])}>+ เพิ่มรายการ</button>
      <label className="f" style={{ marginTop: 10 }}>เหตุผล *<input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="เช่น ใบแจ้งหนี้ผู้ขายแจ้งราคาทุนจริงต่างจากที่รับเข้า" data-testid="ca-reason" /></label>
      {cat.data && <p className="small muted">ทุนต่อหน่วยหลัก ก่อน VAT</p>}
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={busy} onClick={() => void save()} data-testid="ca-save">ส่งคำขอให้อนุมัติ</button></div>
    </Modal>
  );
}
