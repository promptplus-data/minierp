/** M10 ลูกหนี้ / รับชำระ: aging, open invoices, billing notes (BN print), receipts with WHT (RE print), statement. */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  ArAging, ArBillingNote, ArBillingNoteSummary, ArDueSoon, ArOpenInvoice, ArReceipt, ArReceiptSummary, ArStatement, page,
} from '@erp/contracts';
import { AGING_BUCKETS, AGING_LABEL_TH, d, receiptTotals, type AgingBucket } from '@erp/core';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { useCustomers } from '../../data';
import { fmt, Modal, Pager, Pill, SkeletonRows, th, useCursorPager, useDebounced, useToast } from '../../ui';
import { CustomerSelect, Paper, PrintModal, TERM_TH, useSalesInvalidate, VoidDocModal, VoidedNote, VoidPill } from './shared';
import { ErrorBanner } from '../../errors';
import { DocLink, DocLinks } from '../../doclink';

type Tab = 'cust' | 'inv' | 'bn' | 'rc';
const TABS: [Tab, string][] = [['cust', 'ลูกหนี้รายลูกค้า'], ['inv', 'ใบแจ้งหนี้ค้างชำระ'], ['bn', 'ใบวางบิล'], ['rc', 'ใบเสร็จรับเงิน']];
const RC_METHOD: Record<string, string> = { transfer: 'โอนเงิน', cash: 'เงินสด', cheque: 'เช็ค', promptpay: 'พร้อมเพย์', card: 'บัตร' };
const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const overduePill = (days: number) => (days > 0 ? <Pill k="bad">เกิน {days} วัน</Pill> : <Pill k="ok">ยังไม่ครบ</Pill>);

