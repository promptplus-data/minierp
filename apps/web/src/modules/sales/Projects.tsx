/** M09 ขายโครงการ: project list, project page (installments, deposits, delivery rounds, variation orders) and the "set up as project" modal. */
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { SalesOrderSummary, SalesProject, SalesProjectSummary, page, type SalesDeposit, type SalesOrder } from '@erp/contracts';
import { d } from '@erp/core';
import { ApiFail, api, errText } from '../../api';
import { useAuth } from '../../auth';
import { ApprovalModal, fmt, fq, Modal, Pager, Pill, SkeletonRows, th, useCursorPager, useDebounced, useToast, type ApprovalInput } from '../../ui';
import { DeliveryModal, DocFormModal } from './Forms';
import { DLV_STATUS, METHOD_TH, Paper, PrintModal, SOURCE_TH, StatusPill, useSalesInvalidate, VoidDocModal, VoidedNote, VoidPill } from './shared';
import { ErrorBanner } from '../../errors';

export const TEMPLATES = ['30/40/30', '50/50', '100%', 'custom'] as const;
export type Template = (typeof TEMPLATES)[number];
const TPL_PCTS: Record<Exclude<Template, 'custom'>, string[]> = { '30/40/30': ['30', '40', '30'], '50/50': ['50', '50'], '100%': ['100'] };
const FLOW = ['ใบเสนอราคา (ไม่บังคับ)', 'ใบสั่งขาย = สัญญางาน', 'ตั้งโครงการ: หน้างาน + งวดวางบิล', 'รับมัดจำ (ถ้ามี)', 'ส่งของเข้าหน้างานหลายรอบ', 'วางบิลตามงวด หักมัดจำ', 'รับชำระ'];
const pctOf = (v: string, of: string) => (d(of).gt(0) ? Math.min(100, Math.round(d(v).div(d(of)).times(100).toNumber())) : 0);

/** Installment template picker shared by the SO form and the setup modal (REQ-M09-07). */
export function TemplateFields({ tpl, setTpl, custom, setCustom }: { tpl: Template; setTpl: (t: Template) => void; custom: string; setCustom: (s: string) => void }) {
  const pcts = custom.split(/[,\s/]+/).filter(Boolean);
  const sum = pcts.reduce((a, x) => a.plus(d(Number.isFinite(Number(x)) ? x : 0)), d(0));
  return (
    <>
      <label className="f">รูปแบบงวดวางบิล
        <select value={tpl} onChange={(e) => setTpl(e.target.value as Template)} data-testid="pj-template">
          {TEMPLATES.map((x) => <option key={x} value={x}>{x === 'custom' ? 'กำหนดเอง' : `${x} (${(TPL_PCTS[x] ?? []).length} งวด)`}</option>)}
        </select>
      </label>
      {tpl === 'custom' && (
        <label className="f">% แต่ละงวด (คั่นด้วยจุลภาค)
          <input type="text" value={custom} onChange={(e) => setCustom(e.target.value)} data-testid="pj-custom" />
          <span className={sum.eq(100) ? 'sum-ok' : 'sum-bad'}>รวม {fq(sum)}%{sum.eq(100) ? '' : ' (ต้องเท่ากับ 100%)'}</span>
        </label>
      )}
    </>
  );
}
export const customPcts = (s: string) => s.split(/[,\s/]+/).filter(Boolean);
export const customOk = (tpl: Template, s: string) => tpl !== 'custom' || customPcts(s).reduce((a, x) => a.plus(d(Number.isFinite(Number(x)) ? x : 0)), d(0)).eq(100);

/** "ตั้งเป็นโครงการ" on an existing sales order (REQ-M09-07 path B). */
export function ProjectSetupModal({ so, onClose }: { so: Pick<SalesOrder, 'no' | 'customer' | 'shipTo'> & { total?: string }; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const invalidate = useSalesInvalidate();
  const [name, setName] = useState(`งาน${so.customer.name.replace(/^(หจก\.|บจก\.)\s*/, '')}`);
  const [site, setSite] = useState(so.shipTo);
  const [contact, setContact] = useState('');
  const [tpl, setTpl] = useState<Template>('30/40/30');
  const [custom, setCustom] = useState('40,30,30');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/sales/projects', {
        body: { soNo: so.no, name: name.trim(), site, contact, template: tpl, ...(tpl === 'custom' ? { installments: customPcts(custom).map((pct) => ({ pct })) } : {}) }, schema: SalesProject,
      });
      await invalidate();
      toast(`ตั้งโครงการ ${r.name} แล้ว`);
      onClose();
      nav(`/projects/${r.id}`);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="ตั้งเป็นงานโครงการ">
      <h3>ตั้งเป็นงานโครงการ · {so.no}</h3>
      <div className="fgrid">
        <label className="f">ชื่อโครงการ / หน้างาน *<input type="text" value={name} onChange={(e) => setName(e.target.value)} data-testid="pj-name" /></label>
        <label className="f">ที่ตั้งหน้างาน (ใช้เป็นที่ส่งของ)<input type="text" value={site} onChange={(e) => setSite(e.target.value)} /></label>
        <label className="f">ผู้ควบคุมงาน / ผู้ติดต่อ<input type="text" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="เช่น คุณอรุณ 081-xxx-xxxx" /></label>
        <TemplateFields tpl={tpl} setTpl={setTpl} custom={custom} setCustom={setCustom} />
        {so.total && <div><div className="small muted">มูลค่าสัญญา (จากใบสั่งขาย)</div><b>฿{fmt(so.total)}</b></div>}
      </div>
      <div className="note small">แก้ % และชื่องวดได้ภายหลังที่หน้าโครงการ · รับมัดจำได้หลังตั้งโครงการ</div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={busy || !name.trim() || !customOk(tpl, custom)} onClick={() => void go()} data-testid="pj-save">ตั้งโครงการ</button></div>
    </Modal>
  );
}

