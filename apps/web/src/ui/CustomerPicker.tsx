/**
 * Customer picker for POS, quotation, sales order and every other document: partial search over name / code /
 * phone / tax ID / address, 20 rows per page, and "+ สร้างลูกค้าใหม่" which opens QuickCustomerModal and saves the
 * new customer to the customer master (POST /api/customers) before selecting it.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Customer, page } from '@erp/contracts';
import { ApiFail, api } from '../api';
import { useAuth } from '../auth';
import { Modal } from '../ui';
import { SearchSelect, type RemotePage } from './SearchSelect';

const customerPage = page(Customer);
export const fetchCustomers = (q: string, cursor: string | undefined, limit: number): Promise<RemotePage<Customer>> =>
  api('GET', '/api/customers', { query: { q: q || undefined, cursor, limit }, schema: customerPage, silent: true });

export function useCustomer(id: string | null | undefined) {
  return useQuery({ queryKey: ['customer', id], enabled: !!id, staleTime: 60_000, queryFn: () => api('GET', `/api/customers/${id}`, { schema: Customer }) });
}

export function CustomerPicker({ value, onChange, emptyLabel, requireTaxId, testId = 'cust', ariaLabel = 'ลูกค้า', invalid, disabled, allowCreate = true, name = 'customerId', style }: {
  value: string | null;
  onChange: (id: string | null, c: Customer | null) => void;
  /** e.g. "ลูกค้าทั่วไป (ราคาปลีก)"; without it the field is required. */
  emptyLabel?: string;
  /** Full tax invoice: rows without a tax ID are shown but cannot be picked. */
  requireTaxId?: boolean;
  testId?: string; ariaLabel?: string; invalid?: boolean; disabled?: boolean; allowCreate?: boolean; name?: string; style?: React.CSSProperties;
}) {
  const { can } = useAuth();
  const [creating, setCreating] = useState<string | null>(null);
  const sel = useCustomer(value);
  const canCreate = allowCreate && (can('data.master') === 1 || can('sales.doc') === 1 || can('pos.sell') === 1);
  return (
    <>
      <SearchSelect<Customer>
        value={value}
        onChange={onChange}
        fetchPage={fetchCustomers}
        queryKey={['pick-customers']}
        selected={sel.data ?? null}
        getId={(c) => c.id}
        getLabel={(c) => c.name}
        getSub={(c) => [c.code, c.phone, c.taxId && `เลขภาษี ${c.taxId}`].filter(Boolean).join(' · ')}
        getSearch={(c) => `${c.code} ${c.phone ?? ''} ${c.taxId ?? ''} ${c.address}`}
        isDisabled={requireTaxId ? (c) => (c.taxId ? false : 'ไม่มีเลขผู้เสียภาษี ออกใบกำกับเต็มรูปไม่ได้') : undefined}
        emptyLabel={emptyLabel}
        placeholder="ค้นหาชื่อ / รหัส / เบอร์โทร / เลขภาษี"
        onCreate={canCreate ? (t) => setCreating(t) : undefined}
        createLabel="สร้างลูกค้าใหม่"
        testId={testId}
        ariaLabel={ariaLabel}
        invalid={invalid}
        disabled={disabled}
        name={name}
        style={style}
      />
      {creating !== null && (
        <QuickCustomerModal initialName={creating} needTaxId={requireTaxId} onClose={() => setCreating(null)}
          onSaved={(c) => { setCreating(null); onChange(c.id, c); }} />
      )}
    </>
  );
}

/** Looks like a phone number → goes to the phone field instead of the name. */
const looksPhone = (s: string) => /^[0-9\-\s+]{6,}$/.test(s.trim());

