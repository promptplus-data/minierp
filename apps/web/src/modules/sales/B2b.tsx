/** M08 ขายส่ง / เงินเชื่อ: tabs ใบเสนอราคา / ใบสั่งขาย / ใบส่งของ / ใบกำกับภาษี / ใบลดหนี้, 20 rows at a time (load more on scroll), skeletons (NFR-12). */
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { SalesCreditNoteSummary, SalesDeliverySummary, SalesInvoiceSummary, SalesOrderSummary, SalesQuoteSummary } from '@erp/contracts';
import { useAuth } from '../../auth';
import { fmt, Pill, SkeletonRows, th, useDebounced } from '../../ui';
import { LoadMore, useLoadMore } from '../../ui/lists';
import { AbbInvoiceModal, DeliveryModal, DocFormModal, InvoiceFromDeliveriesModal, KindPill } from './Forms';
import { balPill, DLV_STATUS, QT_STATUS, SalesSettingsModal, SOURCE_TH, StatusPill, VoidPill } from './shared';
import { ErrorBanner } from '../../errors';
import { DocLink, DocLinks } from '../../doclink';

type Tab = 'qt' | 'so' | 'do' | 'inv' | 'cn';
const TABS: [Tab, string][] = [['qt', 'ใบเสนอราคา'], ['so', 'ใบสั่งขาย'], ['do', 'ใบส่งของ'], ['inv', 'ใบกำกับภาษี'], ['cn', 'ใบลดหนี้']];
const FILTERS: Record<Tab, [string, string][]> = {
  qt: [['', 'ทั้งหมด'], ['open', 'รอลูกค้า'], ['accepted', 'ลูกค้ายอมรับ'], ['expired', 'หมดอายุ'], ['lost', 'ไม่ได้งาน'], ['void', 'ยกเลิก']],
  so: [['', 'ทั้งหมด'], ['open', 'ยังส่งไม่ครบ'], ['delivered', 'ส่งครบแล้ว'], ['void', 'ยกเลิก']],
  do: [['', 'ทั้งหมด'], ['unbilled', 'รอออกใบกำกับ'], ['void', 'ยกเลิก']],
  inv: [['', 'ทั้งหมด'], ['open', 'ค้างชำระ'], ['paid', 'ชำระแล้ว'], ['goodsLeft', 'ฝากของไว้'], ['void', 'ยกเลิก']],
  cn: [['', 'ทั้งหมด']],
};
const URL: Record<Tab, string> = { qt: '/api/sales/quotations', so: '/api/sales/orders', do: '/api/sales/deliveries', inv: '/api/sales/invoices', cn: '/api/sales/credit-notes' };

export default function B2b() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (TABS.find(([k]) => k === sp.get('tab'))?.[0] ?? 'so') as Tab;
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const [modal, setModal] = useState<null | 'QT' | 'SO' | 'INV' | 'DO' | 'INVDO' | 'ABB' | 'SET'>(null);
  const canDoc = can('sales.doc') === 1;
  const canDeliver = canDoc || can('inv.receive') === 1;
  const setTab = (t: Tab) => { setStatus(''); setSp({ tab: t }, { replace: true }); };
  return (
    <>
      <div className="card">
        <h2>
          <span>เอกสารขายส่ง / เงินเชื่อ</span>
          <span className="row b2b-acts">
            {!canDoc && <Pill k="acc">ดูอย่างเดียว</Pill>}
            {canDoc && <button className="btn" onClick={() => setModal('QT')} data-testid="new-qt">+ ใบเสนอราคา</button>}
            {canDoc && <button className="btn pri" onClick={() => setModal('SO')} data-testid="new-so">+ ใบสั่งขาย</button>}
            {canDeliver && <button className="btn" onClick={() => setModal('DO')} data-testid="new-do">+ ใบส่งของ</button>}
            {canDoc && <button className="btn" onClick={() => setModal('INVDO')} data-testid="new-inv-do">ออกใบกำกับจากใบส่งของ</button>}
            {canDoc && <button className="btn" onClick={() => setModal('INV')} data-testid="new-inv">+ ใบกำกับ (ขายตรง)</button>}
            {(canDoc || can('pos.sell') === 1) && <button className="btn" onClick={() => setModal('ABB')} data-testid="new-abb-inv">ใบกำกับเต็มรูปจากอย่างย่อ</button>}
            {can('sys.settings') === 1 && <button className="btn" onClick={() => setModal('SET')} data-testid="sales-settings">ตั้งค่าเอกสารขาย</button>}
          </span>
        </h2>
        <div className="tabs sales-tabs" role="tablist">
          {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)} data-testid={`tab-${k}`}>{l}</button>)}
        </div>
        <div className="row" style={{ marginBottom: 10 }}>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นเลขที่ ลูกค้า สินค้า หรือยอดเงิน" style={{ flex: 1, minWidth: 200 }} aria-label="ค้นหาเอกสาร" data-testid="b2b-search" />
          {FILTERS[tab].length > 1 && (
            <div className="steps">
              {FILTERS[tab].map(([k, l]) => <span key={k} role="button" tabIndex={0} className={status === k ? 'on' : ''} onClick={() => setStatus(k)} onKeyDown={(e) => { if (e.key === 'Enter') setStatus(k); }}>{l}</span>)}
            </div>
          )}
        </div>
        <DocTable tab={tab} status={status} q={dq} />
      </div>
      <div className="card">
        <h2>ลำดับเอกสารขายส่ง/เงินเชื่อ</h2>
        <p className="small muted" style={{ margin: '0 0 8px' }}>เริ่มที่ใบเสนอราคา หรือสร้างใบสั่งขายได้เลยโดยไม่ต้องมีใบเสนอราคา</p>
        <div className="flowmap">
          {['ใบเสนอราคา (ไม่บังคับ)', 'ใบสั่งขาย (ตรวจวงเงิน · ต้นทุน)', 'ใบส่งของ (ตัดสต็อก · ส่งบางส่วนได้)', 'ใบกำกับภาษีเต็มรูป', 'ลูกหนี้ / รับชำระ'].map((x, i) => (
            <span key={x} className="row" style={{ gap: 6 }}>{i > 0 && <span className="arr">→</span>}<span className="box">{x}</span></span>
          ))}
        </div>
      </div>
      {(modal === 'QT' || modal === 'SO' || modal === 'INV') && <DocFormModal mode={modal} onClose={() => setModal(null)} />}
      {modal === 'DO' && <DeliveryModal onClose={() => setModal(null)} />}
      {modal === 'INVDO' && <InvoiceFromDeliveriesModal onClose={() => setModal(null)} />}
      {modal === 'ABB' && <AbbInvoiceModal onClose={() => setModal(null)} />}
      {modal === 'SET' && <SalesSettingsModal onClose={() => setModal(null)} />}
    </>
  );
}