export default function Ar() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (TABS.find(([k]) => k === sp.get('tab'))?.[0] ?? 'cust') as Tab;
  const [bucket, setBucket] = useState<AgingBucket | ''>('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const [modal, setModal] = useState<null | { kind: 'bn' | 'rc' | 'st'; customerId: string }>(null);
  const canAr = can('fin.ar') === 1;
  const setTab = (t: Tab, extra: Record<string, string> = {}) => setSp({ tab: t, ...extra }, { replace: true });
  // deep link from an invoice: /ar?customer=<id>&receive=1
  useEffect(() => {
    const c = sp.get('customer');
    if (c && sp.get('receive') && canAr) {
      setModal({ kind: 'rc', customerId: c });
      setSp({ tab }, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const due = useQuery({ queryKey: ['ar', 'due-soon'], queryFn: () => api('GET', '/api/ar/due-soon', { query: { days: 7 }, schema: ArDueSoon }) });
  const totals = useQuery({ queryKey: ['ar', 'aging-totals'], queryFn: () => api('GET', '/api/ar/aging', { query: { limit: 1 }, schema: ArAging }) });
  const t = totals.data?.totals;
  return (
    <>
      <div className="ar-due" data-testid="ar-due">
        <div className="card kpi warn"><div className="l">ครบกำหนดใน 7 วัน</div><div className="v">{due.data ? `฿${fmt(due.data.dueSoon.amount)}` : <span className="sk" style={{ display: 'inline-block', width: 120 }} />}</div>
          <div className="s">{due.data ? `${due.data.dueSoon.customers} ราย · ${due.data.dueSoon.invoices} ใบ` : ''}</div></div>
        <div className="card kpi bad"><div className="l">เกินกำหนดชำระ</div><div className="v">{due.data ? `฿${fmt(due.data.overdue.amount)}` : <span className="sk" style={{ display: 'inline-block', width: 120 }} />}</div>
          <div className="s">{due.data ? `${due.data.overdue.customers} ราย · ${due.data.overdue.invoices} ใบ` : ''}</div></div>
      </div>
      <div className="card">
        <h2><span>อายุลูกหนี้ {t && <span className="small muted">ณ {th(totals.data!.asOf)} · รวม ฿{fmt(t.total)}</span>}</span></h2>
        <div className="aging" data-testid="ar-aging">
          {AGING_BUCKETS.map((b, i) => (
            <button key={b} className={`agb${bucket === b ? ' on' : ''}${i >= 2 ? ' bad' : i === 1 ? ' warn' : ''}`} onClick={() => { setBucket(bucket === b ? '' : b); setTab('inv'); }} data-testid={`aging-${b}`}>
              <span className="l">{AGING_LABEL_TH[b]}</span>
              <span className="v">{t ? `฿${fmt(t[b])}` : '…'}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="card">
        <h2>
          <span>ลูกหนี้และการรับชำระ</span>
          <span className="row">
            {!canAr && <Pill k="acc">ดูอย่างเดียว</Pill>}
            {canAr && <button className="btn" onClick={() => setModal({ kind: 'bn', customerId: '' })} data-testid="new-bn">+ ใบวางบิล</button>}
            {canAr && <button className="btn pri" onClick={() => setModal({ kind: 'rc', customerId: '' })} data-testid="new-rc">+ รับชำระ</button>}
          </span>
        </h2>
        <div className="tabs sales-tabs" role="tablist">
          {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)} data-testid={`ar-tab-${k}`}>{l}</button>)}
        </div>
        <div className="row" style={{ marginBottom: 10 }}>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === 'cust' ? 'ค้นชื่อหรือรหัสลูกค้า' : 'ค้นเลขที่ ลูกค้า หรือยอดเงิน'} style={{ flex: 1, minWidth: 200 }} aria-label="ค้นหา" data-testid="ar-search" />
          {tab === 'inv' && (
            <div className="steps">
              {([['', 'ทั้งหมด'], ...AGING_BUCKETS.map((b) => [b, AGING_LABEL_TH[b]])] as [AgingBucket | '', string][]).map(([k, l]) => (
                <span key={k} role="button" tabIndex={0} className={bucket === k ? 'on' : ''} onClick={() => setBucket(k)} onKeyDown={(e) => { if (e.key === 'Enter') setBucket(k); }}>{l}</span>
              ))}
            </div>
          )}
        </div>
        {tab === 'cust' && <CustomerTable q={dq} canAr={canAr} act={(kind, customerId) => setModal({ kind, customerId })} />}
        {tab === 'inv' && <InvoiceTable q={dq} bucket={bucket} />}
        {tab === 'bn' && <BnTable q={dq} />}
        {tab === 'rc' && <RcTable q={dq} />}
      </div>
      {modal?.kind === 'bn' && <BillingNoteModal customerId={modal.customerId} onClose={() => setModal(null)} />}
      {modal?.kind === 'rc' && <ReceiptModal customerId={modal.customerId} onClose={() => setModal(null)} />}
      {modal?.kind === 'st' && <StatementModal customerId={modal.customerId} onClose={() => setModal(null)} />}
    </>
  );
}

function useList<T>(key: string, url: string, schema: z.ZodType<{ items: T[]; nextCursor: string | null }, z.ZodTypeDef, unknown>, query: Record<string, unknown>) {
  const pager = useCursorPager(`${key}|${JSON.stringify(query)}`);
  const list = useQuery({
    queryKey: ['ar', key, query, pager.cursor],
    queryFn: () => api('GET', url, { query: { ...query, limit: 20, cursor: pager.cursor }, schema }),
    placeholderData: keepPreviousData,
  });
  const loading = list.isLoading || (list.isFetching && list.isPlaceholderData);
  const items = list.data?.items ?? [];
  const pagerEl = <Pager page={pager.page} hasNext={!!list.data?.nextCursor} count={items.length} loading={list.isFetching} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor ?? null)} />;
  return { list, loading, items, pagerEl };
}

function Table({ testId, head, cols, loading, empty, children, error }: { testId: string; head: ReactNode; cols: number; loading: boolean; empty: boolean; children: ReactNode; error?: unknown }) {
  return (
    <>
      {!!error && <div className="note bad small">{errText(error)}</div>}
      <div className="tw">
        <table data-testid={testId}>
          <thead>{head}</thead>
          <tbody>
            {loading ? <SkeletonRows cols={cols} /> : children}
            {!loading && empty && <tr><td colSpan={cols} className="empty">ไม่มีรายการ</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function CustomerTable({ q, canAr, act }: { q: string; canAr: boolean; act: (k: 'bn' | 'rc' | 'st', id: string) => void }) {
  const { list, loading, items, pagerEl } = useList('aging', '/api/ar/aging', ArAging, { q });
  return (
    <>
      <Table testId="ar-cust" cols={6} loading={loading} empty={!items.length} error={list.error}
        head={<tr><th>ลูกค้า</th><th className="n">วงเงิน</th><th className="n">ค้างรวม</th><th className="n">เกินกำหนด</th><th className="n">ใช้วงเงิน</th><th className="hide-m" /></tr>}>
        {items.map((r) => {
          const over = d(r.balance).minus(d(r.buckets.notDue));
          const pct = d(r.limit).gt(0) ? Math.round(d(r.balance).div(d(r.limit)).times(100).toNumber()) : null;
          return (
            <tr key={r.customer.id}>
              <td>{r.customer.name}<div className="small muted">{r.customer.code} · {TERM_TH(r.term)} · {r.invoices} ใบ</div>
                <span className="actions only-m">
                  {canAr && <button className="btn sm" onClick={() => act('bn', r.customer.id)} data-testid={`bn-${r.customer.code}`}>ออกใบวางบิล</button>}
                  {canAr && <button className="btn sm pri" onClick={() => act('rc', r.customer.id)} data-testid={`rc-${r.customer.code}`}>รับชำระ</button>}
                  <button className="btn sm" onClick={() => act('st', r.customer.id)}>เดินบัญชี</button>
                </span>
              </td>
              <td className="n">{d(r.limit).gt(0) ? fmt(r.limit) : 'ไม่กำหนด'}</td>
              <td className="n"><b>{fmt(r.balance)}</b></td>
              <td className="n">{over.gt(0) ? <span style={{ color: 'var(--bad)' }}>{fmt(over)}</span> : '-'}</td>
              <td className="n">{pct == null ? <Pill k="mut">ไม่กำหนดวงเงิน</Pill> : <Pill k={pct > 100 ? 'bad' : pct > 80 ? 'warn' : 'ok'}>{pct}%</Pill>}</td>
              <td className="hide-m">
                <span className="actions">
                  <button className="btn sm" onClick={() => act('st', r.customer.id)}>รายการเดินบัญชี</button>
                  {canAr && <button className="btn sm" onClick={() => act('bn', r.customer.id)} data-testid={`bn-${r.customer.code}`}>ออกใบวางบิล</button>}
                  {canAr && <button className="btn sm pri" onClick={() => act('rc', r.customer.id)} data-testid={`rc-${r.customer.code}`}>รับชำระ</button>}
                </span>
              </td>
            </tr>
          );
        })}
      </Table>
      {pagerEl}
    </>
  );
}

function InvoiceTable({ q, bucket }: { q: string; bucket: AgingBucket | '' }) {
  const nav = useNavigate();
  const { list, loading, items, pagerEl } = useList('open', '/api/ar/invoices', page(ArOpenInvoice), { q, bucket: bucket || undefined });
  return (
    <>
      <Table testId="ar-inv" cols={7} loading={loading} empty={!items.length} error={list.error}
        head={<tr><th>เลขที่</th><th>ลูกค้า</th><th>วันที่</th><th>ครบกำหนด</th><th className="n">ยอด</th><th className="n">คงค้าง</th><th>สถานะ</th></tr>}>
        {items.map((x) => (
          <tr key={x.id} className="click" onClick={() => nav(`/b2b/inv/${encodeURIComponent(x.no)}`)}>
            <td className="mono"><Link to={`/b2b/inv/${encodeURIComponent(x.no)}`}>{x.no}</Link>{x.billingNoteNo && <div className="small muted">วางบิล <DocLink no={x.billingNoteNo} type="BN" /></div>}</td>
            <td>{x.customer.name}{x.projectName && <div className="small muted">{x.projectName}</div>}</td><td>{th(x.date)}</td><td>{th(x.dueDate)}</td>
            <td className="n">{fmt(x.total)}</td><td className="n"><b>{fmt(x.arBalance)}</b></td><td>{overduePill(x.overdueDays)}</td>
          </tr>
        ))}
      </Table>
      {pagerEl}
    </>
  );
}

function BnTable({ q }: { q: string }) {
  const nav = useNavigate();
  const { list, loading, items, pagerEl } = useList('bns', '/api/ar/billing-notes', page(ArBillingNoteSummary), { q });
  return (
    <>
      <Table testId="ar-bn" cols={6} loading={loading} empty={!items.length} error={list.error}
        head={<tr><th>เลขที่</th><th>วันที่</th><th>ลูกค้า</th><th>นัดรับเช็ค</th><th className="n">ใบกำกับ</th><th className="n">ยอดวางบิล</th></tr>}>
        {items.map((x) => (
          <tr key={x.id} className="click" onClick={() => nav(`/ar/bn/${encodeURIComponent(x.no)}`)} style={x.status === 'void' ? { opacity: 0.65 } : undefined}>
            <td className="mono"><Link to={`/ar/bn/${encodeURIComponent(x.no)}`}>{x.no}</Link> {x.status === 'void' && <VoidPill />}</td><td>{th(x.date)}</td><td>{x.customer.name}</td>
            <td>{x.collectDate ? th(x.collectDate) : '-'}</td><td className="n">{x.count}</td><td className="n">{fmt(x.total)}</td>
          </tr>
        ))}
      </Table>
      {pagerEl}
    </>
  );
}

function RcTable({ q }: { q: string }) {
  const nav = useNavigate();
  const { list, loading, items, pagerEl } = useList('rcs', '/api/ar/receipts', page(ArReceiptSummary), { q });
  return (
    <>
      <Table testId="ar-rc" cols={7} loading={loading} empty={!items.length} error={list.error}
        head={<tr><th>เลขที่</th><th>วันที่</th><th>ลูกค้า</th><th>ใบกำกับ</th><th>วิธีรับ</th><th className="n">หัก ณ ที่จ่าย</th><th className="n">ตัดหนี้</th></tr>}>
        {items.map((x) => (
          <tr key={x.id} className="click" onClick={() => nav(`/ar/rc/${encodeURIComponent(x.no)}`)} style={x.status === 'void' ? { opacity: 0.65 } : undefined}>
            <td className="mono"><Link to={`/ar/rc/${encodeURIComponent(x.no)}`}>{x.no}</Link> {x.status === 'void' && <VoidPill />}</td><td>{th(x.date)}</td><td>{x.customer.name}</td>
            <td className="mono small"><DocLinks nos={x.invoices.split(/,\s*/)} type="INV" /></td><td>{RC_METHOD[x.method]}</td><td className="n">{d(x.wht).gt(0) ? fmt(x.wht) : '-'}</td><td className="n">{fmt(x.settled)}</td>
          </tr>
        ))}
      </Table>
      {pagerEl}
    </>
  );
}

/** Customers that have open invoices, for the modal pickers. */
function useOpenInvoices(customerId: string, unbilled?: boolean) {
  return useQuery({
    queryKey: ['ar', 'open-of', customerId, !!unbilled], enabled: !!customerId,
    queryFn: () => api('GET', '/api/ar/invoices', { query: { customerId, unbilled: unbilled || undefined, limit: 100 }, schema: page(ArOpenInvoice) }),
  });
}

/** New billing note over several unbilled invoices of one customer (REQ-M10-01). */
function BillingNoteModal({ customerId: initial, onClose }: { customerId: string; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const invalidate = useSalesInvalidate();
  const [customerId, setCustomerId] = useState(initial);
  const inv = useOpenInvoices(customerId, true);
  const items = inv.data?.items ?? [];
  const [sel, setSel] = useState<string[] | null>(null);
  const chosen = sel ?? items.map((x) => x.no);
  const [collect, setCollect] = useState(addDays(today(), 7));
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const total = items.filter((x) => chosen.includes(x.no)).reduce((a, x) => a.plus(d(x.arBalance)), d(0));
  const go = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/ar/billing-notes', { body: { customerId, invoiceNos: chosen, collectDate: collect || undefined, note }, schema: ArBillingNote });
      await invalidate();
      toast(`${r.no} ออกแล้ว`);
      onClose();
      nav(`/ar/bn/${encodeURIComponent(r.no)}`);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} wide label="ออกใบวางบิล">
      <h3>ออกใบวางบิล</h3>
      <p className="small muted" style={{ margin: 0 }}>รวมใบกำกับที่ยังไม่ได้วางบิลของลูกค้ารายเดียวกัน · กำหนดวันนัดรับเช็คได้</p>
      <div className="fgrid">
        <label className="f">ลูกค้า<CustomerSelect value={customerId} onChange={(id) => { setCustomerId(id); setSel(null); }} noCash testId="bn-customer" /></label>
        <label className="f">นัดรับเช็ค / ชำระภายใน<input type="date" value={collect} onChange={(e) => setCollect(e.target.value)} data-testid="bn-collect" /></label>
        <label className="f">หมายเหตุ<input type="text" value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      {customerId && (
        <div className="tw">
          <table data-testid="bn-invoices">
            <thead><tr><th /><th>ใบกำกับ</th><th>วันที่</th><th>ครบกำหนด</th><th className="n">ยอด</th><th className="n">คงค้าง</th></tr></thead>
            <tbody>
              {inv.isLoading ? <SkeletonRows cols={6} rows={3} /> : items.map((x) => (
                <tr key={x.id}>
                  <td><input type="checkbox" checked={chosen.includes(x.no)} onChange={(e) => setSel(e.target.checked ? [...chosen, x.no] : chosen.filter((n) => n !== x.no))} aria-label={`เลือก ${x.no}`} /></td>
                  <td className="mono"><DocLink no={x.no} type="INV" /></td><td>{th(x.date)}</td><td>{th(x.dueDate)} {x.overdueDays > 0 && <Pill k="bad">เกิน {x.overdueDays} วัน</Pill>}</td><td className="n">{fmt(x.total)}</td><td className="n">{fmt(x.arBalance)}</td>
                </tr>
              ))}
              {!inv.isLoading && !items.length && <tr><td colSpan={6} className="empty">ไม่มีใบกำกับที่ยังไม่ได้วางบิล</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}><span>รวมยอดวางบิล <b className="big" data-testid="bn-total">฿{fmt(total)}</b></span></div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={busy || !customerId || !chosen.length} onClick={() => void go()} data-testid="bn-save">ออกใบวางบิล</button></div>
    </Modal>
  );
}

/** Receipt over several invoices, partial amounts allowed, WHT 1% / 3% / typed amount on the pre-VAT share (REQ-M10-02/03). */
function ReceiptModal({ customerId: initial, onClose }: { customerId: string; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const invalidate = useSalesInvalidate();
  const [customerId, setCustomerId] = useState(initial);
  const inv = useOpenInvoices(customerId);
  const items = useMemo(() => inv.data?.items ?? [], [inv.data]);
  const [amt, setAmt] = useState<Record<string, string>>({});
  const [on, setOn] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setAmt(Object.fromEntries(items.map((x) => [x.no, x.arBalance])));
    setOn(Object.fromEntries(items.map((x) => [x.no, true])));
  }, [items]);
  const [method, setMethod] = useState<'transfer' | 'cash' | 'cheque' | 'promptpay' | 'card'>('transfer');
  const [cheque, setCheque] = useState({ no: '', bank: '', date: today() });
  const [whtMode, setWhtMode] = useState<'none' | '1' | '3' | 'amount'>('none');
  const [whtAmt, setWhtAmt] = useState('');
  const [cert, setCert] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const lines = items.filter((x) => on[x.no] && d(amt[x.no] || 0).gt(0));
  const over = lines.find((x) => d(amt[x.no] || 0).gt(d(x.arBalance)));
  const wht = whtMode === 'none' ? { mode: 'none' as const } : whtMode === 'amount' ? { mode: 'amount' as const, amount: whtAmt || '0' } : { mode: 'rate' as const, rate: whtMode };
  let t: ReturnType<typeof receiptTotals> | null = null;
  let tErr = '';
  try {
    t = receiptTotals(lines.map((x) => ({ settled: amt[x.no]!, invoiceTotal: x.total, invoiceVat: x.vat })), wht);
  } catch (e) {
    tErr = e instanceof Error ? e.message : String(e);
  }
  const go = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/ar/receipts', {
        body: {
          customerId, method, lines: lines.map((x) => ({ invoiceNo: x.no, amount: amt[x.no] })), wht, ...(method === 'cheque' ? { cheque } : {}),
          ...(cert.trim() ? { whtCertNo: cert.trim() } : {}),
        },
        schema: ArReceipt,
      });
      await invalidate();
      toast(`${r.no} ใบเสร็จรับเงินออกแล้ว`);
      onClose();
      nav(`/ar/rc/${encodeURIComponent(r.no)}`);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const chequeOk = method !== 'cheque' || (cheque.no.trim() && cheque.bank.trim() && cheque.date);
  return (
    <Modal onClose={onClose} wide label="รับชำระ">
      <h3>รับชำระหนี้</h3>
      <label className="f">ลูกค้า<CustomerSelect value={customerId} onChange={setCustomerId} noCash testId="rc-customer" /></label>
      {customerId && (
        <div className="tw">
          <table data-testid="rc-invoices">
            <thead><tr><th /><th>ใบกำกับ</th><th>ครบกำหนด</th><th className="n">คงค้าง</th><th className="n">รับครั้งนี้</th></tr></thead>
            <tbody>
              {inv.isLoading ? <SkeletonRows cols={5} rows={3} /> : items.map((x, i) => (
                <tr key={x.id}>
                  <td><input type="checkbox" checked={!!on[x.no]} onChange={(e) => setOn({ ...on, [x.no]: e.target.checked })} aria-label={`เลือก ${x.no}`} /></td>
                  <td className="mono"><DocLink no={x.no} type="INV" />{x.billingNoteNo && <div className="small muted"><DocLink no={x.billingNoteNo} type="BN" /></div>}</td><td>{th(x.dueDate)} {x.overdueDays > 0 && <Pill k="bad">เกิน {x.overdueDays} วัน</Pill>}</td>
                  <td className="n">{fmt(x.arBalance)}</td>
                  <td className="n"><input className={`qty${d(amt[x.no] || 0).gt(d(x.arBalance)) ? ' bad' : ''}`} type="number" min="0" step="0.01" style={{ width: 110 }} data-invoice={x.no} value={amt[x.no] ?? ''} disabled={!on[x.no]} onChange={(e) => setAmt({ ...amt, [x.no]: e.target.value })} aria-label={`ยอดรับ ${x.no}`} data-testid={`rc-amt-${i}`} /></td>
                </tr>
              ))}
              {!inv.isLoading && !items.length && <tr><td colSpan={5} className="empty">ลูกค้ารายนี้ไม่มียอดค้างชำระ</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <div className="fgrid">
        <label className="f">วิธีรับเงิน
          <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)} data-testid="rc-method">{Object.entries(RC_METHOD).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </label>
        <label className="f">หัก ณ ที่จ่าย
          <select value={whtMode} onChange={(e) => setWhtMode(e.target.value as typeof whtMode)} data-testid="rc-wht">
            <option value="none">ไม่มี</option><option value="1">1% (ค่าขนส่ง)</option><option value="3">3% (ค่าบริการ/รับเหมา)</option><option value="amount">กรอกยอดเอง</option>
          </select>
        </label>
        {whtMode === 'amount' && <label className="f">ยอดหัก ณ ที่จ่าย<input type="number" min="0" step="0.01" value={whtAmt} onChange={(e) => setWhtAmt(e.target.value)} data-testid="rc-wht-amt" /></label>}
        {whtMode !== 'none' && <label className="f">เลขที่หนังสือรับรอง (50 ทวิ)<input type="text" value={cert} onChange={(e) => setCert(e.target.value)} placeholder="เช่น 2569/0153" data-testid="rc-cert" /></label>}
      </div>
      {method === 'cheque' && (
        <div className="fgrid">
          <label className="f">เลขที่เช็ค<input type="text" value={cheque.no} onChange={(e) => setCheque({ ...cheque, no: e.target.value })} data-testid="rc-chq-no" /></label>
          <label className="f">ธนาคาร<input type="text" value={cheque.bank} onChange={(e) => setCheque({ ...cheque, bank: e.target.value })} data-testid="rc-chq-bank" /></label>
          <label className="f">ลงวันที่<input type="date" value={cheque.date} onChange={(e) => setCheque({ ...cheque, date: e.target.value })} /></label>
        </div>
      )}
      <div className="tot" style={{ maxWidth: 380, marginLeft: 'auto' }}>
        <span className="muted">ยอดที่ตัดหนี้</span><span data-testid="rc-settled">{fmt(t?.settled ?? '0')}</span>
        {whtMode !== 'none' && <><span className="muted">หัก ณ ที่จ่าย (คิดจากยอดก่อน VAT {fmt(t?.whtBase ?? '0')})</span><span data-testid="rc-wht-val">−{fmt(t?.wht ?? '0')}</span></>}
        <span style={{ fontWeight: 600 }}>รับเงินจริง</span><span className="big" data-testid="rc-cash">฿{fmt(t?.cash ?? '0')}</span>
      </div>
      {whtMode !== 'none' && <div className="note small">ขอหนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) จากลูกค้า · เงินที่รับ + ภาษีที่ถูกหัก = ยอดที่ตัดหนี้</div>}
      {over && <div className="err">{over.no}: ยอดรับมากกว่ายอดคงค้าง</div>}
      {tErr && <div className="err">{tErr}</div>}
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={busy || !lines.length || !!over || !t || !chequeOk} onClick={() => void go()} data-testid="rc-save">ออกใบเสร็จรับเงิน</button></div>
    </Modal>
  );
}

const ST_KIND: Record<string, string> = { INV: 'ใบกำกับ', CN: 'ลดหนี้', RC: 'รับชำระ', WHT: 'หัก ณ ที่จ่าย', VOID: 'ยกเลิก' };
function StatementModal({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const cs = useCustomers();
  const [from, setFrom] = useState(addDays(today(), -90));
  const [to, setTo] = useState(today());
  const st = useQuery({ queryKey: ['ar', 'statement', customerId, from, to], queryFn: () => api('GET', '/api/ar/statement', { query: { customerId, from, to }, schema: ArStatement }) });
  const name = cs.data?.find((c) => c.id === customerId)?.name ?? '';
  return (
    <Modal onClose={onClose} wide label="รายการเดินบัญชีลูกหนี้">
      <h3>รายการเดินบัญชี · {name}</h3>
      <div className="row"><label className="f">ตั้งแต่<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label className="f">ถึง<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label></div>
      {st.isError && <ErrorBanner error={st.error} onRetry={() => void st.refetch()} retrying={st.isFetching} />}
      <div className="tw">
        <table>
          <thead><tr><th>วันที่</th><th>เอกสาร</th><th>รายการ</th><th className="n">เพิ่มหนี้</th><th className="n">ลดหนี้</th><th className="n">คงเหลือ</th></tr></thead>
          <tbody>
            {st.isLoading ? <SkeletonRows cols={6} rows={4} /> : st.data && (
              <>
                <tr><td colSpan={5} className="muted">ยอดยกมา</td><td className="n">{fmt(st.data.opening)}</td></tr>
                {st.data.lines.map((l, i) => (
                  <tr key={i}><td>{th(l.date)}</td><td className="mono"><DocLink no={l.no} /></td><td>{ST_KIND[l.kind]}{l.ref ? <> · <DocLink no={l.ref} /></> : null}{l.note ? <div className="small muted">{l.note}</div> : null}</td>
                    <td className="n">{d(l.debit).gt(0) ? fmt(l.debit) : ''}</td><td className="n">{d(l.credit).gt(0) ? fmt(l.credit) : ''}</td><td className="n">{fmt(l.balance)}</td></tr>
                ))}
                <tr><td colSpan={5}><b>ยอดคงเหลือ</b></td><td className="n"><b>{fmt(st.data.closing)}</b></td></tr>
              </>
            )}
          </tbody>
        </table>
      </div>
      <div className="act"><button className="btn pri" onClick={onClose}>ปิด</button></div>
    </Modal>
  );
}

// ---------- billing note / receipt pages with A4 prints ----------
const Back = ({ tab }: { tab: Tab }) => <Link to={`/ar?tab=${tab}`} className="btn sm">‹ กลับ</Link>;

export function BillingNoteDetail() {
  const { no = '' } = useParams();
  const { can } = useAuth();
  const invalidate = useSalesInvalidate();
  const [m, setM] = useState<null | 'print' | 'void'>(null);
  const q = useQuery({ queryKey: ['ar', 'bn', no], queryFn: () => api('GET', `/api/ar/billing-notes/${encodeURIComponent(no)}`, { schema: ArBillingNote }) });
  if (q.isLoading) return <div className="card"><div className="sk" /><div className="sk" /></div>;
  if (!q.data) return <div className="card"><ErrorBanner error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} /><p><Link to="/ar?tab=bn">‹ กลับ</Link></p></div>;
  const x = q.data;
  const live = x.status === 'active';
  return (
    <>
      <div className="card">
        <h2>
          <span className="row"><Back tab="bn" /> ใบวางบิล <b className="mono" data-testid="doc-no">{x.no}</b> {!live && <VoidPill />}</span>
          <span className="actions">
            <button className="btn sm" onClick={() => setM('print')} data-testid="print">พิมพ์ / PDF</button>
            {live && can('fin.ar') === 1 && <button className="btn sm bad" onClick={() => setM('void')} data-testid="void">ยกเลิก</button>}
          </span>
        </h2>
        <VoidedNote v={x.voided} />
      </div>
      <div className="card"><Paper {...bnPaper(x)} /></div>
      {m === 'print' && <PrintModal title={x.no} onClose={() => setM(null)}><Paper {...bnPaper(x)} /></PrintModal>}
      {m === 'void' && <VoidDocModal what={x.no} url={`/api/ar/billing-notes/${encodeURIComponent(x.no)}/void`} perm="fin.ar" total={x.total} onClose={() => setM(null)} onDone={() => void invalidate()} effects={['ใบกำกับในใบนี้กลับไปรอวางบิล ยอดลูกหนี้ไม่เปลี่ยน']} />}
    </>
  );
}

function bnPaper(x: ArBillingNote) {
  return {
    title: 'ใบวางบิล / ใบแจ้งหนี้', no: x.no, date: x.date, voided: x.status === 'void',
    party: { label: 'ลูกค้า', name: x.customer.name, tax: x.customer.taxId, br: x.customer.branch, tel: x.customer.phone },
    refs: [...(x.collectDate ? [['นัดชำระภายใน', th(x.collectDate)]] : []), ['จำนวนใบกำกับ', `${x.lines.length} ใบ`]] as [string, ReactNode][],
    cols: 'price' as const, extraCol: 'ครบกำหนด',
    rows: x.lines.map((l) => ({ name: `ใบกำกับภาษี ${l.invoiceNo} ลงวันที่ ${th(l.invoiceDate)}`, desc: d(l.amount).lt(d(l.invoiceTotal)) ? `ยอดเต็ม ${fmt(l.invoiceTotal)} · คงค้าง` : undefined, qty: '1', unit: 'ใบ', price: l.amount, amt: l.amount, extra: th(l.dueDate) })),
    totals: [['รวมยอดวางบิล', fmt(x.total), true]] as [string, string, boolean?][], baht: x.total, bank: true, note: x.note || undefined, sign: ['ผู้วางบิล', 'ผู้รับวางบิล'],
  };
}

export function ReceiptDetail() {
  const { no = '' } = useParams();
  const { can } = useAuth();
  const invalidate = useSalesInvalidate();
  const [m, setM] = useState<null | 'print' | 'void'>(null);
  const q = useQuery({ queryKey: ['ar', 'rc', no], queryFn: () => api('GET', `/api/ar/receipts/${encodeURIComponent(no)}`, { schema: ArReceipt }) });
  if (q.isLoading) return <div className="card"><div className="sk" /><div className="sk" /></div>;
  if (!q.data) return <div className="card"><ErrorBanner error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} /><p><Link to="/ar?tab=rc">‹ กลับ</Link></p></div>;
  const x = q.data;
  const live = x.status === 'active';
  return (
    <>
      <div className="card">
        <h2>
          <span className="row"><Back tab="rc" /> ใบเสร็จรับเงิน <b className="mono" data-testid="doc-no">{x.no}</b> {!live && <VoidPill />}</span>
          <span className="actions">
            <button className="btn sm" onClick={() => setM('print')} data-testid="print">พิมพ์ / PDF</button>
            {live && can('fin.ar') === 1 && <button className="btn sm bad" onClick={() => setM('void')} data-testid="void">ยกเลิก</button>}
          </span>
        </h2>
        <div className="kv">
          <span>ลูกค้า</span><span>{x.customer.name}</span>
          <span>ตัดหนี้</span><span><b data-testid="rc-settled-v">{fmt(x.settled)}</b> · รับเงินจริง {fmt(x.cash)}{d(x.wht).gt(0) ? ` · หัก ณ ที่จ่าย ${fmt(x.wht)}${x.whtRate ? ` (${d(x.whtRate).toString()}%)` : ''}` : ''}</span>
          {x.whtCertNo && <><span>หนังสือรับรอง 50 ทวิ</span><span>{x.whtCertNo}</span></>}
          <span>ใบกำกับ</span><span>{x.lines.map((l, i) => <span key={l.invoiceNo}>{i > 0 && ', '}<DocLink no={l.invoiceNo} type="INV" /></span>)}</span>
        </div>
        <VoidedNote v={x.voided} />
      </div>
      <div className="card"><Paper {...rcPaper(x)} /></div>
      {m === 'print' && <PrintModal title={x.no} onClose={() => setM(null)}><Paper {...rcPaper(x)} /></PrintModal>}
      {m === 'void' && <VoidDocModal what={x.no} url={`/api/ar/receipts/${encodeURIComponent(x.no)}/void`} perm="fin.ar" total={x.settled} onClose={() => setM(null)} onDone={() => void invalidate()} effects={['ยอดค้างของใบกำกับกลับมาเท่าเดิม']} />}
    </>
  );
}

function rcPaper(x: ArReceipt) {
  const wht = d(x.wht).gt(0);
  return {
    title: 'ใบเสร็จรับเงิน', no: x.no, date: x.date, voided: x.status === 'void',
    party: { label: 'ได้รับเงินจาก', name: x.customer.name, tax: x.customer.taxId, br: x.customer.branch, tel: x.customer.phone },
    refs: [['วิธีรับเงิน', RC_METHOD[x.method] + (x.cheque ? ` · เช็ค ${x.cheque.bank} เลขที่ ${x.cheque.no} ลงวันที่ ${th(x.cheque.date)}` : '')], ...(x.whtCertNo ? [['หนังสือรับรอง 50 ทวิ', x.whtCertNo]] : [])] as [string, ReactNode][],
    cols: 'price' as const,
    rows: x.lines.map((l) => ({ name: `ชำระตามใบกำกับภาษี ${l.invoiceNo} ลงวันที่ ${th(l.invoiceDate)}`, desc: d(l.settled).lt(d(l.invoiceTotal)) ? `ยอดเต็ม ${fmt(l.invoiceTotal)} · ชำระบางส่วน` : undefined, qty: '1', unit: 'ใบ', price: l.settled, amt: l.settled })),
    totals: [['รวม', fmt(x.settled)], ...(wht ? [[`หัก ณ ที่จ่าย${x.whtRate ? ` ${d(x.whtRate).toString()}%` : ''}`, `−${fmt(x.wht)}`]] : []), ['รับเงินสุทธิ', fmt(x.cash), true]] as [string, string, boolean?][],
    baht: x.cash, note: x.note || undefined, sign: ['ผู้รับเงิน', 'ผู้จ่ายเงิน'],
  };
}
