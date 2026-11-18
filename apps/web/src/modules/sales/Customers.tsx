/** ข้อมูลลูกค้า (M03): customer master with type, credit limit and term, what each still owes; edit and deactivate. */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Customer, CustomerMaster, CUSTOMER_TYPES } from '@erp/contracts';
import { d } from '@erp/core';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { fmt, Modal, Pill, SkeletonRows, useDebounced, useToast } from '../../ui';
import { LoadMore, useLoadMore } from '../../ui/lists';
import { TERM_TH } from './shared';

const GROUP_TH = { retail: 'ปลีก', whole: 'ส่ง', contr: 'ผู้รับเหมา (ราคา)' } as const;
type Term = Customer['term'];

export default function Customers() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active');
  const [type, setType] = useState('');
  const dq = useDebounced(q.trim());
  const r = useLoadMore(['customers', 'master', status, type], '/api/customers/master', CustomerMaster, { q: dq, status, type }, 50);
  const [edit, setEdit] = useState<CustomerMaster | 'new' | null>(null);
  const canEdit = can('data.master') === 1;
  const canCreate = canEdit || can('sales.doc') === 1 || can('pos.sell') === 1;
  return (
    <div className="card">
      <h2><span>ข้อมูลลูกค้า</span>{canCreate && <button className="btn sm pri" onClick={() => setEdit('new')} data-testid="cust-new">+ เพิ่มลูกค้า</button>}</h2>
      <div className="pu-filters">
        <input type="search" placeholder="ค้นหาชื่อ รหัส โทร เลขผู้เสียภาษี ที่อยู่" value={q} onChange={(e) => setQ(e.target.value)} aria-label="ค้นหาลูกค้า" data-testid="cust-q" />
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="ประเภทลูกค้า" data-testid="cust-type-filter"><option value="">ทุกประเภท</option>{CUSTOMER_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="สถานะ"><option value="active">ใช้งาน</option><option value="inactive">ปิดใช้งาน</option><option value="all">ทั้งหมด</option></select>
      </div>
      <div className="tw">
        <table data-testid="cust-table">
          <thead><tr><th>รหัส</th><th>ลูกค้า</th><th>ประเภท</th><th>เงื่อนไขชำระ</th><th className="n">วงเงินเครดิต</th><th className="n">ค้างชำระ</th><th className="n">วงเงินคงเหลือ</th><th /></tr></thead>
          <tbody>
            {r.isLoading ? <SkeletonRows cols={8} rows={5} /> : r.rows.map((c) => {
              const left = d(c.creditLimit).minus(d(c.arBalance)).minus(d(c.openOrders));
              return (
                <tr key={c.id} data-testid={`cust-${c.code}`}>
                  <td className="mono">{c.code}</td>
                  <td>{c.name}{!c.active && <> <Pill k="mut">ปิดใช้งาน</Pill></>}<div className="small muted">{[c.phone, c.taxId && `เลขผู้เสียภาษี ${c.taxId}`].filter(Boolean).join(' · ')}</div></td>
                  <td>{c.type ?? <span className="muted">-</span>}<div className="small muted">ราคา{GROUP_TH[c.group]}</div></td>
                  <td className="small">{TERM_TH(c.term)}</td>
                  <td className="n">{d(c.creditLimit).gt(0) ? fmt(c.creditLimit) : <span className="muted">ไม่ให้เครดิต</span>}</td>
                  <td className="n">{d(c.arBalance).gt(0) ? fmt(c.arBalance) : '-'}{d(c.overdue).gt(0) && <div className="small" style={{ color: 'var(--bad)' }}>เกินกำหนด {fmt(c.overdue)}</div>}{d(c.openOrders).gt(0) && <div className="small muted">ใบสั่งขายค้าง {fmt(c.openOrders)}</div>}</td>
                  <td className="n">{d(c.creditLimit).gt(0) ? <b style={{ color: left.lt(0) ? 'var(--bad)' : undefined }}>{fmt(left.toFixed(2))}</b> : '-'}</td>
                  <td>{canEdit && <button className="btn sm" onClick={() => setEdit(c)} data-testid={`cust-edit-${c.code}`}>แก้ไข</button>}</td>
                </tr>
              );
            })}
            {!r.isLoading && !r.rows.length && <tr><td colSpan={8} className="empty">ไม่พบลูกค้า</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!r.hasNextPage} loading={r.isFetchingNextPage} onMore={() => void r.fetchNextPage()} count={r.rows.length} testId="cust-more" />
      <p className="small muted" style={{ margin: '8px 0 0' }}>วงเงินคงเหลือ = วงเงิน − ค้างชำระ − ใบสั่งขายที่ยังส่งไม่ครบ · แก้วงเงินและเครดิตเทอมได้เฉพาะผู้จัดการหรือเจ้าของร้าน · ลูกค้าที่ปิดใช้งานยังอยู่ในเอกสารเดิม แต่ไม่ขึ้นให้เลือกในเอกสารใหม่</p>
      {edit && <CustomerModal c={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function CustomerModal({ c, onClose }: { c: CustomerMaster | null; onClose: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const creditOk = can('sales.creditApv') === 1;
  const preset = !c?.type || (CUSTOMER_TYPES as readonly string[]).includes(c.type);
  const [f, setF] = useState({
    name: c?.name ?? '', code: c?.code ?? '', phone: c?.phone ?? '', taxId: c?.taxId ?? '', branch: c?.branch ?? '', address: c?.address ?? '', note: c?.note ?? '',
    group: c?.group ?? 'retail', creditLimit: c ? d(c.creditLimit).toFixed(2) : '0', active: c?.active ?? true,
    typeSel: preset ? c?.type ?? '' : '__o', typeOther: preset ? '' : c?.type ?? '',
  });
  const [term, setTerm] = useState<Term>(c?.term ?? { t: 'cash' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const type = f.typeSel === '__o' ? f.typeOther.trim() || null : f.typeSel || null;
  const save = async () => {
    if (!f.name.trim()) return setErr('ใส่ชื่อลูกค้า');
    if (f.taxId && !/^\d{13}$/.test(f.taxId)) return setErr('เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก');
    if (!/^\d+(\.\d+)?$/.test(f.creditLimit)) return setErr('วงเงินเครดิตต้องเป็นตัวเลข');
    setBusy(true);
    setErr('');
    const body = {
      name: f.name.trim(), phone: f.phone || null, taxId: f.taxId || null, branch: f.branch || null, address: f.address, note: f.note, group: f.group, type,
      ...(creditOk || !c ? { creditLimit: f.creditLimit, term } : {}), ...(c ? { code: f.code.trim() || undefined, active: f.active } : {}),
    };
    try {
      const r = c ? await api('PATCH', `/api/customers/${c.id}`, { body, schema: Customer }) : await api('POST', '/api/customers', { body, schema: Customer });
      toast(c ? `บันทึก ${r.name} แล้ว` : `เพิ่มลูกค้า ${r.code} ${r.name} แล้ว`);
      await qc.invalidateQueries({ queryKey: ['customers'] });
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} wide label={c ? 'แก้ไขลูกค้า' : 'เพิ่มลูกค้า'}>
      <h3>{c ? `แก้ไขลูกค้า ${c.code}` : 'เพิ่มลูกค้า'}</h3>
      <div className="fgrid">
        <label className="f">ชื่อลูกค้า / บริษัท *<input type="text" value={f.name} onChange={(e) => set('name', e.target.value)} data-testid="cust-name" /></label>
        {c && <label className="f">รหัสลูกค้า<input type="text" value={f.code} onChange={(e) => set('code', e.target.value)} /></label>}
        <label className="f">ประเภทลูกค้า
          <select value={f.typeSel} onChange={(e) => set('typeSel', e.target.value)} data-testid="cust-type">
            <option value="">ไม่ระบุ</option>{CUSTOMER_TYPES.map((t) => <option key={t}>{t}</option>)}<option value="__o">อื่น ๆ (ระบุเอง)</option>
          </select>
        </label>
        {f.typeSel === '__o' && <label className="f">ประเภท (ระบุเอง)<input type="text" maxLength={60} value={f.typeOther} onChange={(e) => set('typeOther', e.target.value)} placeholder="เช่น ร้านวัสดุรายย่อย" data-testid="cust-type-other" /></label>}
        <label className="f">โทรศัพท์<input type="text" inputMode="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} data-testid="cust-phone" /></label>
        <label className="f">เลขผู้เสียภาษี (13 หลัก)<input type="text" inputMode="numeric" maxLength={13} value={f.taxId} onChange={(e) => set('taxId', e.target.value.replace(/\D/g, ''))} data-testid="cust-tax" /></label>
        <label className="f">สาขา (ถ้ามี)<input type="text" value={f.branch} onChange={(e) => set('branch', e.target.value)} placeholder="สำนักงานใหญ่ หรือ 00001" /></label>
        <label className="f">กลุ่มราคา<select value={f.group} onChange={(e) => set('group', e.target.value as typeof f.group)}>{Object.entries(GROUP_TH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      <label className="f">ที่อยู่ (พิมพ์ในใบกำกับ)<textarea rows={2} value={f.address} onChange={(e) => set('address', e.target.value)} data-testid="cust-address" /></label>
      <fieldset style={{ border: '1px solid var(--line, #dde2ea)', borderRadius: 10, padding: '8px 12px', margin: '8px 0' }}>
        <legend className="small" style={{ padding: '0 6px' }}>สินเชื่อ{!creditOk && c ? ' · แก้ได้เฉพาะผู้จัดการหรือเจ้าของร้าน' : ''}</legend>
        <div className="fgrid">
          <label className="f">วงเงินเครดิต (บาท)<input type="text" inputMode="decimal" value={f.creditLimit} disabled={!!c && !creditOk} onChange={(e) => set('creditLimit', e.target.value)} data-testid="cust-limit" /></label>
          <label className="f">เงื่อนไขชำระ
            <select value={term.t} disabled={!!c && !creditOk} onChange={(e) => { const t = e.target.value; setTerm(t === 'days' ? { t: 'days', x: 30 } : t === 'nextDay' ? { t: 'nextDay', x: 25 } : t === 'eom' ? { t: 'eom' } : { t: 'cash' }); }} data-testid="cust-term">
              <option value="cash">เงินสด</option><option value="days">เครดิต (วัน)</option><option value="nextDay">ชำระทุกวันที่ของเดือนถัดไป</option><option value="eom">สิ้นเดือน</option>
            </select>
          </label>
          {(term.t === 'days' || term.t === 'nextDay') && (
            <label className="f">{term.t === 'days' ? 'จำนวนวัน' : 'วันที่'}<input type="number" min={1} max={term.t === 'days' ? 365 : 31} value={term.x} disabled={!!c && !creditOk} onChange={(e) => setTerm({ ...term, x: Math.max(1, Number(e.target.value) || 1) })} data-testid="cust-term-x" /></label>
          )}
        </div>
      </fieldset>
      <label className="f">หมายเหตุ<input type="text" value={f.note} onChange={(e) => set('note', e.target.value)} /></label>
      {c && <label className="row" style={{ marginTop: 6 }}><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} data-testid="cust-active" /> ใช้งาน (เอาเครื่องหมายออกเพื่อปิดใช้งาน)</label>}
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={busy} onClick={() => void save()} data-testid="cust-save">บันทึก</button></div>
    </Modal>
  );
}
