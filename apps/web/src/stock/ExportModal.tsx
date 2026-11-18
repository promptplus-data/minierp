/** Excel / CSV export of the stock balance or the stock ledger for the products and warehouses the user picks. */
import { useState } from 'react';
import type { Product } from '@erp/contracts';
import { errText } from '../api';
import { useCatalog, useAllWarehouses } from '../data';
import { Modal, useToast } from '../ui';
import { ProductPicker } from '../ui/ProductPicker';
import { downloadFile } from '../modules/reports/shared';

const isStockProduct = (p: Product) => p.kind === 'stock';

export function StockExportModal({ kind, onClose, init }: {
  kind: 'stock' | 'ledger';
  onClose: () => void;
  init?: { productIds?: string[]; warehouseIds?: string[]; from?: string; to?: string };
}) {
  const cat = useCatalog();
  const whs = useAllWarehouses();
  const toast = useToast();
  const [products, setProducts] = useState<string[]>(init?.productIds ?? []);
  const [allWh, setAllWh] = useState(!init?.warehouseIds?.length);
  const [wh, setWh] = useState<string[]>(init?.warehouseIds ?? []);
  const [from, setFrom] = useState(init?.from ?? '');
  const [to, setTo] = useState(init?.to ?? '');
  const [nonZero, setNonZero] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const pickWh = (id: string, on: boolean) => setWh((xs) => (on ? [...xs, id] : xs.filter((x) => x !== id)));
  const noWh = !allWh && !wh.length;
  const badRange = !!from && !!to && from > to;

  const go = async (format: 'xlsx' | 'csv') => {
    setBusy(format);
    try {
      const query = {
        format,
        productIds: products.join(',') || undefined,
        warehouseIds: allWh ? undefined : wh.join(','),
        ...(kind === 'stock' ? { nonZero: nonZero ? 'true' : undefined } : { from: from || undefined, to: to || undefined }),
      };
      const name = await downloadFile(kind === 'stock' ? '/api/stock/export' : '/api/stock/ledger/export', query, kind === 'stock' ? 'stock' : 'stock-ledger');
      toast(`ดาวน์โหลด ${name} แล้ว`);
      onClose();
    } catch (e) {
      toast(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal onClose={onClose} label={kind === 'stock' ? 'Export สต็อกคงเหลือ' : 'Export สมุดคุมสต็อก'}>
      <h3 style={{ marginTop: 0 }}>{kind === 'stock' ? 'Export สต็อกคงเหลือ' : 'Export สมุดคุมสต็อก'}</h3>
      <div className="small muted" style={{ marginBottom: 12 }}>
        {kind === 'stock' ? 'ยอดคงเหลือ จอง และพร้อมขาย แยกรายสินค้า × รายคลัง' : 'ทุกความเคลื่อนไหวพร้อมยอดคงเหลือหลังรายการ เรียงจากเก่าไปใหม่'} · ไม่เลือกสินค้า = ทุกสินค้า
      </div>

      <div style={{ display: 'grid', gap: 6 }}><b>สินค้า</b>
        <ProductPicker value={null} onChange={(id) => { if (id && !products.includes(id)) setProducts([...products, id]); }} filter={isStockProduct} showStock={false}
          placeholder={products.length ? 'เพิ่มสินค้าอีก…' : 'ทุกสินค้า (ค้นหาเพื่อเลือกบางรายการ)'} testId="exp-product" ariaLabel="เลือกสินค้าที่จะ export" />
        {products.length > 0 && (
          <div className="row" style={{ marginTop: 6, gap: 6 }} data-testid="exp-products">
            {products.map((id) => {
              const p = cat.byId.get(id);
              return <span key={id} className="pill">{p ? `${p.sku} ${p.name}` : id}<button className="btn sm" style={{ marginLeft: 4, padding: '0 6px' }} aria-label={`เอา ${p?.name ?? ''} ออก`} onClick={() => setProducts(products.filter((x) => x !== id))}>×</button></span>;
            })}
            <button className="btn sm" onClick={() => setProducts([])}>ล้าง (ทุกสินค้า)</button>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gap: 6, marginTop: 12 }}><b>คลัง</b>
        <label className="row"><input type="checkbox" checked={allWh} onChange={(e) => setAllWh(e.target.checked)} data-testid="exp-wh-all" /> ทุกคลัง</label>
        {!allWh && (
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            {(whs.data ?? []).filter((w) => w.active).map((w) => (
              <label key={w.id} className="row"><input type="checkbox" checked={wh.includes(w.id)} onChange={(e) => pickWh(w.id, e.target.checked)} data-testid={`exp-wh-${w.code}`} /> {w.name}{w.kind === 'damaged' ? ' (ของเสีย)' : ''}</label>
            ))}
          </div>
        )}
        {noWh && <div className="small" style={{ color: 'var(--bad)' }}>เลือกอย่างน้อย 1 คลัง</div>}
      </div>

      {kind === 'stock' ? (
        <label className="row" style={{ marginTop: 12 }}><input type="checkbox" checked={nonZero} onChange={(e) => setNonZero(e.target.checked)} data-testid="exp-nonzero" /> เฉพาะรายการที่มีของหรือมีจอง</label>
      ) : (
        <div className="row" style={{ marginTop: 12, gap: 8 }}>
          <label>ตั้งแต่วันที่ <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="exp-from" /></label>
          <label>ถึงวันที่ <input type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="exp-to" /></label>
          {badRange && <span className="small" style={{ color: 'var(--bad)' }}>วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด</span>}
        </div>
      )}

      <div className="act" style={{ marginTop: 16 }}>
        <button className="btn" onClick={onClose}>ยกเลิก</button>
        <button className="btn" disabled={!!busy || noWh || badRange} onClick={() => void go('csv')} data-testid="exp-csv">{busy === 'csv' ? 'กำลังสร้าง…' : 'CSV'}</button>
        <button className="btn pri" disabled={!!busy || noWh || badRange} onClick={() => void go('xlsx')} data-testid="exp-xlsx">{busy === 'xlsx' ? 'กำลังสร้าง…' : 'ดาวน์โหลด Excel'}</button>
      </div>
    </Modal>
  );
}