export function QuickCustomerModal({ initialName = '', needTaxId, onClose, onSaved }: { initialName?: string; needTaxId?: boolean; onClose: () => void; onSaved: (c: Customer) => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [f, setF] = useState({
    name: looksPhone(initialName) ? '' : initialName, phone: looksPhone(initialName) ? initialName.trim() : '', taxId: '', branch: 'สำนักงานใหญ่', address: '',
    group: 'retail' as Customer['group'], termDays: '', creditLimit: '', note: '',
  });
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setErr((e) => ({ ...e, [k]: '' })); };
  const master = can('data.master') === 1;

  const save = async () => {
    const e: Record<string, string> = {};
    if (!f.name.trim()) e.name = 'ใส่ชื่อลูกค้า';
    if (f.taxId && !/^\d{13}$/.test(f.taxId.replace(/\D/g, ''))) e.taxId = 'เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก';
    if (needTaxId && !f.taxId) e.taxId = 'ใบกำกับภาษีเต็มรูปต้องมีเลขผู้เสียภาษี';
    if (f.termDays && !/^\d+$/.test(f.termDays)) e.termDays = 'ใส่จำนวนวันเป็นตัวเลข';
    if (f.creditLimit && !/^\d+(\.\d+)?$/.test(f.creditLimit)) e.creditLimit = 'ใส่วงเงินเป็นตัวเลข';
    setErr(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const c = await api('POST', '/api/customers', {
        schema: Customer,
        body: {
          name: f.name.trim(), phone: f.phone.trim() || null, taxId: f.taxId.replace(/\D/g, '') || null, branch: f.taxId ? f.branch.trim() || 'สำนักงานใหญ่' : null,
          address: f.address.trim(), group: f.group, note: f.note.trim(),
          ...(master && f.termDays && Number(f.termDays) > 0 ? { term: { t: 'days', x: Number(f.termDays) } } : {}),
          ...(master && f.creditLimit ? { creditLimit: f.creditLimit } : {}),
        },
      });
      await Promise.all(['customers', 'pick-customers'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      qc.setQueryData(['customer', c.id], c);
      onSaved(c);
    } catch (x) {
      if (x instanceof ApiFail && x.status === 409) { x.claim(); setErr({ name: 'มีลูกค้ารหัสนี้แล้ว ลองบันทึกอีกครั้ง' }); }
      else throw x;
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
    <Modal onClose={onClose} label="สร้างลูกค้าใหม่">
      <h3>สร้างลูกค้าใหม่</h3>
      <p className="small muted" style={{ marginTop: 0 }}>บันทึกเข้าทะเบียนลูกค้าทันที และเลือกให้เอกสารนี้</p>
      <div className="grid g2" data-testid="quick-customer">
        {fld('name', 'ชื่อลูกค้า / บริษัท *', { autoFocus: true })}
        {fld('phone', 'เบอร์โทร', { inputMode: 'tel' })}
        {fld('taxId', needTaxId ? 'เลขผู้เสียภาษี 13 หลัก *' : 'เลขผู้เสียภาษี 13 หลัก', { inputMode: 'numeric' })}
        {fld('branch', 'สาขา')}
        <label className="f" style={{ gridColumn: '1/-1' }}>ที่อยู่ (ใช้ออกใบกำกับ / ส่งของ)
          <textarea name="address" rows={2} value={f.address} onChange={(e) => set('address', e.target.value)} />
        </label>
        <label className="f">กลุ่มลูกค้า
          <select name="group" value={f.group} onChange={(e) => set('group', e.target.value)}>
            <option value="retail">ปลีก</option><option value="whole">ส่ง</option><option value="contr">ผู้รับเหมา</option>
          </select>
        </label>
        {master ? fld('termDays', 'เครดิต (วัน) ว่าง = เงินสด', { inputMode: 'numeric' }) : <div className="small muted" style={{ alignSelf: 'end' }}>เครดิตและวงเงิน ผู้จัดการตั้งได้ที่ทะเบียนลูกค้า</div>}
        {master && fld('creditLimit', 'วงเงินเครดิต (บาท)', { inputMode: 'decimal' })}
        <label className="f" style={{ gridColumn: '1/-1' }}>หมายเหตุ
          <input type="text" name="note" value={f.note} onChange={(e) => set('note', e.target.value)} />
        </label>
      </div>
      <div className="act">
        <button className="btn" onClick={onClose}>ยกเลิก</button>
        <button className="btn pri" onClick={() => void save()} disabled={busy} data-testid="quick-customer-save">บันทึกลูกค้า</button>
      </div>
    </Modal>
  );
}
