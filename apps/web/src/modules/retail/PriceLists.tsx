/** REQ-M03-07 / BR-05 price lists: per customer or customer group, quantity breaks, validity, VAT basis. */
import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { PriceList, page } from '@erp/contracts';
import { d } from '@erp/core';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { useCatalog, useCustomers } from '../../data';
import { fmt, fq, Modal, Pager, Pill, SkeletonRows, th, useCursorPager, useDebounced, useToast } from '../../ui';
import './retail.css';

export const GROUP_TH: Record<string, string> = { retail: 'ลูกค้าปลีก', whole: 'ร้านค้าส่ง', contr: 'ผู้รับเหมา' };
const isNum = (s: string) => /^\d+(\.\d+)?$/.test(s.trim());

export default function PriceLists() {
  const { can } = useAuth();
  const manage = can('data.master') === 1;
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const pager = useCursorPager(dq);
  const [edit, setEdit] = useState<string | 'new' | null>(null);
  const list = useQuery({
    queryKey: ['price-lists', dq, pager.cursor],
    queryFn: () => api('GET', '/api/price-lists', { query: { q: dq, limit: 20, cursor: pager.cursor }, schema: page(PriceList) }),
    placeholderData: keepPreviousData,
  });
  const loading = list.isLoading || (list.isFetching && list.isPlaceholderData);
  return (
    <div className="card">
      <div className="rt-head">
        <div>
          <h2 style={{ margin: 0 }}>ราคาตามลูกค้า (price list)</h2>
          <p className="small muted">ลำดับการเลือกราคา (BR-05): ราคาในใบเสนอราคาที่ยังไม่หมดอายุ → price list เฉพาะลูกค้า → price list กลุ่มลูกค้าตามช่วงจำนวน → ราคาปลีก · โปรโมชั่นที่ใช้งานอยู่ใช้แทนเมื่อถูกกว่า · POS เลือกราคาให้เองเมื่อเลือกลูกค้าในบิล</p>
        </div>
        <button className="btn pri" disabled={!manage} onClick={() => setEdit('new')} data-testid="pl-new">+ สร้าง price list</button>
      </div>
      <div className="rt-filters"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นชื่อ price list หรือลูกค้า" aria-label="ค้นหา price list" /></div>
      {list.isError && <div className="note bad small">{errText(list.error)}</div>}
      <div className="tw">
        <table data-testid="pl-table">
          <thead><tr><th>ชื่อ</th><th>ใช้กับ</th><th className="n">รายการ</th><th>ราคา</th><th>ช่วงเวลา</th><th>สถานะ</th><th>สร้างโดย</th><th /></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={8} /> : (list.data?.items ?? []).map((l) => (
              <tr key={l.id}>
                <td>{l.name}</td>
                <td>{l.customer ? <>ลูกค้า <b>{l.customer.name}</b></> : <>กลุ่ม <b>{GROUP_TH[l.customerGroup ?? ''] ?? l.customerGroup}</b></>}</td>
                <td className="n">{l.itemCount}</td>
                <td>{l.vatIncluded ? 'รวม VAT' : 'ไม่รวม VAT'}</td>
                <td className="small">{l.validFrom ? th(l.validFrom) : 'ไม่กำหนด'} – {l.validTo ? th(l.validTo) : 'ไม่กำหนด'}</td>
                <td>{l.active ? <Pill k="ok">ใช้งาน</Pill> : <Pill k="mut">ปิด</Pill>}</td>
                <td className="small">{l.createdBy}<div className="muted">{th(l.createdAt.slice(0, 10))}</div></td>
                <td><button className="btn sm" onClick={() => setEdit(l.id)}>{manage ? 'แก้ไข' : 'ดู'}</button></td>
              </tr>
            ))}
            {!loading && list.data && !list.data.items.length && <tr><td colSpan={8} className="empty">ยังไม่มี price list</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!list.data?.nextCursor} count={list.data?.items.length} loading={list.isFetching} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor ?? null)} />
      {edit && <PriceListModal id={edit === 'new' ? null : edit} readOnly={!manage} onClose={() => setEdit(null)} onSaved={(l) => {
        setEdit(null);
        void qc.invalidateQueries({ queryKey: ['price-lists'] });
        void qc.invalidateQueries({ queryKey: ['pos-pricing'] });
        toast(`บันทึก ${l.name} แล้ว`);
      }} />}
    </div>
  );
}

interface Row { productId: string; unitIdx: number; minQty: string; price: string }

