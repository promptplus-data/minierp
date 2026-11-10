/** REQ-M07-11 product photos for the POS tiles: the shop uploads photos of its own (non-SCG) products. */
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PRODUCT_IMAGE_MAX_BYTES, ProductImageInfo, page, Product } from '@erp/contracts';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { fmt, Pill, SkeletonRows, useDebounced, useToast } from '../../ui';
import { LoadMore, useLoadMore } from '../../ui/lists';
import { PosImg } from './pos';
import './retail.css';

/** Downscales a photo to ≤ 800 px and re-encodes as JPEG until it fits the server limit. */
async function shrink(file: File): Promise<{ mime: 'image/png' | 'image/jpeg' | 'image/webp'; data: string }> {
  const asB64 = (blob: Blob) => new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
  const mime = file.type as 'image/png' | 'image/jpeg' | 'image/webp';
  if (file.size <= PRODUCT_IMAGE_MAX_BYTES && ['image/png', 'image/jpeg', 'image/webp'].includes(mime)) return { mime, data: await asB64(file) };
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  for (const q of [0.85, 0.7, 0.55, 0.4]) {
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', q));
    if (blob && blob.size <= PRODUCT_IMAGE_MAX_BYTES) return { mime: 'image/jpeg', data: await asB64(blob) };
  }
  throw new Error('รูปใหญ่เกินไป ลองใช้รูปที่เล็กลง');
}

export default function ProductImages() {
  const { can } = useAuth();
  const manage = can('data.master') === 1;
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const list = useLoadMore(['img-products'], '/api/products', Product, { q: dq }, 20);
  const imgs = useQuery({ queryKey: ['product-images'], queryFn: () => api('GET', '/api/product-images', { query: { limit: 100 }, schema: page(ProductImageInfo) }) });
  const ver = new Map((imgs.data?.items ?? []).map((x) => [x.productId, x]));
  const loading = list.isLoading;
  const refresh = () => Promise.all(['product-images', 'pos-pricing'].map((k) => qc.invalidateQueries({ queryKey: [k] })));

  const upload = async (p: Product, file: File) => {
    try {
      const img = await shrink(file);
      await api('POST', `/api/product-images/${p.id}`, { body: img });
      await refresh();
      toast(`อัปโหลดรูป ${p.name} แล้ว`);
    } catch (e) {
      toast(errText(e));
    }
  };
  const remove = async (p: Product) => {
    if (!window.confirm(`ลบรูปของ ${p.name}?`)) return;
    try {
      await api('POST', `/api/product-images/${p.id}/remove`);
      await refresh();
      toast('ลบรูปแล้ว');
    } catch (e) {
      toast(errText(e));
    }
  };
  return (
    <div className="card">
      <h2>รูปสินค้าในหน้าขาย</h2>
      <p className="small muted" style={{ marginTop: 0 }}>สินค้าแบรนด์อื่นอัปโหลดรูปได้ (PNG, JPEG, WebP ระบบย่อให้ไม่เกิน {PRODUCT_IMAGE_MAX_BYTES / 1024} KB) · สินค้า SCG ใช้รูปจาก master กลาง แก้ไม่ได้ · ไม่มีรูประบบแสดงภาพตามหมวดสินค้า</p>
      <div className="rt-filters"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นชื่อหรือรหัสสินค้า" aria-label="ค้นหาสินค้า" /></div>
      <div className="tw">
        <table data-testid="img-table">
          <thead><tr><th>รูป</th><th>สินค้า</th><th>หมวด</th><th className="n">ราคา</th><th>ที่มาของรูป</th><th /></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={6} /> : list.rows.map((p) => {
              const v = ver.get(p.id);
              return (
                <tr key={p.id}>
                  <td><span className="rt-img"><PosImg p={p} version={v?.version} /></span></td>
                  <td>{p.name}<div className="rt-desc mono">{p.sku}</div></td>
                  <td className="small">{p.category}</td>
                  <td className="n">{fmt(p.price)}</td>
                  <td>{p.isScg ? <Pill k="acc">SCG master</Pill> : v ? <Pill k="ok">รูปของร้าน · {Math.ceil(v.bytes / 1024)} KB</Pill> : <Pill k="mut">ภาพตามหมวด</Pill>}</td>
                  <td>{manage && !p.isScg && <UploadCell p={p} has={!!v} onFile={upload} onRemove={remove} />}</td>
                </tr>
              );
            })}
            {!loading && list.data && !list.rows.length && <tr><td colSpan={6} className="empty">ไม่พบสินค้า</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onMore={() => void list.fetchNextPage()} count={list.rows.length} />
    </div>
  );
}

function UploadCell({ p, has, onFile, onRemove }: { p: Product; has: boolean; onFile: (p: Product, f: File) => Promise<void>; onRemove: (p: Product) => Promise<void> }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="rt-actions">
      <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" hidden data-testid={`img-file-${p.sku}`} onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        setBusy(true);
        await onFile(p, f);
        setBusy(false);
      }} />
      <button className="btn sm" disabled={busy} onClick={() => ref.current?.click()}>{has ? 'เปลี่ยนรูป' : 'อัปโหลดรูป'}</button>
      {has && <button className="btn sm bad" onClick={() => void onRemove(p)}>ลบรูป</button>}
    </div>
  );
}
