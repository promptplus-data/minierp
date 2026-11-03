/** REQ-M14-03 (OQ-07: the main KPI = registered shops): registered, new per month, active in 30 days, by region. */
import { useQuery } from '@tanstack/react-query';
import { AdmKpi } from '@erp/contracts';
import { iconSvg } from '../../icons';
import { admErr, periodTH } from '../common';
import { th } from '../../../ui';
import { admApi } from './admApi';

const I = (svg: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
const CLOUD = 'var(--info)';
const ONPREM = 'var(--c-sys)';

export default function Kpi() {
  const k = useQuery({ queryKey: ['scg', 'kpi'], queryFn: () => admApi('GET', '/api/adm/kpi', { schema: AdmKpi }) });
  if (k.isLoading) return <div className="grid g4">{[0, 1, 2, 3].map((i) => <div key={i} className="card"><div className="sk" /><div className="sk" /></div>)}</div>;
  if (k.isError || !k.data) return <div className="card"><div className="note bad small">{admErr(k.error)}</div></div>;
  const x = k.data;
  const maxMonth = Math.max(1, ...x.newPerMonth.map((m) => m.cloud + m.onprem));
  const maxRegion = Math.max(1, ...x.byRegion.map((r) => r.total));
  return (
    <>
      <div className="grid g4">
        <div className="card kpi" data-testid="kpi-total">
          <span className="ki">{I(iconSvg('admShops'))}</span>
          <div className="l">ร้านที่ลงทะเบียนทั้งหมด (KPI หลัก)</div><div className="v">{x.total}</div>
          <div className="s">Cloud {x.byEdition.cloud} · On-premise ที่มี license {x.byEdition.onprem}</div>
        </div>
        <div className="card kpi">
          <span className="ki">{I(iconSvg('admMonitor'))}</span>
          <div className="l">ใช้งานใน 30 วัน (มีบิล ≥ 1 ใบ)</div><div className="v">{x.active30}</div>
          <div className="s">Cloud {x.active30ByEdition.cloud} · On-premise {x.active30ByEdition.onprem}</div>
        </div>
        <div className="card kpi">
          <span className="ki">{I(iconSvg('admUsers'))}</span>
          <div className="l">อัตราใช้งาน</div><div className="v">{x.total ? Math.round((x.active30 / x.total) * 100) : 0}%</div>
          <div className="s">ร้านที่ active ÷ ร้านที่ลงทะเบียน</div>
        </div>
        <div className="card kpi" style={{ ['--k' as string]: 'var(--bad)' }}>
          <span className="ki">{I(iconSvg('admShops'))}</span>
          <div className="l">ระงับชั่วคราว</div><div className="v">{x.suspended}</div><div className="s">ข้อมูล ณ {th(x.asOf)}</div>
        </div>
      </div>
      <div className="grid g2">
        <div className="card">
          <h2>ร้านใหม่รายเดือน</h2>
          <div className="adm-legend" style={{ marginBottom: 8 }}><span><i style={{ background: CLOUD }} />Cloud</span><span><i style={{ background: ONPREM }} />On-premise (license)</span></div>
          <div className="adm-bars" data-testid="kpi-months">
            {x.newPerMonth.map((m) => (
              <div key={m.month} className="b">
                <span>{periodTH(m.month)}</span>
                <span className="t" title={`Cloud ${m.cloud} · On-premise ${m.onprem}`}>
                  <i style={{ width: `${(m.cloud / maxMonth) * 100}%`, background: CLOUD }} />
                  <i style={{ width: `${(m.onprem / maxMonth) * 100}%`, background: ONPREM, marginLeft: m.cloud && m.onprem ? 2 : 0 }} />
                </span>
                <b className="small">{m.cloud + m.onprem}</b>
              </div>
            ))}
            {!x.newPerMonth.length && <div className="empty">ยังไม่มีร้าน</div>}
          </div>
        </div>
        <div className="card">
          <h2>แยกตามภาค / เขตขาย SCG</h2>
          <div className="adm-legend" style={{ marginBottom: 8 }}><span><i style={{ background: 'var(--c-adm)' }} />active 30 วัน</span><span><i style={{ background: 'var(--line)' }} />ลงทะเบียน</span></div>
          <div className="adm-bars" data-testid="kpi-regions">
            {x.byRegion.map((r) => (
              <div key={r.region} className="b">
                <span>{r.region}</span>
                <span className="t" title={`active ${r.active30} / ${r.total}`}>
                  <i style={{ width: `${(r.active30 / maxRegion) * 100}%`, background: 'var(--c-adm)' }} />
                  <i style={{ width: `${((r.total - r.active30) / maxRegion) * 100}%`, background: 'var(--line)' }} />
                </span>
                <b className="small">{r.active30} / {r.total}</b>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="small muted" style={{ margin: 0 }}>นับร้าน Cloud ทุกร้าน และร้าน On-premise ที่ SCG ออก license ให้ (ร้าน On-premise ไม่ต่อเน็ตจึงนับ active จากสรุปยอดขายที่ร้านเลือกส่ง) · ไม่แสดงข้อมูลส่วนบุคคลของลูกค้าร้าน</p>
    </>
  );
}
