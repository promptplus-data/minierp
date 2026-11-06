/** M15 shop promotions (mockup VIEWS.promo / promoModal): list, create / edit, close early, P&L per promo. */
import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Promo, PromoCheck, PromoPnl, page, type PromoInput } from '@erp/contracts';
import { PROMO_STATE_TH, addDays, d, type PromoState } from '@erp/core';
import { ApiFail, api, errText } from '../../api';
import { useAuth } from '../../auth';
import { useCatalog, useMeta } from '../../data';
import { ApprovalModal, fmt, fq, Modal, Pager, Pill, SkeletonRows, th, useCursorPager, useDebounced, useToast, type ApprovalInput, type PillKind } from '../../ui';
import './retail.css';
import { ErrorBanner } from '../../errors';

const STATES: [PromoState | '', string][] = [['', 'ทั้งหมด'], ['live', 'กำลังใช้'], ['scheduled', 'ยังไม่เริ่ม'], ['draft', 'ร่าง'], ['expired', 'หมดอายุ'], ['closed', 'ปิดแล้ว']];
const STATE_PILL: Record<PromoState, PillKind> = { live: 'ok', scheduled: 'acc', draft: 'warn', expired: 'mut', closed: 'mut' };
const MODE_TH = { pct: 'ลด %', amt: 'ลดบาทต่อหน่วยหลัก', fixed: 'ตั้งราคาโปรต่อหน่วยหลัก' } as const;
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;

export const promoDesc = (p: Promo) =>
  p.kind === 'bundle' ? `ราคาชุด ${fmt(p.setPrice)} (ปกติ ${fmt(p.normalSetPrice)})` : p.mode === 'pct' ? `ลด ${fq(p.value)}%` : p.mode === 'amt' ? `ลด ${fmt(p.value)} บาท/หน่วยหลัก` : `ราคาโปร ${fmt(p.value)}`;

export default function Promos() {
  const [tab, setTab] = useState<'list' | 'pnl'>('list');
  return (
    <div className="card">
      <div className="tabs" role="tablist">
        <button className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>โปรโมชั่นของร้าน</button>
        <button className={tab === 'pnl' ? 'on' : ''} onClick={() => setTab('pnl')} data-testid="tab-pnl">กำไรต่อโปร</button>
      </div>
      {tab === 'list' ? <PromoList /> : <PromoPnlView />}
    </div>
  );
}

