/** Shared bits of the purchasing screens: BR-10 banner, AP due card, file helpers, error-file download. */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { GrAlert, PurchasingDashboard } from '@erp/contracts';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { fmt, th } from '../../ui';
import './purchasing.css';

export const useGrAlert = () => useQuery({ queryKey: ['pu', 'gr-alert'], queryFn: () => api('GET', '/api/purchasing/gr-alerts', { schema: GrAlert }), staleTime: 30_000 });
export const useDashboard = () => useQuery({ queryKey: ['pu', 'dashboard'], queryFn: () => api('GET', '/api/purchasing/dashboard', { schema: PurchasingDashboard }), staleTime: 30_000 });

/** BR-10 / REQ-M05-09: draft receipts waiting more than 2 days. Shown until someone confirms them. */
export function GrAlertBanner({ link = true }: { link?: boolean }) {
  const a = useGrAlert();
  if (!a.data?.count) return null;
  return (
    <div className="note bad pu-banner" role="alert" data-testid="gr-alert">
      <span>
        <b>ของรอยืนยันรับเกิน {a.data.days} วัน {a.data.count} ใบ</b>
        {' · '}{a.data.items.slice(0, 5).map((g) => `${g.dnNo ?? 'ไม่มีเลข DN'} (${g.ageDays} วัน)`).join(', ')}
        {' · '}สต็อกในระบบยังไม่รวมของชุดนี้ และขายติดลบไม่ได้
      </span>
      {link && <Link className="btn sm pri" to="/purchasing">ไปยืนยันรับ</Link>}
    </div>
  );
}

/** REQ-M18-04: home card "เจ้าหนี้ครบกำหนดใน 7 วัน" (needs fin.ap). */
export function ApDueCard() {
  const { can } = useAuth();
  const q = useDashboard();
  if (!can('fin.ap') || !q.data) return null;
  return (
    <div className="card kpi" data-testid="ap-due-card">
      <div className="l">เจ้าหนี้ครบกำหนดใน 7 วัน</div>
      <div className="v">฿{fmt(q.data.apDue7.amount)}</div>
      <div className="s">{q.data.apDue7.count} ใบ{q.data.apOverdue.count ? ` · เกินกำหนดแล้ว ${q.data.apOverdue.count} ใบ ฿${fmt(q.data.apOverdue.amount)}` : ''} · <Link to="/ap">ไปจ่ายเงิน</Link></div>
    </div>
  );
}

export function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('อ่านไฟล์ไม่ได้'));
    r.readAsDataURL(file);
  });
}

export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const csvCell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
/** "ไฟล์ error": the original columns + an `error` column, UTF-8 with BOM so Excel shows Thai. */
export function downloadErrorRows(fileName: string, headers: string[], rows: { rowNo: number; cells: string[]; messages: string[] }[]) {
  const lines = [[ 'แถว', ...headers, 'error'], ...rows.map((r) => [String(r.rowNo), ...r.cells, r.messages.join(' / ')])];
  const text = '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
  saveBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), fileName.replace(/\.(csv|xlsx|txt)$/i, '') + '-error.csv');
}

export const STATUS_TH = { ok: 'พร้อม', warn: 'เตือน', error: 'ผิด', exists: 'มีอยู่แล้ว' } as const;
export const STATUS_PILL = { ok: 'ok', warn: 'warn', error: 'bad', exists: 'mut' } as const;

export const ageText = (days: number) => (days ? `${days} วัน` : 'วันนี้');
export const thOrDash = (s: string | null | undefined) => (s ? th(s) : '-');