function PriceListModal({ id, readOnly, onClose, onSaved }: { id: string | null; readOnly: boolean; onClose: () => void; onSaved: (l: PriceList) => void }) {
  const cat = useCatalog();
  const customers = useCustomers();
  const existing = useQuery({ queryKey: ['price-list', id], enabled: !!id, queryFn: () => api('GET', `/api/price-lists/${id}`, { schema: PriceList }) });
  const [form, setForm] = useState<null | { name: string; target: 'cust' | 'group'; customerId: string; group: string; vatIncluded: boolean; from: string; to: string; active: boolean; rows: Row[] }>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const products = (cat.data ?? []).filter((p) => p.active);
  const f = form ?? (id
    ? existing.data && {
      name: existing.data.name, target: existing.data.customer ? 'cust' as const : 'group' as const, customerId: existing.data.customer?.id ?? '', group: existing.data.customerGroup ?? 'contr',
      vatIncluded: existing.data.vatIncluded, from: existing.data.validFrom ?? '', to: existing.data.validTo ?? '', active: existing.data.active,
      rows: (existing.data.items ?? []).map((i) => ({ productId: i.productId, unitIdx: i.unitIdx, minQty: i.minQty, price: i.price })),
    }
    : { name: '', target: 'group' as const, customerId: '', group: 'contr', vatIncluded: true, from: '', to: '', active: true, rows: [] });
  if (!f) return <Modal onClose={onClose} label="price list"><div className="sk" /><div className="sk" /></Modal>;
  const set = (patch: Partial<typeof f>) => setForm({ ...f, ...patch });
  const setRow = (i: number, patch: Partial<Row>) => set({ rows: f.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const custId = f.customerId || customers.data?.find((c) => c.code !== 'C00000')?.id || '';
  const ok = f.name.trim() && f.rows.every((r) => isNum(r.price) && isNum(r.minQty || '0')) && (f.target === 'group' || !!custId);
  const save = async () => {
    setBusy(true);
    setErr('');
    const body = {
      name: f.name.trim(), customerId: f.target === 'cust' ? custId : null, customerGroup: f.target === 'group' ? f.group : null, vatIncluded: f.vatIncluded,
      validFrom: f.from || null, validTo: f.to || null, active: f.active, items: f.rows.map((r) => ({ productId: r.productId, unitIdx: r.unitIdx, minQty: r.minQty.trim() || '0', price: r.price.trim() })),
    };
    try {
      onSaved(id ? await api('PATCH', `/api/price-lists/${id}`, { body, schema: PriceList }) : await api('POST', '/api/price-lists', { body, schema: PriceList }));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} wide label="price list">
      <h3>{id ? `price list · ${f.name}` : 'สร้าง price list'}</h3>
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="fgrid">
          <label className="f rt-span2">ชื่อ *<input type="text" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="เช่น ราคาผู้รับเหมา 2569" data-testid="pl-name" /></label>
          <label className="f">ใช้กับ<select value={f.target} onChange={(e) => set({ target: e.target.value as 'cust' | 'group' })} data-testid="pl-target"><option value="group">กลุ่มลูกค้า</option><option value="cust">ลูกค้ารายนี้</option></select></label>
          {f.target === 'group'
            ? <label className="f">กลุ่มลูกค้า<select value={f.group} onChange={(e) => set({ group: e.target.value })}>{Object.entries(GROUP_TH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            : <label className="f">ลูกค้า<select value={custId} onChange={(e) => set({ customerId: e.target.value })}>{(customers.data ?? []).filter((c) => c.code !== 'C00000').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
          <label className="f">เริ่ม (ไม่บังคับ)<input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} /></label>
          <label className="f">สิ้นสุด (ไม่บังคับ)<input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} /></label>
          <div><div className="small muted">ราคาใน list</div>
            <label className="row small"><input type="radio" checked={f.vatIncluded} onChange={() => set({ vatIncluded: true })} /> รวม VAT</label>
            <label className="row small"><input type="radio" checked={!f.vatIncluded} onChange={() => set({ vatIncluded: false })} /> ไม่รวม VAT</label>
          </div>
          <label className="row small"><input type="checkbox" checked={f.active} onChange={(e) => set({ active: e.target.checked })} /> ใช้งาน</label>
        </div>
        <div className="tw">
          <table className="rt-mt">
            <thead><tr><th>สินค้า</th><th>หน่วย</th><th className="n">ซื้อตั้งแต่ (จำนวน)</th><th className="n">ราคา/หน่วย</th><th className="n">ราคาปลีก</th><th /></tr></thead>
            <tbody>
              {f.rows.map((r, i) => {
                const p = cat.byId.get(r.productId);
                const unit = p?.units[r.unitIdx];
                const retail = p && unit ? (unit.price != null ? d(unit.price) : d(p.price).times(d(unit.factor))) : null;
                return (
                  <tr key={i}>
                    <td><select value={r.productId} aria-label={`สินค้าแถว ${i + 1}`} onChange={(e) => setRow(i, { productId: e.target.value, unitIdx: 0 })}>{products.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></td>
                    <td><select value={r.unitIdx} aria-label={`หน่วยแถว ${i + 1}`} onChange={(e) => setRow(i, { unitIdx: Number(e.target.value) })}>{(p?.units ?? []).map((u, k) => <option key={k} value={k}>{u.name}</option>)}</select></td>
                    <td className="n"><input className="qty" type="text" inputMode="decimal" value={r.minQty} placeholder="0" aria-label={`ซื้อตั้งแต่ แถว ${i + 1}`} onChange={(e) => setRow(i, { minQty: e.target.value })} /></td>
                    <td className="n"><input className={`qty${isNum(r.price) ? '' : ' bad'}`} type="text" inputMode="decimal" value={r.price} aria-label={`ราคา แถว ${i + 1}`} onChange={(e) => setRow(i, { price: e.target.value })} /></td>
                    <td className="n">{retail ? fmt(retail) : '-'}{retail && isNum(r.price) && d(r.price).lt(retail) && <div className="small" style={{ color: 'var(--ok)' }}>ถูกกว่า {fq(retail.minus(d(r.price)).div(retail).times(100).toDecimalPlaces(1).toString())}%</div>}</td>
                    <td><button className="btn sm bad" aria-label="ลบแถว" onClick={() => set({ rows: f.rows.filter((_, j) => j !== i) })}>✕</button></td>
                  </tr>
                );
              })}
              {!f.rows.length && <tr><td colSpan={6} className="empty">ยังไม่มีรายการราคา</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="row"><button className="btn sm" onClick={() => set({ rows: [...f.rows, { productId: products[0]?.id ?? '', unitIdx: 0, minQty: '0', price: '' }] })} data-testid="pl-add">+ เพิ่มรายการราคา</button></div>
      </fieldset>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ปิด</button>{!readOnly && <button className="btn pri" disabled={!ok || busy} onClick={() => void save()} data-testid="pl-save">บันทึก</button>}</div>
    </Modal>
  );
}
