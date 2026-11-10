/** Shared bits of the reports screens: authenticated file download, filters, period helpers. */
import { useState, type ReactNode } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import type { ReportSource } from '@erp/contracts';
import { api, getToken, errText } from '../../api';
import { useToast } from '../../ui';
import './reports.css';

/**
 * Lazy report table: the first page brings the rows and the period totals (computed on the server over every row),
 * later pages only add rows (20 at a time, `LoadMore` / infinite scroll). `data` keeps the report shape with all
 * loaded rows, and its totals always come from the server — never from summing the loaded rows.
 */
export function useReportPages<T extends { rows: unknown[]; nextCursor: string | null }>(
  name: string, path: string, query: Record<string, string | number | boolean | undefined>, schema: z.ZodType<T, z.ZodTypeDef, unknown>, enabled = true,
) {
  const r = useInfiniteQuery({
    queryKey: ['rp', name, query],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api('GET', path, { query: { ...query, cursor: pageParam, limit: 20 }, schema }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const first = r.data?.pages[0];
  const data: T | undefined = first ? { ...first, rows: r.data!.pages.flatMap((x) => x.rows) as T['rows'] } : undefined;
  return { ...r, data };
}

const bkk = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const bkkToday = () => bkk(new Date());
export const monthStart = (iso = bkkToday()) => `${iso.slice(0, 7)}-01`;
export const thisMonth = () => bkkToday().slice(0, 7);
export function prevMonth(month = thisMonth()): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
export const MONTH_TH = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
export const monthTh = (month: string) => `${MONTH_TH[Number(month.slice(5, 7)) - 1]} ${Number(month.slice(0, 4)) + 543}`;

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

/** GET a file with the session token (a plain link cannot send it) and save it. Returns the file name. */
export async function downloadFile(path: string, query: Record<string, string | number | undefined> = {}, fallback = 'report'): Promise<string> {
  const qs = Object.entries(query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
  const token = getToken();
  const res = await fetch(path + (qs ? `?${qs}` : ''), { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(res.status === 403 ? 'บทบาทนี้ดาวน์โหลดไม่ได้' : `ดาวน์โหลดไม่สำเร็จ (${res.status})`);
  const cd = res.headers.get('content-disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const plain = /filename="([^"]+)"/i.exec(cd);
  const name = star ? decodeURIComponent(star[1]!) : (plain?.[1] ?? fallback);
  saveBlob(await res.blob(), name);
  return name;
}

/** CSV and Excel download of the report with the filters on screen (every row, not just the page). */
export function DownloadButtons({ path, query, disabled, testId = 'dl' }: { path: string; query: Record<string, string | number | undefined>; disabled?: boolean; testId?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const go = async (format: 'csv' | 'xlsx') => {
    setBusy(format);
    try {
      const name = await downloadFile(path, { ...query, format });
      toast(`ดาวน์โหลด ${name} แล้ว`);
    } catch (e) {
      toast(errText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <span className="rp-dl">
      <button className="btn sm" disabled={disabled || !!busy} onClick={() => void go('csv')} data-testid={`${testId}-csv`}>{busy === 'csv' ? 'กำลังสร้าง…' : '⭳ CSV'}</button>
      <button className="btn sm" disabled={disabled || !!busy} onClick={() => void go('xlsx')} data-testid={`${testId}-xlsx`}>{busy === 'xlsx' ? 'กำลังสร้าง…' : '⭳ Excel'}</button>
    </span>
  );
}

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <label className={className}>{label}{children}</label>;
}

/** Notes for data sources that are missing on this build / this shop. */
export function SourceNotes({ sources }: { sources: ReportSource[] | undefined }) {
  const miss = (sources ?? []).filter((s) => !s.available && s.note);
  if (!miss.length) return null;
  return <div className="rp-src">{miss.map((s) => <div key={s.key} className="note warn small" style={{ marginTop: 6 }}>{s.label}: {s.note}</div>)}</div>;
}
