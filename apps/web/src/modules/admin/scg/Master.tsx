/**
 * REQ-M14-02 central SCG product master: SKU, name, units/factors, barcode, image, category, recommended retail and
 * wholesale prices with an effective date; push to shops (shops keep their own selling price edits).
 */
import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdmCentralProduct, AdmPush, AdmPushResult, page } from '@erp/contracts';
import { Modal, Pager, Pill, SkeletonRows, fmt, th, thTime, useCursorPager, useDebounced, useToast } from '../../../ui';
import { admErr, todayYmd } from '../common';
import { admApi, admCan, useAdm } from './admApi';
import { checkFields, requiredMsg } from '../../../errors';

const CATS = ['ปูนซีเมนต์', 'หลังคา', 'ผนัง', 'กาว/ยาแนว', 'ประปา', 'กระเบื้อง', 'สุขภัณฑ์', 'อื่น ๆ'];

export default function Master() {
  const { admin } = useAdm();
  const qc = useQueryClient();
  const toast = useToast();
  const write = admCan(admin, 'masterWrite');
  const [tab, setTab] = useState<'prod' | 'push'>('prod');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const pager = useCursorPager(dq);
  const list = useQuery({
    queryKey: ['scg', 'central', dq, pager.cursor], placeholderData: keepPreviousData,
    queryFn: () => admApi('GET', '/api/adm/central-products', { query: { q: dq, limit: 20, cursor: pager.cursor }, schema: page(AdmCentralProduct) }),
  });
  const [edit, setEdit] = useState<AdmCentralProduct | 'new' | null>(null);
  const [price, setPrice] = useState<AdmCentralProduct | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['scg', 'central'] }); void qc.invalidateQueries({ queryKey: ['scg', 'pushes'] }); };
  const push = async () => {
    if (!confirm('ส่งสินค้า SCG และราคาแนะนำที่มีผลวันนี้ให้ทุกร้าน? (ร้านที่แก้ราคาขายเองแล้วจะไม่ถูกทับ)')) return;
    setBusy(true);
    try {
      const r = await admApi('POST', '/api/adm/central-push', { body: {}, schema: AdmPushResult });
      toast(`ส่งให้ ${r.shops} ร้าน · สินค้า ${r.products} รายการ · สร้างใหม่ ${r.created} · อัปเดต ${r.updated} · ตั้งราคา ${r.priceApplied}`);
      refresh();
    } catch (e) {
      toast(admErr(e));
    } finally {
      setBusy(false);
    }
  };
  const loading = list.isLoading || (list.isFetching && list.isPlaceholderData);
  return (
    <div className="card">
      <div className="tabs" role="tablist">
        <button className={tab === 'prod' ? 'on' : ''} onClick={() => setTab('prod')}>สินค้าและราคา SCG</button>
        <button className={tab === 'push' ? 'on' : ''} onClick={() => setTab('push')}>ประวัติการส่งให้ร้าน</button>
      </div>
      {tab === 'prod' ? (
        <>
          <div className="adm-bar">
            <span className="small muted">สินค้า SCG ที่ร้านทุกร้านดึงไปใช้ · ร้านแก้ราคาขายของตัวเองได้ แต่แก้ข้อมูลหลัก (ชื่อ หน่วย บาร์โค้ด) ไม่ได้</span>
            {write && <span className="row"><button className="btn sm" disabled={busy} onClick={() => void push()} data-testid="central-push">ส่งให้ทุกร้าน</button><button className="btn sm pri" onClick={() => setEdit('new')} data-testid="central-new">+ เพิ่มสินค้า SCG</button></span>}
          </div>
          <input type="search" style={{ width: '100%', marginBottom: 10 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นรหัส ชื่อ หมวด หรือบาร์โค้ด" aria-label="ค้นหาสินค้า SCG" />
          <div className="tw">
            <table data-testid="central-table">
              <thead><tr><th>รหัส</th><th>ชื่อสินค้า</th><th>หมวด</th><th>หน่วยนับ</th><th>บาร์โค้ด</th><th className="n">ราคาแนะนำ ปลีก / ส่ง</th><th>ราคาถัดไป</th><th>สถานะ</th><th /></tr></thead>
              <tbody>
                {loading ? <SkeletonRows cols={9} /> : (list.data?.items ?? []).map((c) => (
                  <tr key={c.id} className={c.active ? '' : 'off'}>
                    <td className="mono small">{c.sku}</td><td>{c.name}</td><td className="small">{c.category}</td>
                    <td className="small">{c.units.map((u, i) => (i === 0 ? u.name : `${u.name} = ${u.factor} ${c.units[0]!.name}`)).join(' · ')}</td>
                    <td className="mono small">{c.barcode ?? '-'}</td>
                    <td className="n">{c.price ? <>{fmt(c.price.retail)} / {fmt(c.price.wholesale)}<div className="small muted">ตั้งแต่ {th(c.price.effectiveFrom)}</div></> : '-'}</td>
                    <td className="small">{c.nextPrice ? <>{fmt(c.nextPrice.retail)}<div className="muted">มีผล {th(c.nextPrice.effectiveFrom)}</div></> : '-'}</td>
                    <td>{c.active ? <Pill k="ok">ใช้งาน</Pill> : <Pill k="mut">เลิกใช้</Pill>}</td>
                    <td>{write && <div className="row"><button className="btn sm" onClick={() => setEdit(c)}>แก้ไข</button><button className="btn sm" onClick={() => setPrice(c)} data-testid={`central-price-${c.sku}`}>ตั้งราคา</button></div>}</td>
                  </tr>
                ))}
                {!loading && list.data && !list.data.items.length && <tr><td colSpan={9} className="empty">ไม่พบสินค้า</td></tr>}
              </tbody>
            </table>
          </div>
          <Pager page={pager.page} hasNext={!!list.data?.nextCursor} count={list.data?.items.length} loading={list.isFetching} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor ?? null)} />
        </>
      ) : <Pushes />}
      {edit && <EditModal c={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); refresh(); }} />}
      {price && <PriceModal c={price} onClose={() => setPrice(null)} onDone={() => { setPrice(null); refresh(); }} />}
    </div>
  );
}