function DocTable({ tab, status, q }: { tab: Tab; status: string; q: string }) {
  const nav = useNavigate();
  const list = useLoadMore([tab === 'qt' ? 'quotes' : tab === 'so' ? 'orders' : tab === 'do' ? 'deliveries' : tab === 'inv' ? 'invoices' : 'credit-notes', 'list', tab], URL[tab], z.unknown(), { status, q }, 20);
  const data = { items: list.rows, nextCursor: null };
  const loading = list.isLoading;
  const page = <T,>(item: z.ZodType<T, z.ZodTypeDef, unknown>) => ({ parse: (x: { items: unknown[] }) => ({ items: x.items.map((r) => item.parse(r)) }) });
  const open = (path: string) => nav(path);
  let head: ReactNode;
  let rows: ReactNode[] = [];
  const cols = 7;
  if (tab === 'qt') {
    head = <tr><th>เลขที่</th><th>วันที่</th><th>ลูกค้า</th><th>ยืนราคาถึง</th><th className="n">ยอด</th><th>สถานะ</th><th>โดย</th></tr>;
    rows = page(SalesQuoteSummary).parse(data).items.map((x) => (
      <tr key={x.id} className="click" onClick={() => open(`/b2b/qt/${encodeURIComponent(x.no)}`)} style={x.status === 'void' ? { opacity: 0.65 } : undefined}>
        <td className="mono"><Link to={`/b2b/qt/${encodeURIComponent(x.no)}`}>{x.no}</Link>{x.revision > 1 && <span className="small muted"> rev {x.revision}</span>}</td>
        <td>{th(x.date)}</td><td>{x.customer.name}{x.freeLines > 0 && <div><Pill k="warn">นอกระบบ {x.freeLines}</Pill></div>}</td><td>{th(x.validUntil)}</td>
        <td className="n">{fmt(x.total)}</td><td><StatusPill map={QT_STATUS} k={x.status} /></td><td className="small">{x.createdBy}</td>
      </tr>
    ));
  } else if (tab === 'so') {
    head = <tr><th>เลขที่</th><th>วันที่</th><th>ลูกค้า</th><th>สินค้า</th><th className="n">ยอด</th><th>สถานะ</th><th>อ้างอิง</th></tr>;
    rows = page(SalesOrderSummary).parse(data).items.map((x) => (
      <tr key={x.id} className="click" onClick={() => open(`/b2b/so/${encodeURIComponent(x.no)}`)} style={x.status === 'void' ? { opacity: 0.65 } : undefined}>
        <td className="mono"><Link to={`/b2b/so/${encodeURIComponent(x.no)}`}>{x.no}</Link></td><td>{th(x.date)}</td>
        <td>{x.customer.name}{x.projectName && <div><Pill k="acc">โครงการ: {x.projectName}</Pill></div>}</td><td className="small">{x.itemsPreview}</td>
        <td className="n">{x.status === 'void' ? <s>{fmt(x.total)}</s> : fmt(x.total)}</td>
        <td>{x.status === 'void' ? <VoidPill /> : <StatusPill map={DLV_STATUS} k={x.dlvStatus} />}</td><td className="mono small"><DocLink no={x.quoteNo} type="QT" /></td>
      </tr>
    ));
  } else if (tab === 'do') {
    head = <tr><th>เลขที่</th><th>วันที่</th><th>ลูกค้า</th><th>สินค้า</th><th>อ้างอิง</th><th className="n">มูลค่า</th><th>สถานะ</th></tr>;
    rows = page(SalesDeliverySummary).parse(data).items.map((x) => (
      <tr key={x.id} className="click" onClick={() => open(`/b2b/do/${encodeURIComponent(x.no)}`)} style={x.status === 'void' ? { opacity: 0.65 } : undefined}>
        <td className="mono"><Link to={`/b2b/do/${encodeURIComponent(x.no)}`}>{x.no}</Link></td><td>{th(x.date)}</td>
        <td>{x.customer.name}{x.projectName && <div className="small muted">{x.projectName}</div>}</td><td className="small">{x.itemsPreview}</td>
        <td className="mono small">{x.soNo ? <DocLink no={x.soNo} type="SO" /> : <DocLink no={x.invoiceNo} type="INV" />}</td><td className="n">{fmt(x.total)}</td>
        <td>{x.status === 'void' ? <VoidPill /> : x.billedBy ? <Pill k="ok">ออกใบกำกับ <DocLink no={x.billedBy} type="INV" /></Pill> : x.invoiceNo ? <Pill k="mut">ส่งของฝาก</Pill> : x.projectName ? <Pill k="mut">วางบิลตามงวด</Pill> : <Pill k="warn">รอออกใบกำกับ</Pill>}</td>
      </tr>
    ));
  } else if (tab === 'inv') {
    head = <tr><th>เลขที่</th><th>วันที่</th><th>ลูกค้า</th><th>ประเภท</th><th>ครบกำหนด</th><th className="n">ยอด</th><th>สถานะ</th></tr>;
    rows = page(SalesInvoiceSummary).parse(data).items.map((x) => (
      <tr key={x.id} className="click" onClick={() => open(`/b2b/inv/${encodeURIComponent(x.no)}`)} style={x.status === 'void' ? { opacity: 0.65 } : undefined}>
        <td className="mono"><Link to={`/b2b/inv/${encodeURIComponent(x.no)}`}>{x.no}</Link></td><td>{th(x.date)}</td>
        <td>{x.customer.name}{x.projectName && <div className="small muted">{x.projectName}</div>}</td>
        <td><KindPill kind={x.kind} /> <span className="small muted">{SOURCE_TH[x.source]}</span></td><td>{x.kind === 'credit' ? th(x.dueDate) : '-'}</td>
        <td className="n">{x.status === 'void' ? <s>{fmt(x.total)}</s> : fmt(x.total)}</td><td>{x.status === 'void' ? <VoidPill /> : balPill(x.arBalance, x.overdueDays)}</td>
      </tr>
    ));
  } else {
    head = <tr><th>เลขที่</th><th>วันที่</th><th>ลูกค้า</th><th>อ้างอิง</th><th>คืนเงิน</th><th className="n">ยอด</th><th>เหตุผล</th></tr>;
    rows = page(SalesCreditNoteSummary).parse(data).items.map((x) => (
      <tr key={x.id} className="click" onClick={() => open(`/sales/${encodeURIComponent(x.no)}`)}>
        <td className="mono"><Link to={`/sales/${encodeURIComponent(x.no)}`}>{x.no}</Link></td><td>{th(x.date)}</td><td>{x.customer.name}</td>
        <td className="mono small"><DocLink no={x.refNo} /></td><td>{x.refund === 'credit' ? <Pill k="acc">ลดหนี้ลูกหนี้</Pill> : x.refund === 'cash' ? 'เงินสด' : 'โอน'}</td><td className="n">{fmt(x.total)}</td><td className="small">{x.reason}</td>
      </tr>
    ));
  }
  return (
    <>
      {list.isError && <ErrorBanner error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
      <div className="tw">
        <table data-testid={`b2b-table-${tab}`}>
          <thead>{head}</thead>
          <tbody>
            {loading ? <SkeletonRows cols={cols} /> : rows}
            {!loading && list.data && !rows.length && <tr><td colSpan={cols} className="empty">ยังไม่มีเอกสารประเภทนี้</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onMore={() => void list.fetchNextPage()} count={rows.length} testId={`b2b-more-${tab}`} />
    </>
  );
}