function FlowMap() {
  return (
    <>
      <div className="small muted" style={{ margin: '10px 0 6px' }}>ขั้นตอนขายงานโครงการ</div>
      <div className="flowmap">{FLOW.map((x, i) => <span key={x} className="row" style={{ gap: 6 }}>{i > 0 && <span className="arr">→</span>}<span className="box">{i + 1}. {x}</span></span>)}</div>
    </>
  );
}

// ---------- list ----------
export default function Projects() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const [m, setM] = useState(false);
  const dq = useDebounced(q.trim(), 250);
  const pager = useCursorPager(`${dq}|${status}`);
  const list = useQuery({
    queryKey: ['projects', 'list', dq, status, pager.cursor],
    queryFn: () => api('GET', '/api/sales/projects', { query: { q: dq, status, limit: 20, cursor: pager.cursor }, schema: page(SalesProjectSummary) }),
    placeholderData: keepPreviousData,
  });
  const loading = list.isLoading || (list.isFetching && list.isPlaceholderData);
  const items = list.data?.items ?? [];
  const canPj = can('sales.project') === 1;
  return (
    <>
      <div className="card">
        <h2>
          <span>โครงการ / หน้างาน</span>
          <span className="row">{canPj ? <button className="btn pri" onClick={() => setM(true)} data-testid="new-project">+ เริ่มโครงการใหม่</button> : <Pill k="acc">ดูอย่างเดียว</Pill>}</span>
        </h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นชื่อโครงการ หน้างาน ลูกค้า หรือเลขที่" style={{ flex: 1, minWidth: 200 }} aria-label="ค้นหาโครงการ" data-testid="pj-search" />
          <div className="steps">
            {[['active', 'กำลังดำเนินการ'], ['', 'ทั้งหมด'], ['void', 'ยกเลิก']].map(([k, l]) => <span key={k} role="button" tabIndex={0} className={status === k ? 'on' : ''} onClick={() => setStatus(k!)} onKeyDown={(e) => { if (e.key === 'Enter') setStatus(k!); }}>{l}</span>)}
          </div>
        </div>
        {list.isError && <ErrorBanner error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
        <div className="tw">
          <table data-testid="pj-table">
            <thead><tr><th>โครงการ</th><th>ลูกค้า</th><th className="n">มูลค่า</th><th className="n">ส่งแล้ว</th><th className="n">วางบิลแล้ว</th><th className="n">รับเงินแล้ว</th><th className="n">คงค้าง</th></tr></thead>
            <tbody>
              {loading ? <SkeletonRows cols={7} /> : items.map((p) => (
                <tr key={p.id} className="click" onClick={() => nav(`/projects/${p.id}`)} style={p.status === 'void' ? { opacity: 0.65 } : undefined}>
                  <td><Link to={`/projects/${p.id}`}><b>{p.name}</b></Link> {p.status === 'void' && <VoidPill />}<div className="small muted"><span className="mono">{p.no}</span>{p.site ? ` · ${p.site}` : ''}</div></td>
                  <td>{p.customer.name}</td>
                  <td className="n">{fmt(p.figures.value)}</td>
                  <td className="n">{fmt(p.figures.delivered)}<div className="bar"><i style={{ width: `${pctOf(p.figures.delivered, p.figures.value)}%` }} /></div></td>
                  <td className="n">{fmt(p.figures.billed)}<div className="bar"><i style={{ width: `${pctOf(p.figures.billed, p.figures.value)}%` }} /></div></td>
                  <td className="n">{fmt(p.figures.collected)}</td>
                  <td className="n">{d(p.figures.outstanding).gt(0) ? <b>{fmt(p.figures.outstanding)}</b> : fmt(p.figures.outstanding)}</td>
                </tr>
              ))}
              {!loading && list.data && !items.length && <tr><td colSpan={7} className="empty">ยังไม่มีโครงการ · เริ่มจากใบสั่งขาย</td></tr>}
            </tbody>
          </table>
        </div>
        <Pager page={pager.page} hasNext={!!list.data?.nextCursor} count={items.length} loading={list.isFetching} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor ?? null)} />
        <FlowMap />
      </div>
      {m && <NewProjectModal onClose={() => setM(false)} />}
    </>
  );
}

