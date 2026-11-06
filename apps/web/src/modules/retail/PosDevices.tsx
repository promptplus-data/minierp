/** REQ-M01-07 POS machines and the POS ID from the Revenue Department (mockup settings "เครื่อง POS และ ภ.พ.06"). */
import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { PosDevice, page } from '@erp/contracts';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { useMeta } from '../../data';
import { Modal, Pager, Pill, SkeletonRows, th, useCursorPager, useToast } from '../../ui';
import './retail.css';
import { ErrorBanner } from '../../errors';

const ST: Record<PosDevice['status'], [string, 'ok' | 'warn' | 'mut']> = { approved: ['อนุมัติแล้ว', 'ok'], pending: ['รออนุมัติ', 'warn'], retired: ['เลิกใช้', 'mut'] };

export default function PosDevices() {
  const { can } = useAuth();
  const manage = can('sys.settings') === 1;
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const pager = useCursorPager('');
  const [edit, setEdit] = useState<PosDevice | 'new' | null>(null);
  const list = useQuery({
    queryKey: ['pos-devices', pager.cursor],
    queryFn: () => api('GET', '/api/pos-devices', { query: { limit: 20, cursor: pager.cursor }, schema: page(PosDevice) }),
    placeholderData: keepPreviousData,
  });
  const loading = list.isLoading || (list.isFetching && list.isPlaceholderData);
  const vat = meta.data?.shop.vatRegistered ?? true;
  return (
    <div className="card">
      <div className="rt-head">
        <div>
          <h2 style={{ margin: 0 }}>เครื่อง POS และ ภ.พ.06</h2>
          <p className="small muted">{vat
            ? 'บันทึก POS ID ที่สรรพากรอนุมัติต่อเครื่อง · เมื่อลงทะเบียนเครื่องแล้ว เครื่องที่ยังไม่มี POS ID ออกใบกำกับภาษีอย่างย่อไม่ได้ (ออกได้เฉพาะใบเต็มรูป) · ชื่อเครื่องต้องตรงกับที่เลือกตอนเปิดกะ'
            : 'ร้านไม่จด VAT ไม่ต้องยื่น ภ.พ.06 · POS ออกใบเสร็จรับเงิน'}</p>
        </div>
        <button className="btn pri" disabled={!manage} onClick={() => setEdit('new')} data-testid="dev-new">+ เพิ่มเครื่อง</button>
      </div>
      {list.isError && <ErrorBanner error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
      <div className="tw" style={{ marginTop: 12 }}>
        <table data-testid="dev-table">
          <thead><tr><th>เครื่อง</th><th>POS ID จากสรรพากร</th><th>วันที่อนุมัติ</th><th>สถานะ</th><th>ใบกำกับอย่างย่อ</th><th>แก้ล่าสุด</th><th /></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={7} rows={3} /> : (list.data?.items ?? []).map((x) => (
              <tr key={x.id}>
                <td><b className="mono">{x.code}</b> · {x.name}{x.note && <div className="rt-desc">{x.note}</div>}</td>
                <td className="mono small">{x.rdPosId ?? '-'}</td>
                <td>{x.approvedOn ? th(x.approvedOn) : '-'}</td>
                <td><Pill k={ST[x.status][1]}>{ST[x.status][0]}</Pill></td>
                <td>{x.canIssueAbb ? <Pill k="ok">ออกได้</Pill> : <Pill k="bad">เฉพาะใบเต็มรูป</Pill>}</td>
                <td className="small">{x.updatedBy ?? x.createdBy}</td>
                <td>{manage && <button className="btn sm" onClick={() => setEdit(x)}>แก้ไข</button>}</td>
              </tr>
            ))}
            {!loading && list.data && !list.data.items.length && <tr><td colSpan={7} className="empty">ยังไม่ได้ลงทะเบียนเครื่อง · ทุกเครื่องออกใบกำกับอย่างย่อได้จนกว่าจะลงทะเบียนเครื่องแรก</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!list.data?.nextCursor} count={list.data?.items.length} loading={list.isFetching} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor ?? null)} />
      {edit && <DeviceModal dev={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={(x) => { setEdit(null); void qc.invalidateQueries({ queryKey: ['pos-devices'] }); toast(`บันทึกเครื่อง ${x.code} แล้ว`); }} />}
    </div>
  );
}

function DeviceModal({ dev, onClose, onSaved }: { dev: PosDevice | null; onClose: () => void; onSaved: (x: PosDevice) => void }) {
  const [code, setCode] = useState(dev?.code ?? '');
  const [name, setName] = useState(dev?.name ?? '');
  const [rd, setRd] = useState(dev?.rdPosId ?? '');
  const [on, setOn] = useState(dev?.approvedOn ?? '');
  const [status, setStatus] = useState<PosDevice['status']>(dev?.status ?? 'pending');
  const [note, setNote] = useState(dev?.note ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErr('');
    const body = { name: name.trim(), rdPosId: rd.trim() || null, approvedOn: on || null, status, note };
    try {
      onSaved(dev ? await api('PATCH', `/api/pos-devices/${dev.id}`, { body, schema: PosDevice }) : await api('POST', '/api/pos-devices', { body: { ...body, code: code.trim() }, schema: PosDevice }));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const needRd = status === 'approved' && (!rd.trim() || !on);
  return (
    <Modal onClose={onClose} label="เครื่อง POS">
      <h3>{dev ? `เครื่อง ${dev.code}` : 'เพิ่มเครื่อง POS'}</h3>
      <div className="fgrid">
        <label className="f">ชื่อเครื่อง (ตามที่เลือกตอนเปิดกะ) *<input type="text" value={code} disabled={!!dev} onChange={(e) => setCode(e.target.value)} placeholder="POS-01" data-testid="dev-code" /></label>
        <label className="f">คำอธิบาย *<input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="แท็บเล็ตแคชเชียร์ 1" data-testid="dev-name" /></label>
        <label className="f">POS ID จากสรรพากร<input type="text" value={rd} onChange={(e) => setRd(e.target.value)} placeholder="E061234567890123" className="mono" data-testid="dev-rd" /></label>
        <label className="f">วันที่อนุมัติ<input type="date" value={on} onChange={(e) => setOn(e.target.value)} data-testid="dev-on" /></label>
        <label className="f">สถานะ<select value={status} onChange={(e) => setStatus(e.target.value as PosDevice['status'])} data-testid="dev-status">{Object.entries(ST).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="f">หมายเหตุ<input type="text" value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      {needRd && <div className="note warn small">เครื่องที่อนุมัติแล้วต้องมี POS ID และวันที่อนุมัติ</div>}
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={busy || !name.trim() || (!dev && !code.trim()) || needRd} onClick={() => void save()} data-testid="dev-save">บันทึก</button></div>
    </Modal>
  );
}