function PromoList() {
  const { can } = useAuth();
  const manage = can('promo.manage') === 1;
  const seeCost = can('data.cost') === 1;
  const qc = useQueryClient();
  const toast = useToast();
  const [state, setState] = useState<PromoState | ''>('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const pager = useCursorPager(`${state}|${dq}`);
  const [edit, setEdit] = useState<Promo | 'new' | null>(null);
  const [closing, setClosing] = useState<Promo | null>(null);
  const list = useQuery({
    queryKey: ['promos', state, dq, pager.cursor],
    queryFn: () => api('GET', '/api/promos', { query: { state, q: dq, limit: 20, cursor: pager.cursor }, schema: page(Promo) }),
    placeholderData: keepPreviousData,
  });
  const loading = list.isLoading || (list.isFetching && list.isPlaceholderData);
  const done = (msg: string) => { void qc.invalidateQueries({ queryKey: ['promos'] }); void qc.invalidateQueries({ queryKey: ['pos-pricing'] }); toast(msg); };

  return (
    <>
      <div className="rt-head" style={{ marginTop: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>โปรโมชั่นของร้าน {!manage && <Pill k="acc">ดูอย่างเดียว</Pill>}</h2>
          <p className="small muted">ร้านตั้งโปรเองได้ 2 แบบ: <b>ลดราคา</b> (ลดเป็น % บาทต่อหน่วย หรือตั้งราคาโปร ใช้อัตโนมัติเมื่อสแกนสินค้าที่ร่วมรายการ) และ <b>ชุดโปร (bundle)</b> ขายหลายสินค้าในราคาเดียว ระบบตัดสต็อกทุกชิ้นในชุดและคิดต้นทุนจริงของแต่ละชิ้น (FIFO) · โปรนี้แยกจากคูปอง SCG Family</p>
        </div>
        <button className="btn pri" disabled={!manage} onClick={() => setEdit('new')} data-testid="promo-new">+ สร้างโปรโมชั่น</button>
      </div>
      <div className="rt-filters">
        <div className="steps">
          {STATES.map(([k, l]) => <span key={k} role="button" tabIndex={0} className={state === k ? 'on' : ''} onClick={() => setState(k)} onKeyDown={(e) => { if (e.key === 'Enter') setState(k); }}>{l}</span>)}
        </div>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นรหัส ชื่อโปร หรือ SKU ชุดโปร" aria-label="ค้นหาโปรโมชั่น" />
      </div>
      {list.isError && <ErrorBanner error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
      <div className="tw">
        <table data-testid="promo-table">
          <thead><tr><th>รหัส</th><th>ชื่อโปร</th><th>แบบ</th><th>สินค้าที่ร่วม</th><th>ระยะเวลา</th><th>สถานะ</th><th className="n">ขายแล้ว</th><th className="n">ยอดขาย</th><th /></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={9} /> : (list.data?.items ?? []).map((p) => (
              <tr key={p.id}>
                <td className="mono small">{p.code}</td>
                <td>{p.name}<div className="rt-desc">โดย {p.createdBy} · {th(p.createdAt.slice(0, 10))}{p.updatedAt ? ` · แก้ล่าสุด ${p.updatedBy}` : ''}</div>{p.belowCost && <div><Pill k="warn">ต่ำกว่าทุน · {p.belowCostBy ?? 'เจ้าของ'} ยืนยัน</Pill></div>}{p.channels.includes('b2b') && <div className="rt-desc">ช่องทาง {p.channels.map((c) => (c === 'pos' ? 'หน้าร้าน' : 'B2B')).join(' / ')}</div>}</td>
                <td>{p.kind === 'bundle' ? <Pill k="ok">ชุดโปร</Pill> : <Pill k="acc">ลดราคา</Pill>}<div className="rt-desc">{promoDesc(p)}</div></td>
                <td className="small rt-items">{p.lines.map((l) => <div key={l.productId}>{l.name}{l.qtyPerSet ? ` × ${fq(l.qtyPerSet)}` : ''}</div>)}{p.kind === 'bundle' && p.setsAvailable != null && <div className="rt-desc">จัดได้ {p.setsAvailable} ชุด</div>}</td>
                <td className="small">{th(p.start)} – {th(p.end)}<div className="muted">{days(p.start, p.end)} วัน</div></td>
                <td><Pill k={STATE_PILL[p.state]}>{PROMO_STATE_TH[p.state]}</Pill>{p.closedAt && <div className="rt-desc">ปิดโดย {p.closedBy}</div>}</td>
                <td className="n">{fq(p.stats.qty)}<div className="small muted">{p.stats.bills} บิล</div></td>
                <td className="n">{fmt(p.stats.sales)}</td>
                <td>{manage && p.status !== 'closed' && (
                  <div className="rt-actions">
                    <button className="btn sm" onClick={() => setEdit(p)}>แก้ไข</button>
                    {p.status === 'draft' ? <ActivateButton p={p} onDone={done} /> : <button className="btn sm bad" onClick={() => setClosing(p)} data-testid={`promo-close-${p.code}`}>ปิดโปร</button>}
                  </div>
                )}</td>
              </tr>
            ))}
            {!loading && list.data && !list.data.items.length && <tr><td colSpan={9} className="empty">ยังไม่มีโปรโมชั่น{state ? 'ในสถานะนี้' : ''}</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!list.data?.nextCursor} count={list.data?.items.length} loading={list.isFetching} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor ?? null)} />
      <p className="small muted">ยอดขายนับจากบิลที่ไม่ถูกยกเลิก หักรับคืน{seeCost ? ' · กำไรดูที่แท็บ "กำไรต่อโปร"' : ''} · ปิดโปรแล้วมีผลทันทีกับบิลใหม่ บิลที่ออกไปแล้วไม่เปลี่ยน</p>
      {edit && <PromoModal promo={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={(p) => { setEdit(null); done(`บันทึกโปร ${p.code} แล้ว`); }} />}
      {closing && <CloseModal p={closing} onClose={() => setClosing(null)} onDone={(p) => { setClosing(null); done(`ปิดโปร ${p.code} แล้ว`); }} />}
    </>
  );
}

function ActivateButton({ p, onDone }: { p: Promo; onDone: (msg: string) => void }) {
  const toast = useToast();
  const [apv, setApv] = useState(false);
  const go = async (approval?: ApprovalInput): Promise<string | null> => {
    try {
      await api('POST', `/api/promos/${p.id}/activate`, { body: approval ? { belowCostApproval: approval } : {}, schema: Promo });
      setApv(false);
      onDone(`เปิดใช้โปร ${p.code} แล้ว`);
      return null;
    } catch (e) {
      if (e instanceof ApiFail && e.code === 'BELOW_COST') {
        e.claim();
        if (approval && e.detail('approvalError')) return e.message;
        setApv(true);
        return null;
      }
      toast(errText(e));
      return null;
    }
  };
  return (
    <>
      <button className="btn sm pri" onClick={() => void go()}>เปิดใช้</button>
      {apv && <ApprovalModal ownerOnly title="โปรต่ำกว่าต้นทุน · ต้องให้เจ้าของร้านยืนยัน" label={<p style={{ margin: 0 }}>โปร "{p.name}" ทำให้ขายต่ำกว่าทุน</p>} onClose={() => setApv(false)} onSubmit={go} />}
    </>
  );
}

function CloseModal({ p, onClose, onDone }: { p: Promo; onClose: () => void; onDone: (p: Promo) => void }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      onDone(await api('POST', `/api/promos/${p.id}/close`, { body: { reason: reason.trim() || undefined }, schema: Promo }));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="ปิดโปรก่อนกำหนด">
      <h3>ปิดโปร {p.code} ก่อนกำหนด</h3>
      <p style={{ margin: 0 }}>{p.name} · ถึง {th(p.end)}</p>
      <div className="note small">ปิดแล้วมีผลทันทีกับบิลใหม่ บิลที่ออกไปแล้วไม่เปลี่ยน · ระบบบันทึกผู้ปิดและเวลาในประวัติการทำรายการ · เปิดซ้ำไม่ได้ ต้องสร้างโปรใหม่</div>
      <label className="f">เหตุผล (ถ้ามี)<input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="เช่น ของหมดก่อนกำหนด" /></label>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn bad" disabled={busy} onClick={() => void go()} data-testid="promo-close-ok">ปิดโปร</button></div>
    </Modal>
  );
}

// ---------- create / edit ----------

interface Form {
  name: string; kind: 'disc' | 'bundle'; mode: 'pct' | 'amt' | 'fixed'; value: string; setPrice: string; sku: string;
  items: string[]; comps: { productId: string; qty: string }[]; start: string; end: string; pos: boolean; b2b: boolean; draft: boolean;
}

function PromoModal({ promo, onClose, onSaved }: { promo: Promo | null; onClose: () => void; onSaved: (p: Promo) => void }) {
  const { can } = useAuth();
  const seeCost = can('data.cost') === 1;
  const meta = useMeta();
  const vat = meta.data?.shop.vatRegistered ?? true;
  const cat = useCatalog();
  const stockProducts = (cat.data ?? []).filter((p) => p.active);
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState<Form>(() => promo ? {
    name: promo.name, kind: promo.kind, mode: promo.mode ?? 'pct', value: promo.value ?? '', setPrice: promo.setPrice ?? '', sku: promo.sku ?? '',
    items: promo.kind === 'disc' ? promo.lines.map((l) => l.productId) : [], comps: promo.kind === 'bundle' ? promo.lines.map((l) => ({ productId: l.productId, qty: l.qtyPerSet ?? '1' })) : [],
    start: promo.start, end: promo.end, pos: promo.channels.includes('pos'), b2b: promo.channels.includes('b2b'), draft: promo.status === 'draft',
  } : { name: '', kind: 'disc', mode: 'pct', value: '5', setPrice: '', sku: '', items: [], comps: [], start: today, end: addDays(today, 30), pos: true, b2b: false, draft: false });
  const [pick, setPick] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [apv, setApv] = useState(false);
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));
  useEffect(() => {
    if (f.kind === 'bundle' && !f.comps.length && stockProducts.length >= 2) set({ comps: [{ productId: stockProducts[0]!.id, qty: '1' }, { productId: stockProducts[1]!.id, qty: '1' }] });
  }, [f.kind, stockProducts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = (): PromoInput => ({
    name: f.name.trim(), kind: f.kind, start: f.start, end: f.end, draft: f.draft,
    channels: [...(f.pos ? ['pos' as const] : []), ...(f.b2b ? ['b2b' as const] : [])],
    ...(f.kind === 'disc'
      ? { mode: f.mode, value: f.value.trim() || '0', items: f.items.map((productId) => ({ productId })) }
      : { setPrice: f.setPrice.trim() || '0', ...(f.sku.trim() ? { sku: f.sku.trim() } : {}), items: f.comps.map((c) => ({ productId: c.productId, qtyPerSet: c.qty.trim() || '0' })) }),
  });
  const ready = f.name.trim() && (f.pos || f.b2b) && (f.kind === 'disc' ? f.items.length > 0 && /^\d+(\.\d+)?$/.test(f.value) : f.comps.length > 0 && /^\d+(\.\d+)?$/.test(f.setPrice));
  const key = JSON.stringify(body());
  const dkey = useDebounced(key, 350);
  const check = useQuery({
    queryKey: ['promo-check', dkey],
    enabled: !!ready,
    queryFn: () => api('POST', '/api/promos/check', { body: JSON.parse(dkey), schema: PromoCheck, silent: true }),
    retry: false,
  });
  const ck = check.data;
  const clash = (ck?.clashes ?? []).filter((c) => c.code !== promo?.code);

  const save = async (approval?: ApprovalInput): Promise<string | null> => {
    setBusy(true);
    setErr('');
    try {
      const b = { ...body(), ...(approval ? { belowCostApproval: approval } : {}) };
      const out = promo
        ? await api('PATCH', `/api/promos/${promo.id}`, { body: (({ kind: _k, ...rest }) => rest)(b), schema: Promo })
        : await api('POST', '/api/promos', { body: b, schema: Promo });
      setApv(false);
      onSaved(out);
      return null;
    } catch (e) {
      if (e instanceof ApiFail && e.code === 'BELOW_COST') {
        e.claim();
        if (approval && e.detail('approvalError')) return e.message;
        setApv(true);
        return null;
      }
      setErr(errText(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const filtered = stockProducts.filter((p) => !pick.trim() || p.name.toLowerCase().includes(pick.trim().toLowerCase()) || p.sku.toLowerCase().includes(pick.trim().toLowerCase()));
  const normal = ck?.normalSetPrice ?? null;
  const setEx = f.setPrice && vat ? d(f.setPrice).div('1.07') : d(f.setPrice || 0);

  return (
    <Modal onClose={onClose} wide label={promo ? 'แก้ไขโปร' : 'สร้างโปรโมชั่น'}>
      <h3>{promo ? `แก้ไขโปร ${promo.code}` : 'สร้างโปรโมชั่น'}</h3>
      <div className="fgrid">
        <label className="f rt-span2">ชื่อโปร *<input type="text" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="เช่น ท่อ PVC ลด 5% ต้อนรับหน้าฝน" data-testid="pm-name" /></label>
        <label className="f">แบบโปร
          <select value={f.kind} disabled={!!promo} onChange={(e) => set({ kind: e.target.value as Form['kind'] })} data-testid="pm-kind">
            <option value="disc">ลดราคาสินค้า</option><option value="bundle">ชุดโปร (bundle)</option>
          </select>
        </label>
        <label className="f">เริ่ม<input type="date" value={f.start} onChange={(e) => set({ start: e.target.value })} /></label>
        <label className="f">สิ้นสุด<input type="date" value={f.end} onChange={(e) => set({ end: e.target.value })} /></label>
        <div><div className="small muted">ช่องทาง</div>
          <label className="row small"><input type="checkbox" checked={f.pos} onChange={(e) => set({ pos: e.target.checked })} /> หน้าร้าน (POS)</label>
          <label className="row small"><input type="checkbox" checked={f.b2b} onChange={(e) => set({ b2b: e.target.checked })} /> ขายส่ง (B2B)</label>
        </div>
        <div><div className="small muted">ผู้สร้าง</div><b>{promo ? promo.createdBy : 'บันทึกอัตโนมัติจากผู้ใช้ที่เข้าระบบ'}</b>{promo && <div className="small muted">สร้าง {th(promo.createdAt.slice(0, 10))}</div>}</div>
      </div>

      {f.kind === 'disc' ? (
        <>
          <div className="fgrid">
            <label className="f">ลดแบบ<select value={f.mode} onChange={(e) => set({ mode: e.target.value as Form['mode'] })} data-testid="pm-mode">{Object.entries(MODE_TH).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="f">{f.mode === 'pct' ? 'ลด (%)' : f.mode === 'amt' ? 'ลด (บาท ต่อหน่วยหลัก)' : `ราคาโปร (บาท ต่อหน่วยหลัก${vat ? ' รวม VAT' : ''})`}<input type="text" inputMode="decimal" value={f.value} onChange={(e) => set({ value: e.target.value })} data-testid="pm-value" /></label>
          </div>
          <div className="small muted">สินค้าที่ร่วมโปร (เลือกได้หลายรายการ) · เลือกแล้ว {f.items.length} รายการ</div>
          <input type="search" value={pick} onChange={(e) => setPick(e.target.value)} placeholder="ค้นชื่อหรือรหัสสินค้า" aria-label="ค้นสินค้าที่ร่วมโปร" />
          <div className="rt-pick">
            {filtered.map((p) => {
              const on = f.items.includes(p.id);
              return <label key={p.id} className={on ? 'on' : ''}><input type="checkbox" checked={on} onChange={() => set({ items: on ? f.items.filter((x) => x !== p.id) : [...f.items, p.id] })} /> {p.name}</label>;
            })}
          </div>
        </>
      ) : (
        <>
          <div className="tw">
            <table className="rt-comps rt-mt">
              <thead><tr><th>สินค้าในชุด</th><th className="n">จำนวนต่อชุด (หน่วยหลัก)</th><th /></tr></thead>
              <tbody>
                {f.comps.map((c, i) => (
                  <tr key={i}>
                    <td><select value={c.productId} aria-label={`สินค้าในชุด ${i + 1}`} onChange={(e) => set({ comps: f.comps.map((y, j) => (j === i ? { ...y, productId: e.target.value } : y)) })}>
                      {stockProducts.filter((p) => p.kind === 'stock').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select></td>
                    <td className="n"><input className="qty" type="text" inputMode="decimal" value={c.qty} aria-label={`จำนวนต่อชุด ${i + 1}`} onChange={(e) => set({ comps: f.comps.map((y, j) => (j === i ? { ...y, qty: e.target.value } : y)) })} /> {cat.byId.get(c.productId)?.units[0]?.name}</td>
                    <td>{f.comps.length > 1 && <button className="btn sm bad" onClick={() => set({ comps: f.comps.filter((_, j) => j !== i) })} aria-label="ลบสินค้าในชุด">✕</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row"><button className="btn sm" onClick={() => set({ comps: [...f.comps, { productId: stockProducts.find((p) => !f.comps.some((c) => c.productId === p.id))?.id ?? stockProducts[0]!.id, qty: '1' }] })}>+ เพิ่มสินค้าในชุด</button></div>
          <div className="fgrid">
            <label className="f">ราคาขายทั้งชุด{vat ? ' (รวม VAT)' : ''}<input type="text" inputMode="decimal" value={f.setPrice} onChange={(e) => set({ setPrice: e.target.value })} data-testid="pm-setprice" /></label>
            <label className="f">SKU ชุดโปร (ถ้ามี)<input type="text" value={f.sku} onChange={(e) => set({ sku: e.target.value })} placeholder="เช่น BD-WALL100" /></label>
            <div><div className="small muted">ราคาปกติรวม</div><b>{normal ? fmt(normal) : '-'}</b>{normal && f.setPrice && <span className="small" style={{ color: 'var(--ok)' }}> ลูกค้าประหยัด {fmt(d(normal).minus(d(f.setPrice)))}</span>}</div>
            {seeCost && ck?.setCost && <div><div className="small muted">ทุนรวมทั้งชุด · กำไรต่อชุด (ก่อน VAT)</div><b>{fmt(ck.setCost)}</b> · <b style={{ color: setEx.lt(d(ck.setCost)) ? 'var(--bad)' : 'var(--ok)' }}>{fmt(setEx.minus(d(ck.setCost)))}</b></div>}
          </div>
          <div className="note small">ตอนขาย ระบบตัดสต็อกทุกชิ้นในชุดจากคลังขายหน้าร้าน ต้นทุนขาย = ทุนจริงของแต่ละชิ้นตามล็อต และแบ่งรายได้ของชุดให้แต่ละสินค้าตามสัดส่วนราคาปกติ เศษสตางค์ลงบรรทัดสุดท้าย (BR-17)</div>
        </>
      )}

      {ck && f.kind === 'disc' && ck.lines.length > 0 && (
        <div className="tw">
          <table>
            <thead><tr><th>สินค้า</th><th className="n">ราคาปกติ</th><th className="n">ราคาโปร</th>{seeCost && <><th className="n">ทุน (FIFO)</th><th /></>}</tr></thead>
            <tbody>{ck.lines.map((l) => (
              <tr key={l.productId}><td>{l.name}</td><td className="n">{fmt(l.normalPrice)}</td><td className="n">{fmt(l.promoPrice)}</td>
                {seeCost && <><td className="n">{l.unitCost ? fmt(l.unitCost) : '-'}</td><td>{l.belowCost && <Pill k="bad">ต่ำกว่าทุน</Pill>}</td></>}</tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {clash.length > 0 && !f.draft && <div className="note bad small">สินค้าซ้ำกับโปรที่ช่วงเวลาทับกัน: {clash.map((c) => `${c.code} ${c.name}`).join(', ')} · สินค้าหนึ่งอยู่ได้ในโปรลดราคาเดียวต่อช่วงเวลา</div>}
      {ck && ck.belowCost.length > 0 && <div className="note bad small" data-testid="pm-below">ราคาโปรต่ำกว่าต้นทุน: {ck.belowCost.join(', ')} · ต้องให้เจ้าของร้านอนุมัติตอนบันทึก หลังอนุมัติแล้วขายตามโปรได้โดยไม่ต้องขออนุมัติทุกบิล</div>}
      <label className="row small"><input type="checkbox" checked={f.draft} disabled={!!promo && promo.status !== 'draft'} onChange={(e) => set({ draft: e.target.checked })} /> บันทึกเป็นร่าง (ยังไม่ใช้กับบิล)</label>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act">
        <button className="btn" onClick={onClose}>ยกเลิก</button>
        <button className="btn pri" disabled={!ready || busy} onClick={() => void save()} data-testid="pm-save">{ck?.belowCost.length && !f.draft && can('sales.belowCost') !== 1 ? 'บันทึก (ขออนุมัติเจ้าของ)' : 'บันทึกโปร'}</button>
      </div>
      {apv && <ApprovalModal ownerOnly title="โปรต่ำกว่าต้นทุน · ต้องให้เจ้าของร้านยืนยัน" label={<p style={{ margin: 0 }}>{ck?.belowCost.join(', ')} ขายต่ำกว่าทุน ยืนยันครั้งเดียวตอนสร้างโปร</p>} onClose={() => setApv(false)} onSubmit={save} />}
    </Modal>
  );
}

// ---------- REQ-M15-05 P&L ----------

function PromoPnlView() {
  const { can } = useAuth();
  const seeCost = can('data.cost') === 1;
  const pnl = useQuery({ queryKey: ['promo-pnl'], queryFn: () => api('GET', '/api/promos/pnl', { schema: PromoPnl }) });
  return (
    <>
      <p className="small muted" style={{ margin: '12px 0' }}>ยอดขายและกำไรขั้นต้นของบิลที่ใช้โปร (หักรับคืน ไม่นับบิลยกเลิก) เทียบกับช่วงเวลาเท่ากันก่อนเริ่มโปรของสินค้าเดียวกัน · กำไร = ยอดก่อน VAT − ต้นทุนที่ตัดจริงตามล็อต</p>
      <div className="tw">
        <table data-testid="pnl-table">
          <thead><tr><th>โปร</th><th>ช่วง</th><th className="n">บิล</th><th className="n">ขายได้</th><th className="n">ยอดขาย</th><th className="n">ส่วนลดจากโปร</th>{seeCost && <><th className="n">ต้นทุน</th><th className="n">กำไรขั้นต้น</th><th className="n">ก่อนโปร (กำไร)</th></>}</tr></thead>
          <tbody>
            {pnl.isLoading ? <SkeletonRows cols={seeCost ? 9 : 6} /> : (pnl.data?.items ?? []).map((r) => (
              <tr key={r.promoId}>
                <td><span className="mono small">{r.code}</span> {r.name}<div className="rt-desc">{PROMO_STATE_TH[r.state]}</div></td>
                <td className="small">{th(r.start)} – {th(r.end)}</td>
                <td className="n">{r.bills}</td>
                <td className="n">{r.kind === 'bundle' ? `${fq(r.sets)} ชุด` : fq(r.qty)}</td>
                <td className="n">{fmt(r.sales)}</td>
                <td className="n">{fmt(r.discount)}</td>
                {seeCost && <><td className="n">{fmt(r.cogs)}</td><td className="n"><b>{fmt(r.grossProfit)}</b></td><td className="n small">{fmt(r.before.grossProfit)}<div className="muted">{th(r.before.from)} – {th(r.before.to)}</div></td></>}
              </tr>
            ))}
            {pnl.data && !pnl.data.items.length && <tr><td colSpan={9} className="empty">ยังไม่มีโปรที่ใช้งาน</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