function Pushes() {
  const pager = useCursorPager('p');
  const list = useQuery({
    queryKey: ['scg', 'pushes', pager.cursor], placeholderData: keepPreviousData,
    queryFn: () => admApi('GET', '/api/adm/central-push', { query: { limit: 20, cursor: pager.cursor }, schema: page(AdmPush) }),
  });
  return (
    <>
      <div className="tw" style={{ marginTop: 12 }}>
        <table>
          <thead><tr><th>เวลา</th><th>รายการ</th><th className="n">สินค้า</th><th className="n">ร้าน</th><th>ส่งให้</th><th>โดย</th></tr></thead>
          <tbody>
            {list.isLoading ? <SkeletonRows cols={6} rows={3} /> : (list.data?.items ?? []).map((p) => (
              <tr key={p.id}><td className="small">{thTime(p.at)}</td><td>{p.what}</td><td className="n">{p.products}</td><td className="n">{p.shops}</td><td className="small">{p.target}</td><td className="small">{p.by}</td></tr>
            ))}
            {list.data && !list.data.items.length && <tr><td colSpan={6} className="empty">ยังไม่เคยส่ง</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!list.data?.nextCursor} count={list.data?.items.length} loading={list.isFetching} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor ?? null)} />
    </>
  );
}

function EditModal({ c, onClose, onDone }: { c: AdmCentralProduct | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    sku: c?.sku ?? 'SCG-', name: c?.name ?? '', category: c?.category ?? CATS[0]!, barcode: c?.barcode ?? '', imageUrl: c?.imageUrl ?? '',
    vat: c?.vat ?? 'v7', active: c?.active ?? true, units: c?.units ?? [{ name: 'ถุง', factor: '1' }],
  });
  const [err, setErr] = useState('');
  const save = async () => {
    if (!checkFields({
      sku: requiredMsg(f.sku, 'รหัส SKU'), name: requiredMsg(f.name, 'ชื่อสินค้า'),
      ...Object.fromEntries(f.units.flatMap((u, i): [string, string | false][] => [[`units.${i}.name`, requiredMsg(u.name, 'ชื่อหน่วย')], [`units.${i}.factor`, !(Number(u.factor) > 0) && 'ตัวคูณต้องมากกว่า 0']])),
    })) return;
    const body = { ...f, sku: f.sku.trim(), name: f.name.trim(), barcode: f.barcode.trim() || null, imageUrl: f.imageUrl.trim() || null, units: f.units.map((u, i) => ({ name: u.name.trim(), factor: i === 0 ? '1' : u.factor })) };
    try {
      await (c ? admApi('PATCH', `/api/adm/central-products/${c.id}`, { body, schema: AdmCentralProduct }) : admApi('POST', '/api/adm/central-products', { body, schema: AdmCentralProduct }));
      toast(c ? 'บันทึกสินค้า SCG แล้ว · กด "ส่งให้ทุกร้าน" เพื่ออัปเดตร้าน' : 'เพิ่มสินค้า SCG แล้ว · ตั้งราคาแนะนำต่อได้');
      onDone();
    } catch (e) {
      setErr(admErr(e));
    }
  };
  return (
    <Modal onClose={onClose} wide label="สินค้า SCG">
      <h3>{c ? `แก้ไขสินค้า SCG · ${c.sku}` : 'เพิ่มสินค้า SCG (master กลาง)'}</h3>
      <div className="fgrid">
        <label className="f">รหัส SKU *<input type="text" name="sku" value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} data-testid="cp-sku" /></label>
        <label className="f">ชื่อสินค้า *<input type="text" name="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="cp-name" /></label>
        <label className="f">หมวด<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{[...new Set([...CATS, f.category])].map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="f">บาร์โค้ด<input type="text" name="barcode" value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value })} /></label>
        <label className="f">URL รูปสินค้า<input type="text" value={f.imageUrl} placeholder="https://" onChange={(e) => setF({ ...f, imageUrl: e.target.value })} /></label>
        <label className="f">ภาษีขาย<select value={f.vat} onChange={(e) => setF({ ...f, vat: e.target.value as 'v7' | 'exempt' })}><option value="v7">VAT 7%</option><option value="exempt">ยกเว้น VAT</option></select></label>
        <label className="row small"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> ใช้งาน</label>
      </div>
      <h4 className="sec">หน่วยนับและตัวแปลง (หน่วยแรก = หน่วยฐาน)</h4>
      {f.units.map((u, i) => (
        <div key={i} className="row">
          <input type="text" data-field={`units.${i}.name`} value={u.name} aria-label="ชื่อหน่วย" style={{ width: 120 }} onChange={(e) => setF({ ...f, units: f.units.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
          {i === 0 ? <span className="small muted">หน่วยฐาน</span> : <><span className="small">=</span><input type="number" min="0" data-field={`units.${i}.factor`} value={u.factor} aria-label="ตัวคูณ" style={{ width: 90 }} onChange={(e) => setF({ ...f, units: f.units.map((x, j) => (j === i ? { ...x, factor: e.target.value } : x)) })} /><span className="small">{f.units[0]!.name}</span><button className="btn sm bad" onClick={() => setF({ ...f, units: f.units.filter((_, j) => j !== i) })}>ลบ</button></>}
        </div>
      ))}
      <div><button className="btn sm" onClick={() => setF({ ...f, units: [...f.units, { name: '', factor: '1' }] })}>+ เพิ่มหน่วย</button></div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" onClick={() => void save()} data-testid="cp-save">บันทึก</button></div>
    </Modal>
  );
}

function PriceModal({ c, onClose, onDone }: { c: AdmCentralProduct; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ retail: c.nextPrice?.retail ?? c.price?.retail ?? '', wholesale: c.nextPrice?.wholesale ?? c.price?.wholesale ?? '', effectiveFrom: todayYmd() });
  const [err, setErr] = useState('');
  const save = async () => {
    try {
      await admApi('POST', `/api/adm/central-products/${c.id}/prices`, { body: f, schema: AdmCentralProduct });
      toast(`ตั้งราคาแนะนำ ${c.sku} มีผล ${th(f.effectiveFrom)} แล้ว`);
      onDone();
    } catch (e) {
      setErr(admErr(e));
    }
  };
  return (
    <Modal onClose={onClose} label="ราคาแนะนำ">
      <h3>ราคาแนะนำ · {c.name}</h3>
      <div className="fgrid">
        <label className="f">ขายปลีก (บาท/{c.units[0]?.name})<input type="number" min="0" step="0.01" value={f.retail} onChange={(e) => setF({ ...f, retail: e.target.value })} data-testid="cp-retail" /></label>
        <label className="f">ขายส่ง<input type="number" min="0" step="0.01" value={f.wholesale} onChange={(e) => setF({ ...f, wholesale: e.target.value })} /></label>
        <label className="f">มีผลตั้งแต่<input type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></label>
      </div>
      <p className="small muted" style={{ margin: 0 }}>ราคาที่มีผลในอนาคตจะใช้เมื่อถึงวันที่กำหนดและส่งให้ร้านรอบถัดไป · ร้านที่แก้ราคาขายเองแล้วไม่ถูกทับ</p>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" onClick={() => void save()} data-testid="cp-price-save">บันทึก</button></div>
    </Modal>
  );
}