/** Two ways to start a project (mockup newPjModal): a new SO of type "project", or an existing SO without a project. */
function NewProjectModal({ onClose }: { onClose: () => void }) {
  const [way, setWay] = useState<null | 'new' | SalesOrderSummary>(null);
  const [pick, setPick] = useState('');
  const sos = useQuery({ queryKey: ['orders', 'no-project'], queryFn: () => api('GET', '/api/sales/orders', { query: { status: 'open', limit: 50 }, schema: page(SalesOrderSummary) }) });
  const free = (sos.data?.items ?? []).filter((o) => !o.projectName && o.status === 'active');
  if (way === 'new') return <DocFormModal mode="SO" newProject onClose={onClose} />;
  if (way) return <ProjectSetupModal so={{ no: way.no, customer: { ...way.customer, code: null, taxId: null, branch: null, phone: null }, shipTo: '', total: way.total }} onClose={onClose} />;
  const sel = free.find((o) => o.no === (pick || free[0]?.no));
  return (
    <Modal onClose={onClose} wide label="เริ่มโครงการใหม่">
      <h3>เริ่มโครงการใหม่</h3>
      <p className="small" style={{ margin: 0 }}>โครงการในระบบนี้ <b>เกิดจากใบสั่งขายเสมอ</b> เพราะใบสั่งขายคือสัญญางาน ระบบใช้มูลค่าใบสั่งขายเป็นฐานคิดงวดวางบิลและมัดจำ เลือกได้ 2 ทาง</p>
      <div className="grid g2">
        <div className="card" style={{ margin: 0 }}>
          <b>ก. ยังไม่มีใบสั่งขาย</b>
          <p className="small muted">สร้างใบสั่งขายใหม่ ระบบเลือกประเภท "ขายโครงการ" ให้ แล้วใส่ชื่อโครงการ หน้างาน และรูปแบบงวดในใบเดียว</p>
          <button className="btn pri" onClick={() => setWay('new')} data-testid="pj-way-new">สร้างใบสั่งขายแบบโครงการ</button>
        </div>
        <div className="card" style={{ margin: 0 }}>
          <b>ข. มีใบสั่งขายแล้ว</b>
          <p className="small muted">เช่น แปลงมาจากใบเสนอราคา หรือคุยกับลูกค้าแล้วทำใบสั่งขายไว้ก่อน</p>
          {sos.isLoading ? <div className="sk" /> : free.length ? (
            <>
              <label className="f">ใบสั่งขายที่ยังไม่ผูกโครงการ
                <select value={sel?.no ?? ''} onChange={(e) => setPick(e.target.value)} data-testid="pj-pick-so">
                  {free.map((o) => <option key={o.no} value={o.no}>{o.no} · {o.customer.name} · ฿{fmt(o.total)}</option>)}
                </select>
              </label>
              <button className="btn" style={{ marginTop: 8 }} onClick={() => sel && setWay(sel)} data-testid="pj-way-so">ตั้งเป็นโครงการ</button>
            </>
          ) : <div className="small muted">ไม่มีใบสั่งขายที่ยังไม่ผูกโครงการ</div>}
        </div>
      </div>
      <div className="note small">งานเพิ่ม (variation) ของโครงการเดิม: สร้างใบสั่งขายใหม่แล้วเลือก "เพิ่มเข้าโครงการเดิม" มูลค่าโครงการจะเพิ่มตามใบนั้น</div>
      <div className="act"><button className="btn" onClick={onClose}>ปิด</button></div>
    </Modal>
  );
}

// ---------- project page ----------
type PM = null | 'inst' | 'deposit' | 'deliver' | 'variation' | 'void' | { bill: SalesProject['installments'][number] } | { dep: SalesDeposit; act: 'forfeit' | 'refund' | 'void' | 'print' };

