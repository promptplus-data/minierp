/** CLOUD ONLY. Orders on their way from Prompt Plus (GET /api/promptplus/incoming, REQ-M05-01). */
import { useQuery } from '@tanstack/react-query';
import { api, errText } from '../api';
import { useMeta } from '../data';

interface Incoming { id: string; deliveryNo: string; vendorId: string | null; lines: { sku: string; qty: string }[] }

export default function IncomingCard() {
  const meta = useMeta();
  const enabled = !!meta.data?.capabilities.promptPlusOrders;
  const q = useQuery({
    queryKey: ['pp-incoming'],
    enabled,
    queryFn: () => api<{ items: Incoming[]; nextCursor: string | null }>('GET', '/api/promptplus/incoming'),
  });
  if (!enabled) return null;
  return (
    <div className="card" data-testid="pp-incoming">
      <h2>ของที่กำลังมาจาก Prompt Plus</h2>
      {q.isError ? <div className="note bad small">{errText(q.error)}</div> : (
        <div className="tw"><table>
          <thead><tr><th>ใบส่งของ</th><th>สถานะ</th><th>สินค้า</th></tr></thead>
          <tbody>
            {q.isLoading && <tr><td colSpan={3}><div className="sk" /></td></tr>}
            {(q.data?.items ?? []).map((i) => (
              <tr key={i.id}><td className="mono">{i.deliveryNo}</td><td><span className="pill p-warn">ส่งถึงแล้ว รอยืนยันรับ</span></td><td>{i.lines.length} รายการ</td></tr>
            ))}
            {q.data && !q.data.items.length && <tr><td colSpan={3} className="empty">ยังไม่มีของที่กำลังมาจาก Prompt Plus</td></tr>}
          </tbody>
        </table></div>
      )}
      <p className="small muted" style={{ margin: '8px 0 0' }}>การยืนยันรับของจาก Prompt Plus เข้าสต็อกอัตโนมัติเป็นเฟสถัดไป ตอนนี้บันทึกด้วย "ซื้อเข้าแบบบันทึกเอง"</p>
    </div>
  );
}
