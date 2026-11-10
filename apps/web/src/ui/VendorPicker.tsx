/**
 * Vendor picker for goods receipts, delivery-file drafts and the other purchasing documents: partial search over
 * name / code / phone / tax ID with Thai word segmentation, 20 rows per page from `GET /api/vendors`, and
 * "+ สร้างผู้ขายใหม่" (data.master) which opens QuickVendorModal and saves to the vendor master (POST /api/vendors).
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Vendor, page } from '@erp/contracts';
import { ApiFail, api } from '../api';
import { useAuth } from '../auth';
import { useVendors } from '../data';
import { Modal } from '../ui';
import { SearchSelect, type RemotePage } from './SearchSelect';

const vendorPage = page(Vendor);
export const fetchVendors = (q: string, cursor: string | undefined, limit: number): Promise<RemotePage<Vendor>> =>
  api('GET', '/api/vendors', { query: { q: q || undefined, cursor, limit }, schema: vendorPage, silent: true });

export function VendorPicker({ value, onChange, emptyLabel, testId = 'vendor', ariaLabel = 'ผู้ขาย', invalid, disabled, allowCreate = true, name = 'vendorId', style, placeholder }: {
  value: string | null;
  onChange: (id: string | null, v: Vendor | null) => void;
  /** e.g. "— ตามชื่อในไฟล์ —"; without it the field is required. */
  emptyLabel?: string;
  testId?: string; ariaLabel?: string; invalid?: boolean; disabled?: boolean; allowCreate?: boolean; name?: string; style?: React.CSSProperties; placeholder?: string;
}) {
  const { can } = useAuth();
  const [creating, setCreating] = useState<string | null>(null);
  // The cached full vendor list (small in practice) resolves the label of a saved value without another request.
  const all = useVendors();
  const selected = value ? all.data?.find((v) => v.id === value) ?? null : null;
  const canCreate = allowCreate && can('data.master') === 1;
  return (
    <>
      <SearchSelect<Vendor>
        value={value}
        onChange={onChange}
        fetchPage={fetchVendors}
        queryKey={['pick-vendors']}
        selected={selected}
        getId={(v) => v.id}
        getLabel={(v) => v.name}
        getSub={(v) => [v.code, v.phone, v.taxId && `เลขภาษี ${v.taxId}`].filter(Boolean).join(' · ')}
        getSearch={(v) => `${v.code} ${v.phone ?? ''} ${v.taxId ?? ''}`}
        emptyLabel={emptyLabel}
        placeholder={placeholder ?? 'ค้นหาชื่อผู้ขาย / รหัส / เบอร์โทร / เลขภาษี'}
        onCreate={canCreate ? (t) => setCreating(t) : undefined}
        createLabel="สร้างผู้ขายใหม่"
        testId={testId}
        ariaLabel={ariaLabel}
        invalid={invalid}
        disabled={disabled}
        name={name}
        style={style}
      />
      {creating !== null && <QuickVendorModal initialName={creating} onClose={() => setCreating(null)} onSaved={(v) => { setCreating(null); onChange(v.id, v); }} />}
    </>
  );
}

export function QuickVendorModal({ initialName = '', onClose, onSaved }: { initialName?: string; onClose: () => void; onSaved: (v: Vendor) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: initialName, phone: '', taxId: '', branch: 'สำนักงานใหญ่', termDays: '' });
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setErr((e) => ({ ...e, [k]: '' })); };
  const save = async () => {
    const e: Record<string, string> = {};
    if (!f.name.trim()) e.name = 'ใส่ชื่อผู้ขาย';
    const tax = f.taxId.replace(/\D/g, '');
    if (f.taxId && tax.length !== 13) e.taxId = 'เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก';
    if (f.termDays && !/^\d+$/.test(f.termDays)) e.termDays = 'ใส่จำนวนวันเป็นตัวเลข';
    setErr(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const v = await api('POST', '/api/vendors', {
        schema: Vendor,
        body: {
          name: f.name.trim(), phone: f.phone.trim() || null, taxId: tax || null, branch: tax ? f.branch.trim() || 'สำนักงานใหญ่' : null,
          ...(f.termDays && Number(f.termDays) > 0 ? { term: { t: 'days', x: Number(f.termDays) } } : {}),
        },
      });
      await Promise.all(['vendors', 'pick-vendors'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      onSaved(v);
    } catch (x) {
      if (x instanceof ApiFail && x.status === 409) { x.claim(); setErr({ name: 'มีผู้ขายรหัสนี้แล้ว ลองบันทึกอีกครั้ง' }); } else throw x;
    } finally {
      setBusy(false);
    }
  };
  const fld = (k: keyof typeof f, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="f">{label}
      <input type="text" name={k} data-field={k} value={f[k]} onChange={(e) => set(k, e.target.value)} className={err[k] ? 'bad' : ''} aria-invalid={!!err[k] || undefined} {...extra} />
      {err[k] && <span className="ferr">{err[k]}</span>}
    </label>
  );
  return (
    <Modal onClose={onClose} label="สร้างผู้ขายใหม่">
      <h3>สร้างผู้ขายใหม่</h3>
      <p className="small muted" style={{ marginTop: 0 }}>บันทึกเข้าทะเบียนผู้ขายทันที และเลือกให้เอกสารนี้</p>
      <div className="grid g2" data-testid="quick-vendor">
        {fld('name', 'ชื่อผู้ขาย / บริษัท *', { autoFocus: true })}
        {fld('phone', 'เบอร์โทร', { inputMode: 'tel' })}
        {fld('taxId', 'เลขผู้เสียภาษี 13 หลัก', { inputMode: 'numeric' })}
        {fld('branch', 'สาขา')}
        {fld('termDays', 'เครดิต (วัน) ว่าง = เงินสด', { inputMode: 'numeric' })}
      </div>
      <div className="act">
        <button className="btn" onClick={onClose}>ยกเลิก</button>
        <button className="btn pri" onClick={() => void save()} disabled={busy} data-testid="quick-vendor-save">บันทึกผู้ขาย</button>
      </div>
    </Modal>
  );
}
