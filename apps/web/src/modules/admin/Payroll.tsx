/** REQ-M17-02 monthly payroll (draft → approved → paid, locked when paid), REQ-M17-06 labour cost, SSO settings. */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { HrLabourCostRow, HrPayrollRun, HrPayrollSummary, HrSettings, type HrPayrollLine } from '@erp/contracts';
import { d } from '@erp/core';
import { ApiFail, api } from '../../api';
import { Modal, Pill, SkeletonRows, fmt, fq, th, thTime, useToast } from '../../ui';
import { LoadMore, useLoadMore } from '../../ui/lists';
import { EditableNote, NoteField } from '../../ui/NoteField';
import { PAY_STATUS, SlipLink, admErr, periodTH, prevPeriod, thisPeriod, todayYmd } from './common';
import { ErrorBanner } from '../../errors';

type Editable = 'days' | 'ot' | 'allowance' | 'tax' | 'advance';

export default function Payroll() {
  const qc = useQueryClient();
  const toast = useToast();
  const runs = useLoadMore(['hr-runs'], '/api/hr/payroll', HrPayrollSummary, {}, 12);
  const [period, setPeriod] = useState<string | null>(null);
  useEffect(() => {
    if (!period && runs.rows[0]) setPeriod(runs.rows[0].period);
  }, [period, runs.rows]);
  const run = useQuery({
    queryKey: ['hr-run', period],
    enabled: !!period,
    retry: false,
    queryFn: () => api('GET', `/api/hr/payroll/${period}`, { schema: HrPayrollRun }),
  });
  const [newOpen, setNewOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const r = run.data;
  const draft = r?.status === 'draft';

  const refresh = (p = period) => {
    void qc.invalidateQueries({ queryKey: ['hr-runs'] });
    void qc.invalidateQueries({ queryKey: ['hr-run', p] });
    void qc.invalidateQueries({ queryKey: ['hr-cost'] });
    void qc.invalidateQueries({ queryKey: ['hr-slip-periods'] });
  };
  const act = async (path: string, msg: string, body: unknown = {}) => {
    setBusy(true);
    try {
      const out = await api('POST', `/api/hr/payroll/${period}/${path}`, { body, schema: HrPayrollRun });
      qc.setQueryData(['hr-run', period], out);
      refresh();
      toast(msg);
    } catch (e) {
      toast(admErr(e));
    } finally {
      setBusy(false);
    }
  };
  const editLine = async (l: HrPayrollLine, k: Editable, v: string) => {
    const cur = k === 'tax' ? l.taxOverride ?? l.tax : l[k];
    if (v === '' && k !== 'tax') v = '0';
    if (k !== 'tax' && d(v).eq(cur)) return;
    try {
      const out = await api('PATCH', `/api/hr/payroll/${period}/lines/${l.id}`, { body: { [k]: k === 'tax' && v === '' ? null : v }, schema: HrPayrollRun });
      qc.setQueryData(['hr-run', period], out);
    } catch (e) {
      toast(admErr(e));
      void qc.invalidateQueries({ queryKey: ['hr-run', period] });
    }
  };
  const inp = (l: HrPayrollLine, k: Editable, w: string) => {
    const v = k === 'tax' ? l.taxOverride ?? l.tax : l[k];
    if (!draft) return fmt(v);
    return (
      <input key={`${l.id}-${k}-${v}`} className={`qty ${w}`} type="number" min="0" step="0.01" defaultValue={Number(v) ? v : ''} placeholder="0"
        aria-label={`${k} ${l.name}`} data-testid={`pl-${k}-${l.code}`} onBlur={(e) => void editLine(l, k, e.target.value.trim())}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    );
  };
  const T = r?.totals;

  return (
    <>
      <div className="adm-bar">
        <span className="row">
          <select value={period ?? ''} onChange={(e) => setPeriod(e.target.value)} aria-label="งวดเงินเดือน" data-testid="pay-period">
            {!period && <option value="">ยังไม่มีงวด</option>}
            {period && !runs.rows.some((x) => x.period === period) && <option value={period}>{periodTH(period)}</option>}
            {runs.rows.map((x) => <option key={x.period} value={x.period}>{periodTH(x.period)}</option>)}
          </select>
          {r && <Pill k={PAY_STATUS[r.status][1]}>{PAY_STATUS[r.status][0]}{r.status === 'paid' && r.paidBy ? ` · ${r.paidBy} · ${r.payDate ? th(r.payDate) : ''}` : ''}</Pill>}
          <button className="btn sm" onClick={() => setNewOpen(true)} data-testid="pay-new">+ ทำเงินเดือนงวดใหม่</button>
        </span>
        {r && (
          <span className="row">
            <SlipLink to={`/payslip/${r.period}`} published={r.published} testId="slip-all">พิมพ์สลิปทั้งหมด</SlipLink>
            {draft && <button className="btn sm" disabled={busy} onClick={() => void act('recalc', 'คำนวณใหม่จากข้อมูลพนักงาน วันลา และยอดขายแล้ว')}>คำนวณใหม่</button>}
            {draft && <button className="btn sm pri" disabled={busy} onClick={() => void act('approve', `อนุมัติเงินเดือน${periodTH(r.period)}แล้ว`)} data-testid="pay-approve">อนุมัติงวดนี้</button>}
            {r.status === 'approved' && <button className="btn sm" disabled={busy} onClick={() => void act('reopen', 'กลับเป็นร่างแล้ว แก้ไขได้')}>กลับเป็นร่าง</button>}
            {r.status === 'approved' && <button className="btn sm pri" disabled={busy} onClick={() => setPayOpen(true)} data-testid="pay-confirm">ยืนยันจ่ายเงินเดือนงวดนี้</button>}
          </span>
        )}
      </div>
      {run.isError && !(run.error instanceof ApiFail && run.error.code === 'NOT_FOUND') && <ErrorBanner error={run.error} onRetry={() => void run.refetch()} retrying={run.isFetching} />}
      {!period && !runs.isLoading && <div className="empty">ยังไม่มีการทำเงินเดือน กด "ทำเงินเดือนงวดใหม่"</div>}
      {period && (
        <div className="tw">
          <table data-testid="pay-table">
            <thead>
              <tr><th>พนักงาน</th><th className="n">ฐาน</th><th className="n">วันทำงาน</th><th className="n">OT</th><th className="n">เบี้ยขยัน / อื่น ๆ</th><th className="n">คอมมิชชัน</th><th className="n">หักลา</th><th className="n">รวมเงินได้</th><th className="n">ประกันสังคม</th><th className="n">ภาษี</th><th className="n">เบิกล่วงหน้า</th><th className="n">สุทธิ</th><th /></tr>
            </thead>
            <tbody>
              {run.isLoading ? <SkeletonRows cols={13} rows={5} /> : (r?.lines ?? []).map((l) => (
                <tr key={l.id}>
                  <td>{l.name}<div className="small muted">{l.position} · {l.code}</div></td>
                  <td className="n">{fmt(l.base)}{l.pay === 'daily' && <div className="small muted">{fmt(l.rate)} /วัน</div>}</td>
                  <td className="n">{l.pay === 'daily' ? (draft ? inp(l, 'days', 'w56') : fq(l.days)) : '-'}</td>
                  <td className="n">{inp(l, 'ot', 'w74')}</td>
                  <td className="n">{inp(l, 'allowance', 'w74')}</td>
                  <td className="n">{Number(l.commission) ? <>{fmt(l.commission)}<div className="small muted">{fmt(l.commissionBase)}</div></> : '-'}</td>
                  <td className="n">{Number(l.unpaidAmt) ? <>−{fmt(l.unpaidAmt)}<div className="small muted">{fq(l.unpaidDays)} วัน</div></> : '-'}</td>
                  <td className="n">{fmt(l.gross)}</td>
                  <td className="n">{l.ssoEnrolled ? fmt(l.sso) : '-'}</td>
                  <td className="n">{inp(l, 'tax', 'w74')}</td>
                  <td className="n">{inp(l, 'advance', 'w74')}</td>
                  <td className="n"><b data-testid={`pl-net-${l.code}`}>{fmt(l.net)}</b></td>
                  <td><SlipLink to={`/payslip/${period}?emp=${l.employeeId}`} published={!!r?.published} testId={`slip-${l.code}`}>สลิป</SlipLink></td>
                </tr>
              ))}
              {T && (
                <tr>
                  <td><b>รวม {r?.lines.length} คน</b></td><td className="n">{fmt(T.base)}</td><td /><td className="n">{fmt(T.ot)}</td><td className="n">{fmt(T.allowance)}</td>
                  <td className="n">{fmt(T.commission)}</td><td className="n">{fmt(T.unpaidAmt)}</td><td className="n"><b>{fmt(T.gross)}</b></td><td className="n">{fmt(T.sso)}</td>
                  <td className="n">{fmt(T.tax)}</td><td className="n">{fmt(T.advance)}</td><td className="n"><b data-testid="pay-net-total">{fmt(T.net)}</b></td><td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {r && (
        <div className="kv" style={{ margin: '10px 0' }} data-testid="pay-note">
          <span>หมายเหตุงวดนี้</span>
          <EditableNote note={r.note} canEdit testId="pay-note-edit" onSave={async (note) => {
            const out = await api('PATCH', `/api/hr/payroll/${r.period}`, { body: { note }, schema: HrPayrollRun });
            qc.setQueryData(['hr-run', r.period], out);
            void qc.invalidateQueries({ queryKey: ['hr-runs'] });
          }} />
        </div>
      )}
      {r && (
        <p className="small muted">
          ประกันสังคม {d(r.ssoRate).times(100).toString()}% ฐานค่าจ้าง {fmt(r.ssoFloor)}–{fmt(r.ssoCap)} บาท (ตั้งได้ที่แท็บตั้งค่าเงินเดือน) · ภาษีเป็นประมาณการ ภ.ง.ด.1 แก้ได้
          · หักลาไม่รับค่าจ้าง / ลาเกินสิทธิ์ดึงจากเมนูวันลา · คอมมิชชันคิดจากยอดขายก่อน VAT ที่พนักงานออกบิล (ไม่นับบิลยกเลิก)
          {r.approvedBy && <> · อนุมัติโดย {r.approvedBy} {r.approvedAt ? thTime(r.approvedAt) : ''}</>}
        </p>
      )}
      <h4 className="sec" style={{ marginTop: 18 }}>งวดที่ผ่านมา</h4>
      <div className="tw">
        <table data-testid="runs-table">
          <thead><tr><th>งวด</th><th>สถานะ</th><th className="n">คน</th><th className="n">รวมเงินได้</th><th className="n">ประกันสังคม</th><th className="n">สุทธิ</th></tr></thead>
          <tbody>
            {runs.isLoading ? <SkeletonRows cols={6} rows={3} /> : runs.rows.map((x) => (
              <tr key={x.period} className="click" onClick={() => setPeriod(x.period)}>
                <td>{periodTH(x.period)}{x.note && <div className="small muted">{x.note}</div>}</td><td><Pill k={PAY_STATUS[x.status][1]}>{PAY_STATUS[x.status][0]}</Pill></td><td className="n">{x.headcount}</td>
                <td className="n">{fmt(x.totals.gross)}</td><td className="n">{fmt(x.totals.sso)}</td><td className="n">{fmt(x.totals.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!runs.hasNextPage} loading={runs.isFetchingNextPage} onMore={() => void runs.fetchNextPage()} count={runs.rows.length} testId="runs-more" />
      {newOpen && <NewRunModal existing={runs.rows.map((x) => x.period)} onClose={() => setNewOpen(false)} onCreated={(p) => { setNewOpen(false); setPeriod(p); refresh(p); }} />}
      {payOpen && r && (
        <PayModal period={r.period} net={T?.net ?? '0'} onClose={() => setPayOpen(false)} onPay={async (payDate) => { setPayOpen(false); await act('pay', `บันทึกจ่ายเงินเดือน${periodTH(r.period)}แล้ว · งวดนี้ล็อก`, { payDate }); }} />
      )}
    </>
  );
}

function NewRunModal({ existing, onClose, onCreated }: { existing: string[]; onClose: () => void; onCreated: (p: string) => void }) {
  const toast = useToast();
  const def = existing.includes(thisPeriod()) ? prevPeriod(thisPeriod()) : thisPeriod();
  const [p, setP] = useState(existing.includes(def) ? '' : def);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const go = async () => {
    if (!/^\d{4}-\d{2}$/.test(p)) return setErr('เลือกเดือน');
    try {
      await api('POST', '/api/hr/payroll', { body: { period: p, note: note.trim() || undefined }, schema: HrPayrollRun });
      toast(`สร้างเงินเดือน${periodTH(p)}แล้ว ระบบดึงค่าจ้าง วันลา และค่าคอมให้`);
      onCreated(p);
    } catch (e) {
      setErr(admErr(e));
    }
  };
  return (
    <Modal onClose={onClose} label="ทำเงินเดือนงวดใหม่">
      <h3>ทำเงินเดือนงวดใหม่</h3>
      <label className="f">เดือน<input type="month" value={p} onChange={(e) => setP(e.target.value)} data-testid="pay-new-period" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '7px 10px' }} /></label>
      <NoteField value={note} onChange={setNote} testId="pay-new-note" placeholder="เช่น รวมโบนัสสงกรานต์ / จ่ายช้า 2 วัน" />
      <p className="small muted" style={{ margin: 0 }}>ระบบสร้างรายการของพนักงานที่ทำงานอยู่ทุกคน (ไม่รวมเจ้าของกิจการและบุคคลภายนอก) จากค่าจ้าง ประกันสังคม วันลาที่อนุมัติ และยอดขายของแต่ละคน แก้ OT เบี้ย เบิกล่วงหน้า และภาษีได้จนกว่าจะอนุมัติ</p>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" onClick={() => void go()} data-testid="pay-new-ok">สร้าง</button></div>
    </Modal>
  );
}

function PayModal({ period, net, onClose, onPay }: { period: string; net: string; onClose: () => void; onPay: (payDate: string) => Promise<void> }) {
  const [date, setDate] = useState(todayYmd());
  return (
    <Modal onClose={onClose} label="ยืนยันจ่ายเงินเดือน">
      <h3>ยืนยันจ่ายเงินเดือน{periodTH(period)}</h3>
      <div className="tot"><span className="muted">ยอดโอนสุทธิรวม</span><span className="big">฿{fmt(net)}</span></div>
      <label className="f">วันที่จ่าย<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <div className="note warn small">หลังยืนยัน งวดนี้ถูกล็อก แก้ไขไม่ได้ (REQ-M17-02) พนักงานดูและพิมพ์สลิปของตัวเองได้</div>
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" onClick={() => void onPay(date)} data-testid="pay-ok">ยืนยันจ่าย</button></div>
    </Modal>
  );
}

export function LabourCost() {
  const cost = useQuery({ queryKey: ['hr-cost'], queryFn: () => api('GET', '/api/hr/labour-cost', { schema: z.object({ items: z.array(HrLabourCostRow) }) }) });
  return (
    <>
      <div className="tw" style={{ marginTop: 12 }}>
        <table data-testid="cost-table">
          <thead><tr><th>งวด</th><th className="n">คน</th><th className="n">เงินเดือนและค่าจ้างรวม</th><th className="n">ประกันสังคมส่วนนายจ้าง</th><th className="n">ค่าใช้จ่ายพนักงานรวม</th><th>สถานะ</th></tr></thead>
          <tbody>
            {cost.isLoading ? <SkeletonRows cols={6} rows={3} /> : (cost.data?.items ?? []).map((x) => (
              <tr key={x.period}>
                <td>{periodTH(x.period)}</td><td className="n">{x.headcount}</td><td className="n">{fmt(x.gross)}</td><td className="n">{fmt(x.employerSso)}</td>
                <td className="n"><b>{fmt(x.total)}</b></td><td><Pill k={PAY_STATUS[x.status][1]}>{PAY_STATUS[x.status][0]}</Pill></td>
              </tr>
            ))}
            {cost.data && !cost.data.items.length && <tr><td colSpan={6} className="empty">ยังไม่มีงวดเงินเดือน</td></tr>}
          </tbody>
        </table>
      </div>
      {cost.isError && <ErrorBanner error={cost.error} onRetry={() => void cost.refetch()} retrying={cost.isFetching} />}
      <p className="small muted">ค่าใช้จ่ายพนักงาน = ค่าจ้างรวม + ประกันสังคมส่วนนายจ้าง ใช้ในรายงานกำไรขาดทุนของร้าน (REQ-M11-06) · ระบบไม่ยื่น ภ.ง.ด.1 / สปส. แทนร้าน</p>
    </>
  );
}

export function PaySettings() {
  const toast = useToast();
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ['hr-settings'], queryFn: () => api('GET', '/api/hr/settings', { schema: HrSettings }) });
  const [f, setF] = useState<{ ssoRate: string; ssoCap: string; ssoFloor: string } | null>(null);
  useEffect(() => {
    if (s.data && !f) setF({ ssoRate: d(s.data.ssoRate).times(100).toString(), ssoCap: s.data.ssoCap, ssoFloor: s.data.ssoFloor });
  }, [s.data, f]);
  const save = async () => {
    if (!f) return;
    try {
      await api('PATCH', '/api/hr/settings', { body: { ssoRate: d(f.ssoRate || '0').div(100).toString(), ssoCap: f.ssoCap, ssoFloor: f.ssoFloor }, schema: HrSettings });
      void qc.invalidateQueries({ queryKey: ['hr-settings'] });
      toast('บันทึกตั้งค่าประกันสังคมแล้ว · มีผลกับงวดที่สร้างหรือคำนวณใหม่');
    } catch (e) {
      toast(admErr(e));
    }
  };
  if (!f) return <div className="card"><div className="sk" /><div className="sk" /></div>;
  return (
    <div style={{ marginTop: 12, maxWidth: 640 }}>
      <div className="fgrid">
        <label className="f">อัตราประกันสังคม (%)<input type="number" min="0" step="0.1" value={f.ssoRate} onChange={(e) => setF({ ...f, ssoRate: e.target.value })} /></label>
        <label className="f">เพดานค่าจ้าง (บาท/เดือน)<input type="number" min="0" value={f.ssoCap} onChange={(e) => setF({ ...f, ssoCap: e.target.value })} data-testid="sso-cap" /></label>
        <label className="f">ฐานค่าจ้างขั้นต่ำ (บาท/เดือน)<input type="number" min="0" value={f.ssoFloor} onChange={(e) => setF({ ...f, ssoFloor: e.target.value })} /></label>
      </div>
      <p className="small muted">ค่าเริ่มต้น 5% เพดาน 17,500 บาท ตามประกาศปรับฐานใหม่ (ตรวจกับสำนักงานประกันสังคมก่อนใช้จริง · OQ-15) · งวดที่อนุมัติหรือจ่ายแล้วไม่เปลี่ยน</p>
      <button className="btn pri" onClick={() => void save()}>บันทึก</button>
    </div>
  );
}
