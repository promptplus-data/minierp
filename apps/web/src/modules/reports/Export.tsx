/** M12 export to accounting programs: PEAK (templates), FlowAccount, Express, journal, general CSV/Excel; GL codes; history. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EXPORT_COMBOS, ExportGl, ExportRun, type ExportDataset, type ExportTemplate } from '@erp/contracts';
import { GL_LABELS } from '@erp/core';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { SkeletonRows, thTime, useToast } from '../../ui';
import { LoadMore, useLoadMore } from '../../ui/lists';
import { Field, bkkToday, downloadFile, monthEnd, monthStart, prevMonth, thisMonth } from './shared';

const TPL: [ExportTemplate, string][] = [['peak', 'PEAK'], ['flowaccount', 'FlowAccount'], ['express', 'Express'], ['journal', 'Journal (เดบิต/เครดิต)'], ['generic', 'Excel / CSV ทั่วไป']];
const DS: Record<ExportDataset, string> = {
  sales: 'สมุดขาย', purchase: 'สมุดซื้อ', receipts: 'รับชำระ (แยกวิธีชำระ)', stock: 'สต็อกคงเหลือ', vatSales: 'รายงานภาษีขาย', vatPurchase: 'รายงานภาษีซื้อ',
  products: 'นำเข้าสินค้า (template)', contacts: 'นำเข้าผู้ติดต่อ (template)',
};
const tplName = (t: string) => TPL.find((x) => x[0] === t)?.[1] ?? t;
const MASTER: ExportDataset[] = ['products', 'contacts'];

function GlCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const gl = useQuery({ queryKey: ['rp', 'gl'], queryFn: () => api('GET', '/api/acct-export/gl', { schema: ExportGl }) });
  const [edit, setEdit] = useState<Partial<ExportGl>>({});
  const save = useMutation({
    mutationFn: () => api('PATCH', '/api/acct-export/gl', { body: edit, schema: ExportGl }),
    onSuccess: (r) => { qc.setQueryData(['rp', 'gl'], r); setEdit({}); toast('บันทึกผังบัญชีสำหรับส่งออกแล้ว'); },
    onError: (e) => toast(errText(e)),
  });
  const keys = Object.keys(GL_LABELS) as (keyof ExportGl)[];
  return (
    <div className="card" data-testid="gl-card">
      <h2>ผังบัญชีสำหรับส่งออก</h2>
      <p className="small muted" style={{ margin: '0 0 10px' }}>เลขบัญชีเหล่านี้ใช้ในไฟล์ PEAK / Journal ทุกไฟล์ · แก้ได้โดยผู้มีสิทธิ์ส่งออกข้อมูล และบันทึกในประวัติการทำรายการ</p>
      {gl.isLoading ? <div className="sk" /> : (
        <div className="ex-gl">
          {keys.map((k) => (
            <label key={k}>{GL_LABELS[k]}<input value={edit[k] ?? gl.data?.[k] ?? ''} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} aria-label={`บัญชี ${GL_LABELS[k]}`} data-testid={`gl-${k}`} /></label>
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn pri sm" disabled={!Object.keys(edit).length || save.isPending} onClick={() => save.mutate()} data-testid="gl-save">{save.isPending ? 'กำลังบันทึก…' : 'บันทึกผังบัญชี'}</button>
        {!!Object.keys(edit).length && <button className="btn sm" onClick={() => setEdit({})}>ยกเลิกการแก้</button>}
      </div>
    </div>
  );
}

function FileLinks({ run }: { run: ExportRun }) {
  const toast = useToast();
  return (
    <span className="ex-files">
      {run.files.map((f) => (
        <button key={f.seq} className="btn sm" onClick={() => downloadFile(`/api/acct-export/runs/${run.id}/files/${f.seq}`, {}, f.name).then((n) => toast(`ดาวน์โหลด ${n} แล้ว`), (e) => toast(errText(e)))} data-testid={`file-${f.seq}`}>
          ⭳ {f.name} <span className="muted">({f.rows} แถว)</span>
        </button>
      ))}
    </span>
  );
}

export default function Export() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [template, setTemplate] = useState<ExportTemplate>('peak');
  const [dataset, setDataset] = useState<ExportDataset>('sales');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(bkkToday());
  const [onlyNew, setOnlyNew] = useState(false);
  const [format, setFormat] = useState<'csv' | 'xlsx'>('csv');
  const [result, setResult] = useState<ExportRun | null>(null);
  const datasets = EXPORT_COMBOS[template];
  const ds = datasets.includes(dataset) ? dataset : datasets[0]!;
  const master = MASTER.includes(ds);
  const canExport = !!can('data.export');

  const run = useMutation({
    mutationFn: () => api('POST', '/api/acct-export/runs', { body: { template, dataset: ds, from: master ? undefined : from, to: master ? undefined : to, onlyNew: master ? false : onlyNew, format }, schema: ExportRun }),
    onSuccess: (r) => { setResult(r); void qc.invalidateQueries({ queryKey: ['rp', 'runs'] }); toast(`สร้างไฟล์แล้ว ${r.rows} แถว ${r.files.length} ไฟล์`); },
    onError: (e) => toast(errText(e)),
  });
  const setMonth = (m: string) => { setFrom(`${m}-01`); setTo(monthEnd(m)); };

  const runs = useLoadMore(['rp', 'runs'], '/api/acct-export/runs', ExportRun, {}, 10, canExport);
  const loading = runs.isLoading && canExport;

  return (
    <>
      <div className="card">
        <h2>ส่งออกข้อมูลให้นักบัญชี / โปรแกรมบัญชี</h2>
        <div className="ex-form">
          <Field label="รูปแบบไฟล์"><select value={template} onChange={(e) => setTemplate(e.target.value as ExportTemplate)} aria-label="รูปแบบไฟล์" data-testid="ex-template">{TPL.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="ข้อมูล"><select value={ds} onChange={(e) => setDataset(e.target.value as ExportDataset)} aria-label="ข้อมูลที่ส่งออก" data-testid="ex-dataset">{datasets.map((k) => <option key={k} value={k}>{DS[k]}</option>)}</select></Field>
          {!master && <Field label="ตั้งแต่วันที่"><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="ตั้งแต่วันที่" data-testid="ex-from" /></Field>}
          {!master && <Field label="ถึงวันที่"><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="ถึงวันที่" data-testid="ex-to" /></Field>}
          {template !== 'peak' && <Field label="ชนิดไฟล์"><select value={format} onChange={(e) => setFormat(e.target.value as 'csv' | 'xlsx')} aria-label="ชนิดไฟล์"><option value="csv">CSV (UTF-8)</option><option value="xlsx">Excel (.xlsx)</option></select></Field>}
        </div>
        {!master && (
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn sm" onClick={() => setMonth(thisMonth())}>เดือนนี้</button>
            <button className="btn sm" onClick={() => setMonth(prevMonth())}>เดือนที่แล้ว</button>
            <label className="row small" style={{ marginLeft: 8 }}><input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} data-testid="ex-only-new" /> เฉพาะเอกสารที่ยังไม่เคยส่งออกด้วยโปรแกรมนี้</label>
          </div>
        )}
        {template === 'peak' && <p className="small muted" style={{ margin: '10px 0 0' }}>PEAK: ไฟล์ตาม template (หัวตาราง 2 แถว) · ไม่เกิน 1,000 แถวต่อไฟล์ ระบบแบ่งไฟล์ให้อัตโนมัติ · เลขบัญชีจากผังบัญชีด้านล่าง</p>}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn pri" disabled={!canExport || run.isPending || (!master && from > to)} onClick={() => run.mutate()} data-testid="ex-run">{run.isPending ? 'กำลังสร้างไฟล์…' : 'สร้างไฟล์'}</button>
          {!canExport && <span className="small muted">บทบาทนี้ไม่มีสิทธิ์ส่งออกข้อมูล</span>}
        </div>
        {result && (
          <div className="note" style={{ marginTop: 12 }} data-testid="ex-result">
            <b>สร้างไฟล์แล้ว</b> · {tplName(result.template)} · {DS[result.dataset]} · {result.rows} แถว · {result.docs} เอกสาร
            <div style={{ marginTop: 8 }}><FileLinks run={result} /></div>
            {result.warnings.map((w) => <div key={w} className="small" style={{ marginTop: 6, color: 'var(--warn)' }}>⚠ {w}</div>)}
          </div>
        )}
      </div>

      {canExport && <GlCard />}

      {canExport && (
        <div className="card" data-testid="ex-history">
          <h2>ประวัติการส่งออก</h2>
          <div className="tw">
            <table>
              <thead><tr><th>วันที่</th><th>รูปแบบ</th><th>ข้อมูล</th><th>ช่วงเวลา</th><th className="n">แถว</th><th>โดย</th><th>ไฟล์</th></tr></thead>
              <tbody>
                {loading ? <SkeletonRows cols={7} rows={4} /> : runs.rows.map((h) => (
                  <tr key={h.id}>
                    <td className="small nw">{thTime(h.createdAt)}</td><td>{tplName(h.template)}</td><td>{DS[h.dataset]}{h.onlyNew ? <div className="small muted">เฉพาะที่ยังไม่ส่งออก</div> : null}</td>
                    <td className="small nw">{h.from ? `${h.from} – ${h.to}` : 'ข้อมูลหลัก'}</td><td className="n">{h.rows}</td><td className="small nw">{h.createdBy}</td>
                    <td><FileLinks run={h} />{h.changedAfter.length > 0 && <div className="small" style={{ color: 'var(--bad)', marginTop: 4 }}>เอกสารยกเลิกหลังส่งออก: {h.changedAfter.map((x) => x.no).join(', ')} · แก้ในโปรแกรมบัญชีด้วย</div>}</td>
                  </tr>
                ))}
                {!loading && !runs.rows.length && <tr><td colSpan={7} className="empty">ยังไม่เคยส่งออก</td></tr>}
              </tbody>
            </table>
          </div>
          <LoadMore hasMore={!!runs.hasNextPage} loading={runs.isFetchingNextPage} onMore={() => void runs.fetchNextPage()} count={runs.rows.length} />
        </div>
      )}
    </>
  );
}
