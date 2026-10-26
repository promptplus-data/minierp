/** BR-18 audit log (owner / manager): cursor-paged, search, hash-chain verify. */
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AuditEntry, page } from '@erp/contracts';
import { api, errText } from '../api';
import { Pager, Pill, SkeletonRows, thTime, useCursorPager, useDebounced, useToast, type PillKind } from '../ui';

const ACT: Record<string, [string, PillKind]> = {
  login: ['เข้าสู่ระบบ', 'mut'], 'login-failed': ['เข้าไม่สำเร็จ', 'bad'], locked: ['ล็อกบัญชี', 'bad'], unlock: ['ปลดล็อก', 'acc'],
  create: ['เพิ่ม', 'ok'], update: ['แก้ไข', 'acc'], void: ['ยกเลิก', 'bad'], approve: ['อนุมัติ', 'acc'], reject: ['ไม่อนุมัติ', 'warn'],
  request: ['ขออนุมัติ', 'warn'], 'shift-open': ['เปิดกะ', 'acc'], 'shift-close': ['ปิดกะ', 'acc'], open: ['เปิดกะ', 'acc'], close: ['ปิดกะ', 'acc'],
  seed: ['ตั้งต้นข้อมูล', 'mut'], pair: ['จับคู่เครื่อง', 'acc'],
};

export default function Audit() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const pager = useCursorPager(dq);
  const list = useQuery({
    queryKey: ['audit', dq, pager.cursor],
    queryFn: () => api('GET', '/api/audit-log', { query: { q: dq, limit: 20, cursor: pager.cursor }, schema: page(AuditEntry) }),
    placeholderData: keepPreviousData,
  });
  const loading = list.isLoading || (list.isFetching && list.isPlaceholderData);
  const verify = async () => {
    try {
      const r = await api<{ ok: boolean; brokenAt: string | null; rows: number }>('GET', '/api/audit-log/verify');
      toast(r.ok ? `ตรวจแล้ว ${r.rows} รายการ · log ครบถ้วน ไม่ถูกแก้ไข` : `พบ log ถูกแก้ไขที่ลำดับ ${r.brokenAt}`);
    } catch (e) {
      toast(errText(e));
    }
  };
  return (
    <div className="card">
      <h2>ประวัติการทำรายการ <button className="btn sm" onClick={() => void verify()}>ตรวจความถูกต้องของ log</button></h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นเลขที่เอกสาร ผู้ใช้ การกระทำ หรือรายละเอียด" style={{ flex: 1, minWidth: 180 }} aria-label="ค้นหา log" />
      </div>
      {list.isError && <div className="note bad small">{errText(list.error)}</div>}
      <div className="tw">
        <table data-testid="audit-table">
          <thead><tr><th>เวลา</th><th>ผู้ทำ</th><th>การกระทำ</th><th>เรื่อง</th><th>เลขที่</th><th>รายละเอียด</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={6} /> : (list.data?.items ?? []).map((a) => {
              const [label, k] = ACT[a.action] ?? [a.action, 'mut' as PillKind];
              return (
                <tr key={a.id}>
                  <td className="small mono">{thTime(a.at)}</td><td className="small">{a.user}</td><td><Pill k={k}>{label}</Pill></td>
                  <td className="small">{a.object}</td><td className="mono small">{a.ref ?? ''}</td><td className="small">{a.detail}</td>
                </tr>
              );
            })}
            {!loading && list.data && !list.data.items.length && <tr><td colSpan={6} className="empty">ไม่พบรายการ</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!list.data?.nextCursor} count={list.data?.items.length} loading={list.isFetching} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor ?? null)} />
      <p className="small muted" style={{ margin: '8px 0 0' }}>ทุกการเพิ่ม แก้ไข ยกเลิก และอนุมัติ ลงชื่อผู้ใช้และเวลาอัตโนมัติ แก้หรือลบ log ไม่ได้ (ต่อกันเป็น hash chain)</p>
    </div>
  );
}
