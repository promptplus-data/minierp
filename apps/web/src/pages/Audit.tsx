/** BR-18 audit log (owner / manager): cursor-paged, search, hash-chain verify. */
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AuditEntry, page } from '@erp/contracts';
import { api, errText } from '../api';
import { Pager, Pill, SkeletonRows, thTime, useCursorPager, useDebounced, useToast, type PillKind } from '../ui';
import { ErrorBanner } from '../errors';
import { Link } from 'react-router-dom';
import { DocLink, DocText } from '../doclink';

const ACT: Record<string, [string, PillKind]> = {
  login: ['เข้าสู่ระบบ', 'mut'], 'login-failed': ['เข้าไม่สำเร็จ', 'bad'], locked: ['ล็อกบัญชี', 'bad'], unlock: ['ปลดล็อก', 'acc'],
  create: ['เพิ่ม', 'ok'], update: ['แก้ไข', 'acc'], void: ['ยกเลิก', 'bad'], approve: ['อนุมัติ', 'acc'], reject: ['ไม่อนุมัติ', 'warn'],
  request: ['ขออนุมัติ', 'warn'], 'shift-open': ['เปิดกะ', 'acc'], 'shift-close': ['ปิดกะ', 'acc'], open: ['เปิดกะ', 'acc'], close: ['ปิดกะ', 'acc'],
  seed: ['ตั้งต้นข้อมูล', 'mut'], pair: ['จับคู่เครื่อง', 'acc'],
  issue: ['เบิกวัตถุดิบ', 'acc'], output: ['รับผลผลิต', 'ok'], hold: ['พักบิล', 'mut'], resume: ['เรียกบิลที่พัก', 'acc'], discard: ['ทิ้งบิลที่พัก', 'warn'],
  confirm: ['ยืนยันรับ', 'ok'], import: ['นำเข้า', 'acc'], export: ['ส่งออก', 'acc'], pay: ['จ่ายเงิน', 'ok'], submit: ['ส่งผลนับ', 'acc'], resign: ['ลาออก', 'warn'],
  suspend: ['ระงับ', 'bad'], 'approval-failed': ['อนุมัติไม่สำเร็จ', 'bad'],
};
/** Thai names for the audit "object" slugs so the table does not show raw English keys. */
const OBJ: Record<string, string> = {
  user: 'ผู้ใช้', shift: 'กะขาย', 'pos-bill': 'บิลที่พักไว้', 'stock-adjust': 'ปรับยอดสต็อก', 'stock-count': 'นับสต็อก', 'vendor-return': 'ส่งคืนผู้ขาย', 'payment-voucher': 'ใบสำคัญจ่าย',
  'gr-draft': 'ใบส่งของรอรับ', 'delivery-file': 'ไฟล์ใบส่งของ', employee: 'พนักงาน', 'employee+user': 'พนักงานและบัญชีผู้ใช้', payroll: 'เงินเดือน', leave: 'ใบลา',
  promotion: 'โปรโมชั่น', 'price-list': 'ราคาตามลูกค้า', product: 'สินค้า', 'product-image': 'รูปสินค้า', 'pos-device': 'เครื่อง POS', tenant: 'ร้านค้า', deposit: 'มัดจำ', project: 'โครงการ',
  bom: 'สูตรผลิต', 'gl-mapping': 'ผังบัญชีส่งออก', 'credit-limit': 'อนุมัติเกินวงเงิน', discount: 'อนุมัติส่วนลด', 'below-cost': 'อนุมัติขายต่ำกว่าทุน', pin: 'PIN อนุมัติ',
  reports: 'รายงาน', 'import-products': 'นำเข้าสินค้า', 'export-peak': 'ส่งออก PEAK', 'export-flowaccount': 'ส่งออก FlowAccount', 'export-express': 'ส่งออก Express',
  ABB: 'ใบกำกับอย่างย่อ', INV: 'ใบกำกับภาษี', CN: 'ใบลดหนี้', QT: 'ใบเสนอราคา', SO: 'ใบสั่งขาย', DO: 'ใบส่งของ', BN: 'ใบวางบิล', RE: 'ใบเสร็จรับเงิน', GR: 'ใบรับสินค้า', MO: 'ใบสั่งผลิต', TR: 'โอนคลัง',
};

/** The audit `ref` is a document number for most objects: open it. Exports link to their run on the export page. */
function AuditRef({ a }: { a: { object: string; ref: string | null } }) {
  if (!a.ref) return null;
  if (a.object === 'payment-voucher') return <DocLink no={a.ref} type="PV" />;
  if (a.object === 'vendor-return') return <DocLink no={a.ref} type="PR" />;
  if (a.object === 'stock-adjust') return <DocLink no={a.ref} />;
  if (a.object === 'leave') return <DocLink no={a.ref} type="LV" />;
  if (a.object === 'stock-count') return <DocLink no={a.ref} type="CNT" />;
  if (a.object === 'project') return <DocLink no={a.ref} type="PJ" />;
  if (a.object.startsWith('export-')) return <Link to="/export">{a.ref.slice(0, 8)}…</Link>;
  if (a.object === 'payroll') return <Link to={`/hr?tab=pay`}>{a.ref}</Link>;
  return <DocLink no={a.ref} />;
}

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
      {list.isError && <ErrorBanner error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
      <div className="tw">
        <table data-testid="audit-table">
          <thead><tr><th>เวลา</th><th>ผู้ทำ</th><th>การกระทำ</th><th>เรื่อง</th><th>เลขที่</th><th>รายละเอียด</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={6} /> : (list.data?.items ?? []).map((a) => {
              const [label, k] = ACT[a.action] ?? [a.action, 'mut' as PillKind];
              return (
                <tr key={a.id}>
                  <td className="small mono">{thTime(a.at)}</td><td className="small">{a.user}</td><td><Pill k={k}>{label}</Pill></td>
                  <td className="small">{OBJ[a.object] ?? a.object}</td><td className="mono small"><AuditRef a={a} /></td><td className="small"><DocText text={a.detail} /></td>
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
