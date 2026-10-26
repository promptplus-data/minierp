/** M03 products: cursor-paged table (NFR-12: 20 per page), search, create / edit modal. */
import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Product } from '@erp/contracts';
import { d } from '@erp/core';
import { api, errText } from '../api';
import { useAuth } from '../auth';
import { productPage } from '../data';
import { fmt, Modal, Pager, Pill, SkeletonRows, useCursorPager, useDebounced, useToast } from '../ui';

const PAGE = 20;

export default function Products() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const pager = useCursorPager(dq);
  const [edit, setEdit] = useState<Product | 'new' | null>(null);
  const seeCost = can('data.cost') === 1;
  const canEdit = can('data.master') === 1;

  const list = useQuery({
    queryKey: ['products', dq, pager.cursor],
    queryFn: () => api('GET', '/api/products', { query: { q: dq, limit: PAGE, cursor: pager.cursor, all: true }, schema: productPage }),
    placeholderData: keepPreviousData,
  });
  const showSkeleton = list.isLoading || (list.isFetching && list.isPlaceholderData);
  const cols = seeCost ? 10 : 9;

  return (
    <div className="card">
      <h2>
        สินค้าและหน่วยนับ
        <span className="row">
          {!canEdit && <Pill k="acc">ดูอย่างเดียว</Pill>}
          {canEdit && <button className="btn sm pri" onClick={() => setEdit('new')}>+ เพิ่มสินค้า</button>}
        </span>
      </h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <input type="search" placeholder="ค้นหาชื่อสินค้า รหัส หรือบาร์โค้ด" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 200 }} aria-label="ค้นหาสินค้า" data-testid="product-search" />
      </div>
      {list.isError && <div className="note bad small">{errText(list.error)}</div>}
      <div className="tw">
        <table data-testid="product-table">
          <thead>
            <tr><th>รหัส</th><th>ชื่อสินค้า</th><th>หมวดหมู่</th><th>บาร์โค้ด</th><th>หน่วยนับ</th><th className="n">ราคาขาย</th>{seeCost && <th className="n">ต้นทุน</th>}<th>VAT ขาย</th><th>สถานะ</th><th /></tr>
          </thead>
          <tbody>
            {showSkeleton ? <SkeletonRows cols={cols} rows={8} /> : (list.data?.items ?? []).map((p) => (
              <tr key={p.id}>
                <td className="mono small">{p.sku}</td>
                <td>{p.name} {p.isScg && <Pill k="acc">SCG</Pill>} {p.kind === 'service' && <Pill k="mut">บริการ</Pill>}</td>
                <td className="small">{p.category}</td>
                <td className="mono small">{p.barcode || '-'}</td>
                <td className="small">{p.units.map((u) => u.name).join(' / ')}</td>
                <td className="n">{fmt(p.price)}</td>
                {seeCost && <td className="n">{p.cost != null ? fmt(p.cost) : '-'}</td>}
                <td className="small">{p.vat === 'v7' ? '7%' : 'ยกเว้น'}</td>
                <td>{p.active ? <Pill k="ok">ใช้งาน</Pill> : <Pill k="mut">ปิดใช้งาน</Pill>}</td>
                <td>{canEdit && <button className="btn sm" onClick={() => setEdit(p)}>แก้ไข</button>}</td>
              </tr>
            ))}
            {!showSkeleton && list.data && !list.data.items.length && <tr><td colSpan={cols} className="empty">ไม่พบสินค้า "{dq}" ลองค้นด้วยชื่ออื่น</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!list.data?.nextCursor} count={list.data?.items.length} loading={list.isFetching}
        onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor ?? null)} />
      {edit && <ProductModal product={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

interface UnitRow { name: string; factor: string; price: string }

function ProductModal({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState(() => ({
    sku: product?.sku ?? '', name: product?.name ?? '', category: product?.category ?? 'อื่น ๆ', barcode: product?.barcode ?? '',
    isScg: product?.isScg ?? false, kind: product?.kind ?? 'stock', vat: product?.vat ?? 'v7', price: product?.price ?? '0',
    reorderPoint: product?.reorderPoint ?? '0', active: product?.active ?? true,
  }));
  const [units, setUnits] = useState<UnitRow[]>(() => (product?.units ?? [{ name: 'ชิ้น', factor: '1' }]).map((u) => ({ name: u.name, factor: u.factor, price: u.price ?? '' })));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const num = (s: string) => /^\d+(\.\d+)?$/.test(s.trim());

  const save = async () => {
    if (!f.sku.trim() || !f.name.trim()) return setErr('กรอกรหัสและชื่อสินค้า');
    if (!num(f.price) || !num(f.reorderPoint)) return setErr('ราคาและจุดสั่งซื้อต้องเป็นตัวเลข');
    if (units.some((u) => !u.name.trim() || !num(u.factor) || d(u.factor).lte(0) || (u.price && !num(u.price)))) return setErr('หน่วยนับต้องมีชื่อ และตัวคูณมากกว่า 0');
    if (!d(units[0]!.factor).eq(1)) return setErr('หน่วยแรกต้องเป็นหน่วยหลัก (ตัวคูณ 1)');
    const body = {
      ...f, sku: f.sku.trim(), name: f.name.trim(), barcode: f.barcode.trim() || null, price: f.price.trim(), reorderPoint: f.reorderPoint.trim(),
      units: units.map((u) => ({ name: u.name.trim(), factor: u.factor.trim(), ...(u.price.trim() ? { price: u.price.trim() } : {}) })),
    };
    setBusy(true);
    setErr('');
    try {
      const saved = product
        ? await api('PATCH', `/api/products/${product.id}`, { body, schema: Product })
        : await api('POST', '/api/products', { body, schema: Product });
      await qc.invalidateQueries({ queryKey: ['products'] });
      await qc.invalidateQueries({ queryKey: ['catalog'] });
      toast(`${product ? 'บันทึก' : 'เพิ่ม'}สินค้า ${saved.sku} แล้ว`);
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} wide label="สินค้า">
      <h3>{product ? `แก้ไขสินค้า · ${product.sku}` : 'เพิ่มสินค้า'}</h3>
      <div className="fgrid">
        <label className="f">รหัสสินค้า (SKU)<input type="text" value={f.sku} onChange={(e) => set('sku', e.target.value)} data-testid="pf-sku" /></label>
        <label className="f">ชื่อสินค้า<input type="text" value={f.name} onChange={(e) => set('name', e.target.value)} data-testid="pf-name" /></label>
        <label className="f">หมวดหมู่<input type="text" value={f.category} onChange={(e) => set('category', e.target.value)} /></label>
        <label className="f">บาร์โค้ด<input type="text" value={f.barcode} onChange={(e) => set('barcode', e.target.value)} /></label>
        <label className="f">ประเภท<select value={f.kind} onChange={(e) => set('kind', e.target.value as 'stock' | 'service')}><option value="stock">สินค้า (นับสต็อก)</option><option value="service">บริการ (ไม่นับสต็อก)</option></select></label>
        <label className="f">VAT ขาย<select value={f.vat} onChange={(e) => set('vat', e.target.value as 'v7' | 'exempt')}><option value="v7">7%</option><option value="exempt">ยกเว้น / 0%</option></select></label>
        <label className="f">ราคาขาย / หน่วยหลัก (รวม VAT)<input type="text" inputMode="decimal" value={f.price} onChange={(e) => set('price', e.target.value)} data-testid="pf-price" /></label>
        <label className="f">จุดสั่งซื้อ (หน่วยหลัก)<input type="text" inputMode="decimal" value={f.reorderPoint} onChange={(e) => set('reorderPoint', e.target.value)} /></label>
      </div>
      <div className="row">
        <label className="row small"><input type="checkbox" checked={f.isScg} onChange={(e) => set('isScg', e.target.checked)} /> สินค้า SCG</label>
        <label className="row small"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> ใช้งาน</label>
      </div>
      <h4 className="sec">หน่วยนับ</h4>
      <div className="tw">
        <table>
          <thead><tr><th>หน่วย</th><th className="n">= หน่วยหลัก</th><th className="n">ราคาเฉพาะหน่วย (ไม่บังคับ)</th><th /></tr></thead>
          <tbody>
            {units.map((u, i) => (
              <tr key={i}>
                <td><input type="text" value={u.name} aria-label={`ชื่อหน่วย ${i + 1}`} onChange={(e) => setUnits((us) => us.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></td>
                <td className="n"><input className="qty" type="text" inputMode="decimal" value={u.factor} disabled={i === 0} aria-label={`ตัวคูณหน่วย ${i + 1}`} onChange={(e) => setUnits((us) => us.map((x, j) => (j === i ? { ...x, factor: e.target.value } : x)))} /></td>
                <td className="n"><input className="qty" type="text" inputMode="decimal" value={u.price} placeholder="-" style={{ width: 100 }} aria-label={`ราคาหน่วย ${i + 1}`} onChange={(e) => setUnits((us) => us.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} /></td>
                <td>{i > 0 && <button className="btn sm bad" onClick={() => setUnits((us) => us.filter((_, j) => j !== i))} aria-label="ลบหน่วย">✕</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row"><button className="btn sm" onClick={() => setUnits((us) => [...us, { name: '', factor: '1', price: '' }])}>+ เพิ่มหน่วย</button></div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act">
        <button className="btn" onClick={onClose}>ยกเลิก</button>
        <button className="btn pri" onClick={() => void save()} disabled={busy} data-testid="pf-save">บันทึก</button>
      </div>
    </Modal>
  );
}
