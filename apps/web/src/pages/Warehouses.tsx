/**
 * คลังสินค้า: create a warehouse, rename it, switch POS / damaged-goods kind, close it (sys.settings).
 * The server refuses a kind change or close while stock remains, a damaged warehouse marked POS, and leaving the
 * shop without an active sellable or POS warehouse; those failures open the shared error dialog and mark the field.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Warehouse, type WarehouseUpsert } from '@erp/contracts';
import { api } from '../api';
import { useAllWarehouses } from '../data';
import { checkFields } from '../errors';
import { Modal, Pill, SkeletonRows, useToast } from '../ui';

const KIND_TH = { normal: 'คลังขาย', damaged: 'คลังสินค้าชำรุด' } as const;

export default function Warehouses() {
  const q = useAllWarehouses();
  const [edit, setEdit] = useState<Warehouse | 'new' | null>(null);
  const rows = q.data ?? [];
  return (
    <div className="card">
      <h2>
        <span>คลังสินค้า <span className="small muted">{rows.length ? `${rows.length} คลัง` : ''}</span></span>
        <span className="actions"><button className="btn sm pri" onClick={() => setEdit('new')} data-testid="wh-new">+ เพิ่มคลัง</button></span>
      </h2>
      <div className="tw">
        <table>
          <thead><tr><th>รหัส</th><th>ชื่อคลัง</th><th>ประเภท</th><th>หน้าร้าน (POS)</th><th>สถานะ</th><th /></tr></thead>
          <tbody>
            {q.isLoading && <SkeletonRows cols={6} rows={3} />}
            {rows.map((w) => (
              <tr key={w.id} className="click" onClick={() => setEdit(w)} data-testid={`wh-row-${w.code ?? w.id}`} style={w.active ? undefined : { opacity: 0.6 }}>
                <td className="mono">{w.code}</td>
                <td><b>{w.name}</b>{w.system && <div className="small muted">ระบบสร้างให้อัตโนมัติจากการรับคืนสินค้าชำรุด</div>}</td>
                <td>{w.kind === 'damaged' ? <Pill k="warn">{KIND_TH.damaged}</Pill> : KIND_TH.normal}</td>
                <td>{w.isPos ? <Pill k="acc">POS</Pill> : '-'}</td>
                <td>{w.active ? <Pill k="ok">เปิดใช้</Pill> : <Pill k="mut">ปิดแล้ว</Pill>}</td>
                <td className="n"><button className="btn sm" onClick={(e) => { e.stopPropagation(); setEdit(w); }}>แก้ไข</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="note small">คลังสินค้าชำรุดใช้เก็บของเสียจากการรับคืน ขายหรือเปิดบิลจากคลังนี้ไม่ได้ · เปลี่ยนประเภทหรือปิดคลังได้เมื่อไม่มีสินค้าคงเหลือ (โอนออกก่อน)</div>
      {edit && <WarehouseModal w={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function WarehouseModal({ w, onClose }: { w: Warehouse | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<WarehouseUpsert>({ code: w?.code ?? '', name: w?.name ?? '', isPos: w?.isPos ?? false, kind: w?.kind ?? 'normal', active: w?.active ?? true });
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<WarehouseUpsert>) => setF((x) => ({ ...x, ...p, ...(p.kind === 'damaged' ? { isPos: false } : {}) }));
  const save = async () => {
    if (!checkFields({ code: !f.code.trim() && 'กรุณากรอกรหัสคลัง', name: !f.name.trim() && 'กรุณากรอกชื่อคลัง' })) return;
    setBusy(true);
    try {
      const body = { ...f, code: f.code.trim(), name: f.name.trim() };
      if (w) await api('PATCH', `/api/warehouses/${encodeURIComponent(w.id)}`, { body, schema: Warehouse });
      else await api('POST', '/api/warehouses', { body, schema: Warehouse });
      await qc.invalidateQueries({ queryKey: ['warehouses'] });
      toast(w ? `บันทึก ${body.name} แล้ว` : `เพิ่มคลัง ${body.name} แล้ว`);
      onClose();
    } catch {
      // api.ts already opened the error dialog and marked the field named in the server's details
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label={w ? 'แก้ไขคลัง' : 'เพิ่มคลัง'}>
      <h3>{w ? `แก้ไขคลัง · ${w.name}` : 'เพิ่มคลังสินค้า'}</h3>
      <div className="fgrid">
        <label className="f">รหัสคลัง<input type="text" name="code" value={f.code} maxLength={20} onChange={(e) => set({ code: e.target.value.toUpperCase() })} placeholder="เช่น WH3" data-testid="wh-code" /></label>
        <label className="f">ชื่อคลัง<input type="text" name="name" value={f.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} placeholder="เช่น โกดังหลังร้าน" data-testid="wh-name" /></label>
      </div>
      <div className="f" data-field="kind">
        <span>ประเภทคลัง</span>
        <div className="row">
          <label className="row"><input type="radio" name="kind" checked={f.kind === 'normal'} disabled={w?.system} onChange={() => set({ kind: 'normal' })} /> คลังขาย</label>
          <label className="row"><input type="radio" name="kind" checked={f.kind === 'damaged'} onChange={() => set({ kind: 'damaged' })} data-testid="wh-kind-damaged" /> คลังสินค้าชำรุด (ของเสีย)</label>
        </div>
      </div>
      <label className="row" data-field="isPos"><input type="checkbox" checked={f.isPos} disabled={f.kind === 'damaged'} onChange={(e) => set({ isPos: e.target.checked })} data-testid="wh-pos" /> ใช้เป็นคลังหน้าร้าน (POS ตัดสต็อกจากคลังนี้)</label>
      <label className="row" data-field="active"><input type="checkbox" checked={f.active} onChange={(e) => set({ active: e.target.checked })} data-testid="wh-active" /> เปิดใช้งาน</label>
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={busy} onClick={() => void save()} data-testid="wh-save">{busy ? 'กำลังบันทึก…' : 'บันทึก'}</button></div>
    </Modal>
  );
}