export function ProjectDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const invalidate = useSalesInvalidate();
  const [m, setM] = useState<PM>(null);
  const q = useQuery({ queryKey: ['project', id], queryFn: () => api('GET', `/api/sales/projects/${encodeURIComponent(id)}`, { schema: SalesProject }) });
  if (q.isLoading) return <div className="card"><div className="sk" /><div className="sk" /><div className="sk" /></div>;
  if (!q.data) return <div className="card"><ErrorBanner error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} /><p><Link to="/projects">‹ กลับไปรายการโครงการ</Link></p></div>;
  const p = q.data;
  const live = p.status === 'active';
  const canPj = can('sales.project') === 1;
  const canDeliver = can('sales.doc') === 1 || can('inv.receive') === 1;
  const f = p.figures;
  const allBilled = p.installments.length > 0 && p.installments.every((i) => i.status === 'billed');
  const openSo = p.orders.find((o) => o.status === 'active' && o.dlvStatus !== 'delivered');
  const firstOpen = p.installments.find((i) => i.status === 'open');
  const bars: [string, string][] = [['ส่งของแล้ว', f.delivered], ['วางบิลแล้ว', f.billed], ['รับเงินแล้ว', f.collected]];
  return (
    <>
      <div className="card">
        <h2>
          <span className="row"><Link to="/projects" className="btn sm">‹ กลับ</Link> <b data-testid="pj-title">{p.name}</b> <span className="mono small muted">{p.no}</span> {!live ? <VoidPill /> : allBilled ? <Pill k="ok">วางบิลครบแล้ว</Pill> : <Pill k="acc">กำลังดำเนินการ</Pill>}</span>
          <span className="actions">
            {live && canPj && <button className="btn sm" onClick={() => setM('inst')} data-testid="pj-inst-edit">แก้งวดวางบิล</button>}
            {live && can('sales.doc') === 1 && <button className="btn sm" onClick={() => setM('variation')} data-testid="pj-variation">+ งานเพิ่ม (ใบสั่งขายใหม่)</button>}
            {live && canPj && <button className="btn sm bad" onClick={() => setM('void')} data-testid="void">ยกเลิกโครงการ</button>}
          </span>
        </h2>
        <div className="fgrid">
          <div><div className="small muted">ลูกค้า</div>{p.customer.name}</div>
          <div><div className="small muted">หน้างาน</div>{p.site || '-'}{p.contact && <div className="small muted">ผู้ควบคุมงาน {p.contact}</div>}</div>
          <div><div className="small muted">ใบสั่งขาย (สัญญางาน)</div>{p.mainSoNo ? <Link className="mono" to={`/b2b/so/${encodeURIComponent(p.mainSoNo)}`}>{p.mainSoNo}</Link> : '-'}
            {p.orders.filter((o) => !o.isMain).length > 0 && <div className="small">งานเพิ่ม: {p.orders.filter((o) => !o.isMain).map((o) => o.no).join(', ')}</div>}</div>
          <div><div className="small muted">มูลค่าตามใบสั่งขาย</div><b data-testid="pj-value">฿{fmt(f.value)}</b></div>
        </div>
        <div className="grid" style={{ marginTop: 14, gap: 10 }}>
          {bars.map(([l, v]) => (
            <div key={l}>
              <div className="row" style={{ justifyContent: 'space-between' }}><span className="small">{l}</span><span className="small mono">{fmt(v)} / {fmt(f.value)} ({pctOf(v, f.value)}%)</span></div>
              <div className="bar"><i style={{ width: `${pctOf(v, f.value)}%` }} /></div>
            </div>
          ))}
        </div>
        <div className="pjfig">
          <div className="kpi"><div className="l">ค้างรับ (วางบิลแล้ว)</div><div className="v">฿{fmt(f.outstanding)}</div></div>
          <div className="kpi"><div className="l">ยังไม่วางบิล</div><div className="v">฿{fmt(f.unbilled)}</div></div>
        </div>
        <VoidedNote v={p.voided} />
      </div>
      <div>
        <div className="card">
          <h2>มัดจำ {live && canPj && <button className="btn sm" onClick={() => setM('deposit')} data-testid="pj-deposit">รับมัดจำ</button>}</h2>
          {p.deposits.length ? (
            <div className="tw">
              <table>
                <thead><tr><th>เอกสาร</th><th>ประเภท</th><th className="n">ยอด</th><th className="n">คงเหลือ</th><th>สถานะ</th><th /></tr></thead>
                <tbody>
                  {p.deposits.map((x) => (
                    <tr key={x.id}>
                      <td className="mono">{x.no}{x.invoiceNo && <div className="small"><Link to={`/b2b/inv/${encodeURIComponent(x.invoiceNo)}`}>{x.invoiceNo}</Link></div>}</td>
                      <td>{x.type === 'advance' ? 'รับชำระค่าสินค้าล่วงหน้า' : 'มัดจำประกันสัญญา'}<div className="small muted">{METHOD_TH[x.method] ?? x.method} · {th(x.date)}</div></td>
                      <td className="n">{fmt(x.amount)}</td><td className="n">{fmt(x.remaining)}</td>
                      <td>{x.status === 'active' ? (x.type === 'advance' ? <Pill k="ok">ออกใบกำกับแล้ว</Pill> : <Pill k="mut">ยังไม่เกิด VAT</Pill>) : x.status === 'forfeited' ? <Pill k="warn">ริบแล้ว {x.forfeitNo}</Pill> : x.status === 'refunded' ? <Pill k="mut">คืนแล้ว</Pill> : <VoidPill />}</td>
                      <td>
                        <span className="actions">
                          {x.type === 'guarantee' && <button className="btn sm" onClick={() => setM({ dep: x, act: 'print' })}>พิมพ์</button>}
                          {live && canPj && x.status === 'active' && x.type === 'guarantee' && d(x.remaining).gt(0) && <>
                            <button className="btn sm" onClick={() => setM({ dep: x, act: 'forfeit' })} data-testid="dep-forfeit">ริบ</button>
                            <button className="btn sm" onClick={() => setM({ dep: x, act: 'refund' })} data-testid="dep-refund">คืน</button>
                          </>}
                          {live && canPj && x.status === 'active' && <button className="btn sm bad" onClick={() => setM({ dep: x, act: 'void' })}>ยกเลิก</button>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="empty">ยังไม่ได้รับมัดจำ</div>}
          <p className="small muted">รับชำระล่วงหน้า: ออกใบกำกับวันที่รับเงิน หักคืนตามสัดส่วนแต่ละงวด ไม่คิด VAT ซ้ำ · มัดจำประกันสัญญา: ยังไม่เกิด VAT หักเมื่อส่งมอบ หรือริบเมื่อลูกค้าผิดสัญญา (ออกใบกำกับตอนริบ)</p>
        </div>
        <div className="card">
          <h2>งวดวางบิล <span className="small muted">ตั้งตาม % ของมูลค่าโครงการ</span></h2>
          <div className="tw">
            <table data-testid="pj-installments">
              <thead><tr><th>งวด</th><th>งาน</th><th className="n">%</th><th className="n">ยอดงวด</th><th className="n">หักมัดจำ</th><th className="n">สุทธิ</th><th /></tr></thead>
              <tbody>
                {p.installments.map((i) => (
                  <tr key={i.id}>
                    <td>{i.n}</td><td>{i.label}<div className="small muted">ครบกำหนด {th(i.dueDate)}</div></td><td className="n">{fq(i.pct)}</td>
                    <td className="n">{fmt(i.gross)}</td><td className="n">{d(i.deduct).gt(0) ? `−${fmt(i.deduct)}` : '-'}</td><td className="n">{fmt(i.net)}</td>
                    <td>
                      {i.status === 'billed' && i.invoiceNo ? <Link className="btn sm" to={`/b2b/inv/${encodeURIComponent(i.invoiceNo)}`}>{i.invoiceNo}</Link>
                        : live && canPj && i.id === firstOpen?.id ? <button className="btn sm pri" onClick={() => setM({ bill: i })} data-testid={`pj-bill-${i.n}`}>วางบิลงวดนี้</button>
                          : <Pill k="mut">รอ</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div className="card">
        <h2>ใบสั่งขายของโครงการ <span className="small muted">สัญญางาน + งานเพิ่ม</span></h2>
        <div className="tw">
          <table data-testid="pj-orders">
            <thead><tr><th>ใบสั่งขาย</th><th>วันที่</th><th>ประเภท</th><th className="n">มูลค่า</th><th>การส่งของ</th></tr></thead>
            <tbody>
              {p.orders.map((o) => (
                <tr key={o.no} style={o.status === 'void' ? { opacity: 0.65 } : undefined}>
                  <td className="mono"><Link to={`/b2b/so/${encodeURIComponent(o.no)}`}>{o.no}</Link></td><td>{th(o.date)}</td>
                  <td>{o.isMain ? <Pill k="acc">สัญญางาน</Pill> : <Pill k="mut">งานเพิ่ม</Pill>}</td><td className="n">{fmt(o.total)}</td>
                  <td>{o.status === 'void' ? <VoidPill /> : <StatusPill map={DLV_STATUS} k={o.dlvStatus} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <h2>รอบส่งของเข้าหน้างาน {live && canDeliver && openSo && <button className="btn sm pri" onClick={() => setM('deliver')} data-testid="pj-deliver">ออกใบส่งของรอบใหม่</button>}</h2>
        <div className="tw">
          <table>
            <thead><tr><th>ใบส่งของ</th><th>วันที่</th><th>สินค้า</th><th>รถ</th><th className="n">มูลค่า</th></tr></thead>
            <tbody>
              {p.deliveries.map((x) => (
                <tr key={x.no} style={x.status === 'void' ? { opacity: 0.65 } : undefined}>
                  <td className="mono"><Link to={`/b2b/do/${encodeURIComponent(x.no)}`}>{x.no}</Link>{x.status === 'void' && <> <VoidPill /></>}</td><td>{th(x.date)}</td><td className="small">{x.itemsPreview}</td><td className="small">{x.vehicle || '-'}</td><td className="n">{fmt(x.total)}</td>
                </tr>
              ))}
              {!p.deliveries.length && <tr><td colSpan={5} className="empty">ยังไม่ได้ส่งของ</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="small muted">ใบส่งของของโครงการไม่ออกใบกำกับแยกทีละรอบ แต่วางบิลตามงวดด้านบน</p>
      </div>
      <div className="card">
        <h2>ใบกำกับภาษีของโครงการ</h2>
        <div className="tw">
          <table>
            <thead><tr><th>เลขที่</th><th>วันที่</th><th>ที่มา</th><th className="n">ยอด</th><th className="n">คงค้าง</th></tr></thead>
            <tbody>
              {p.invoices.map((x) => (
                <tr key={x.no} style={x.status === 'void' ? { opacity: 0.65 } : undefined}>
                  <td className="mono"><Link to={`/b2b/inv/${encodeURIComponent(x.no)}`}>{x.no}</Link></td><td>{th(x.date)}</td><td>{SOURCE_TH[x.source]}</td><td className="n">{fmt(x.total)}</td>
                  <td className="n">{x.status === 'void' ? <VoidPill /> : fmt(x.arBalance)}</td>
                </tr>
              ))}
              {!p.invoices.length && <tr><td colSpan={5} className="empty">ยังไม่ได้วางบิล</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {m === 'inst' && <InstallmentsModal p={p} onClose={() => setM(null)} />}
      {m === 'deposit' && <DepositModal p={p} onClose={() => setM(null)} />}
      {m === 'deliver' && openSo && <DeliveryModal initial={{ kind: 'SO', no: openSo.no }} onClose={() => setM(null)} />}
      {m === 'variation' && <DocFormModal mode="SO" presetProject={{ id: p.id, customerId: p.customer.id ?? '' }} onClose={() => setM(null)} />}
      {m === 'void' && <VoidDocModal what={`โครงการ ${p.name}`} url={`/api/sales/projects/${encodeURIComponent(p.id)}/void`} perm="fin.ar" onClose={() => setM(null)} onDone={() => void invalidate()} effects={['ต้องยกเลิกใบกำกับงวดและมัดจำของโครงการก่อน', 'ใบสั่งขายของโครงการกลับเป็นขายส่งทั่วไป']} />}
      {m && typeof m === 'object' && 'bill' in m && <BillModal p={p} i={m.bill} onClose={() => setM(null)} />}
      {m && typeof m === 'object' && 'dep' in m && m.act === 'void' && <VoidDocModal what={m.dep.no} url={`/api/sales/deposits/${encodeURIComponent(m.dep.no)}/void`} perm="fin.ar" total={m.dep.amount} onClose={() => setM(null)} onDone={() => void invalidate()} />}
      {m && typeof m === 'object' && 'dep' in m && (m.act === 'forfeit' || m.act === 'refund') && <DepositActionModal dep={m.dep} act={m.act} onClose={() => setM(null)} />}
      {m && typeof m === 'object' && 'dep' in m && m.act === 'print' && <PrintModal title={m.dep.no} onClose={() => setM(null)}><Paper {...depositPaper(p, m.dep)} /></PrintModal>}
    </>
  );
}

function depositPaper(p: SalesProject, x: SalesDeposit) {
  return {
    title: 'ใบรับเงินมัดจำ', no: x.no, date: x.date, voided: x.status === 'void',
    party: { label: 'ได้รับเงินจาก', name: p.customer.name, tax: p.customer.taxId, br: p.customer.branch, tel: p.customer.phone },
    refs: [['โครงการ', p.name], ...(p.mainSoNo ? [['ใบสั่งขาย', p.mainSoNo]] : []), ['รับโดย', METHOD_TH[x.method] ?? x.method]] as [string, ReactNode][],
    cols: 'amt' as const, rows: [{ name: `เงินมัดจำประกันสัญญา ${pctOf(x.amount, p.figures.value)}% ของมูลค่างาน`, amt: x.amount }],
    totals: [['รวม', fmt(x.amount), true]] as [string, string, boolean?][], baht: x.amount,
    note: 'เงินมัดจำประกันสัญญายังไม่ถือเป็นรายได้ จึงไม่มีภาษีมูลค่าเพิ่ม', sign: ['ผู้รับเงิน', 'ผู้จ่ายเงิน'],
  };
}

/** Edit installments (REQ-M09-04): billed rows are locked; the percentages must add up to 100. */
function InstallmentsModal({ p, onClose }: { p: SalesProject; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useSalesInvalidate();
  const [rows, setRows] = useState(p.installments.map((i) => ({ id: i.id as string | undefined, label: i.label, pct: d(i.pct).toString(), dueDate: i.dueDate, billed: i.status === 'billed' })));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const sum = rows.reduce((a, r) => a.plus(d(Number.isFinite(Number(r.pct)) && r.pct ? r.pct : 0)), d(0));
  const ok = sum.eq(100) && rows.every((r) => r.dueDate && d(r.pct || 0).gt(0));
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const anyBilled = rows.some((r) => r.billed);
  const lastDue = rows[rows.length - 1]?.dueDate ?? p.createdAt.slice(0, 10);
  const plus30 = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 30 * 86_400_000).toISOString().slice(0, 10);
  const applyTpl = (t: Exclude<Template, 'custom'>) => {
    const start = rows[0]?.dueDate ?? lastDue;
    setRows(TPL_PCTS[t].map((pct, i) => ({ id: undefined, label: i === TPL_PCTS[t].length - 1 && i > 0 ? 'งวดสุดท้าย ส่งมอบงาน' : `งวดที่ ${i + 1}`, pct, dueDate: plus30(start, i), billed: false })));
  };
  const go = async () => {
    setBusy(true);
    setErr('');
    try {
      await api('POST', `/api/sales/projects/${encodeURIComponent(p.id)}/installments`, { body: { rows: rows.map((r) => ({ ...(r.id ? { id: r.id } : {}), label: r.label, pct: r.pct, dueDate: r.dueDate })) }, schema: SalesProject });
      await invalidate();
      toast('บันทึกงวดวางบิลแล้ว');
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} wide label="งวดวางบิล">
      <h3>งวดวางบิล · {p.name}</h3>
      <p className="small muted" style={{ margin: 0 }}>มูลค่าโครงการ ฿{fmt(p.figures.value)} · งวดที่วางบิลแล้วแก้ไม่ได้ · รวมทุกงวดต้องเท่ากับ 100%</p>
      {!anyBilled && (
        <div className="row small">ใช้แม่แบบ: {(['30/40/30', '50/50', '100%'] as const).map((t) => <button key={t} className="btn sm" onClick={() => applyTpl(t)} data-testid={`tpl-${t}`}>{t}</button>)}</div>
      )}
      <div className="tw">
        <table>
          <thead><tr><th>งวด</th><th>ชื่องวด / เงื่อนไขการวางบิล</th><th className="n">%</th><th>ครบกำหนด</th><th className="n">ยอด</th><th /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td><input type="text" value={r.label} disabled={r.billed} onChange={(e) => set(i, { label: e.target.value })} style={{ width: '100%', minWidth: 140 }} aria-label={`ชื่องวด ${i + 1}`} /></td>
                <td className="n"><input className="qty" type="number" min="0" max="100" step="any" value={r.pct} disabled={r.billed} onChange={(e) => set(i, { pct: e.target.value })} aria-label={`เปอร์เซ็นต์งวด ${i + 1}`} data-testid={`inst-pct-${i}`} /></td>
                <td><input type="date" value={r.dueDate} disabled={r.billed} onChange={(e) => set(i, { dueDate: e.target.value })} aria-label={`ครบกำหนดงวด ${i + 1}`} /></td>
                <td className="n">{fmt(d(p.figures.value).times(d(r.pct || 0)).div(100))}</td>
                <td>{r.billed ? <Pill k="ok">วางบิลแล้ว</Pill> : rows.length > 1 ? <button className="btn sm bad" onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))} aria-label={`ลบงวด ${i + 1}`}>✕</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button className="btn sm" onClick={() => setRows((rs) => [...rs, { id: undefined, label: 'งวดใหม่', pct: '0', dueDate: plus30(lastDue, 1), billed: false }])} data-testid="inst-add">+ เพิ่มงวด</button>
        <span>รวม <b className={sum.eq(100) ? 'sum-ok' : 'sum-bad'} data-testid="inst-sum">{fq(sum)}%</b>{sum.eq(100) ? '' : ' (ต้องเท่ากับ 100%)'}</span>
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={!ok || busy} onClick={() => void go()} data-testid="inst-save">บันทึกงวด</button></div>
    </Modal>
  );
}

/** Bill one installment (REQ-M09-05): the deposit is deducted pro rata, the last installment takes the rest. */
function BillModal({ p, i, onClose }: { p: SalesProject; i: SalesProject['installments'][number]; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useSalesInvalidate();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const adv = p.deposits.some((x) => x.type === 'advance' && x.status === 'active');
  const go = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ invoiceNo: string }>('POST', `/api/sales/projects/${encodeURIComponent(p.id)}/installments/${encodeURIComponent(i.id)}/bill`, { body: {} });
      await invalidate();
      toast(`${r.invoiceNo} วางบิลงวด ${i.n} แล้ว`);
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="วางบิลงวด">
      <h3>วางบิลงวดที่ {i.n} · {i.label}</h3>
      <div className="tot">
        <span className="muted">ยอดงวด ({fq(i.pct)}%)</span><span>{fmt(i.gross)}</span>
        <span className="muted">หักมัดจำตามสัดส่วน</span><span>−{fmt(i.deduct)}</span>
        <span style={{ fontWeight: 600 }}>ยอดที่ต้องชำระงวดนี้</span><span className="big" data-testid="bill-net">฿{fmt(i.net)}</span>
      </div>
      {d(i.deduct).gt(0) && <div className="note small">{adv ? 'มัดจำเป็นการรับชำระล่วงหน้าและออกใบกำกับไปแล้ว จึงไม่คิด VAT ซ้ำในส่วนที่หัก' : 'มัดจำประกันสัญญายังไม่เกิด VAT จะรับรู้เมื่อหักในงวดนี้'}</div>}
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={busy} onClick={() => void go()} data-testid="bill-ok">ออกใบกำกับงวดนี้</button></div>
    </Modal>
  );
}

/** Receive a deposit (REQ-M09-03): advance payment (tax invoice now) or contract guarantee (deposit receipt, no VAT). */
function DepositModal({ p, onClose }: { p: SalesProject; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useSalesInvalidate();
  const existing = p.deposits.find((x) => x.status !== 'void')?.type;
  const [type, setType] = useState<'advance' | 'guarantee'>(existing ?? 'advance');
  const [amount, setAmount] = useState(d(p.figures.value).times('0.2').toFixed(2));
  const [method, setMethod] = useState<'transfer' | 'cash' | 'promptpay' | 'card'>('transfer');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', `/api/sales/projects/${encodeURIComponent(p.id)}/deposits`, { body: { type, amount, method }, schema: SalesProject });
      await invalidate();
      const x = r.deposits[0];
      toast(`${x?.no ?? ''} ${type === 'advance' ? 'ใบกำกับภาษี (รับล่วงหน้า)' : 'ใบรับเงินมัดจำ'} ออกแล้ว`);
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="รับมัดจำ">
      <h3>รับมัดจำ · {p.name}</h3>
      <div>
        <label className="row"><input type="radio" name="dt" checked={type === 'advance'} disabled={!!existing && existing !== 'advance'} onChange={() => setType('advance')} /> รับชำระค่าสินค้าล่วงหน้า <span className="small muted">ออกใบกำกับภาษีวันที่รับเงิน</span></label>
        <label className="row"><input type="radio" name="dt" checked={type === 'guarantee'} disabled={!!existing && existing !== 'guarantee'} onChange={() => setType('guarantee')} data-testid="dep-guarantee" /> มัดจำประกันสัญญา <span className="small muted">ออกใบรับเงินมัดจำ ยังไม่เกิด VAT</span></label>
      </div>
      <div className="fgrid">
        <label className="f">จำนวนเงิน<input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="dep-amount" /></label>
        <label className="f">รับโดย<select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>{(['transfer', 'cash', 'promptpay', 'card'] as const).map((k) => <option key={k} value={k}>{METHOD_TH[k]}</option>)}</select></label>
      </div>
      {existing && <div className="note small">โครงการนี้รับมัดจำแบบ{existing === 'advance' ? 'รับชำระล่วงหน้า' : 'ประกันสัญญา'}ไว้แล้ว · หนึ่งโครงการใช้มัดจำได้ประเภทเดียว</div>}
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={busy || !d(amount || 0).gt(0)} onClick={() => void go()} data-testid="dep-save">บันทึกและออกเอกสาร</button></div>
    </Modal>
  );
}

/** Forfeit or refund a guarantee deposit: owner PIN (REQ-M09-06). */
function DepositActionModal({ dep, act, onClose }: { dep: SalesDeposit; act: 'forfeit' | 'refund'; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useSalesInvalidate();
  const [method, setMethod] = useState<'transfer' | 'cash'>('transfer');
  const [reason, setReason] = useState('');
  const [apv, setApv] = useState(false);
  const submit = async (a: ApprovalInput): Promise<string | null> => {
    try {
      await api('POST', `/api/sales/deposits/${encodeURIComponent(dep.no)}/${act}`, { body: { approval: a, reason, ...(act === 'refund' ? { method } : {}) } });
      await invalidate();
      toast(act === 'forfeit' ? `ริบมัดจำ ${dep.no} แล้ว · ออกใบกำกับภาษีสำหรับยอดที่ริบ` : `คืนมัดจำ ${dep.no} แล้ว`);
      onClose();
      return null;
    } catch (e) {
      if (e instanceof ApiFail && e.detail('approvalError')) return e.message;
      return errText(e);
    }
  };
  if (apv) return <ApprovalModal ownerOnly onClose={() => setApv(false)} onSubmit={submit} label={<p style={{ margin: 0 }}>"{act === 'forfeit' ? 'ริบ' : 'คืน'}มัดจำ {dep.no} ฿{fmt(dep.remaining)}"</p>} />;
  return (
    <Modal onClose={onClose} label={act === 'forfeit' ? 'ริบมัดจำ' : 'คืนมัดจำ'}>
      <h3>{act === 'forfeit' ? 'ริบมัดจำ' : 'คืนมัดจำ'} {dep.no}</h3>
      <p className="small muted" style={{ margin: 0 }}>{act === 'forfeit' ? 'ลูกค้าผิดสัญญา: ระบบออกใบกำกับภาษีสำหรับยอดที่ริบ' : 'บันทึกการจ่ายคืนเงินมัดจำที่เหลือ'} ฿{fmt(dep.remaining)} · ต้องให้เจ้าของร้านอนุมัติ</p>
      {act === 'refund' && <label className="f">จ่ายคืนโดย<select value={method} onChange={(e) => setMethod(e.target.value as 'transfer' | 'cash')}><option value="transfer">โอนเงิน</option><option value="cash">เงินสด</option></select></label>}
      <label className="f">เหตุผล<input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="เช่น ลูกค้ายกเลิกสัญญา" /></label>
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" onClick={() => setApv(true)} data-testid="dep-act-ok">ขออนุมัติ</button></div>
    </Modal>
  );
}
