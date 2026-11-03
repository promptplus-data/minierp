/** M17 HR screen (mockup VIEWS.hr): employees and users, payroll / slips, labour cost, payroll settings. */
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth';
import Employees from './Employees';
import Payroll, { LabourCost, PaySettings } from './Payroll';

const TABS = [['emp', 'พนักงานและผู้ใช้'], ['pay', 'เงินเดือน / สลิป'], ['cost', 'ค่าใช้จ่ายพนักงาน'], ['set', 'ตั้งค่าเงินเดือน']] as const;
type Tab = (typeof TABS)[number][0];

export default function HrPage() {
  const { can } = useAuth();
  const sal = can('hr.salary') === 1;
  const [sp, setSp] = useSearchParams();
  const tab = (TABS.some(([k]) => k === sp.get('tab')) ? sp.get('tab') : 'emp') as Tab;
  const owner = (body: JSX.Element) => (sal ? body : <div className="empty">ดูได้เฉพาะเจ้าของร้าน (สิทธิ์ "ดูและจ่ายเงินเดือน")</div>);
  return (
    <div className="card">
      <div className="tabs" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setSp(k === 'emp' ? {} : { tab: k }, { replace: true })}>{l}</button>
        ))}
      </div>
      {tab === 'emp' && <Employees />}
      {tab === 'pay' && owner(<Payroll />)}
      {tab === 'cost' && (can('rep.view') || sal ? <LabourCost /> : owner(<span />))}
      {tab === 'set' && owner(<PaySettings />)}
    </div>
  );
}
