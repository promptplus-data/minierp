/** Shared bits of the admin module screens: labels, dates, error text, A4 print mode, the payslip paper. */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HrMe, type HrEmpType, type HrLeaveType, type HrPayslip, type LicenseStatus } from '@erp/contracts';
import { LEAVE_TH, periodTH } from '@erp/core';
import { ApiFail, api, errText, registerReasons } from '../../api';
import { useAuth } from '../../auth';
import { fmt, th } from '../../ui';
import './admin.css';

export const EMP_TYPE_TH: Record<HrEmpType, string> = {
  monthly: 'รายเดือน', daily: 'รายวัน', parttime: 'พาร์ทไทม์', external: 'บุคคลภายนอก', owner: 'เจ้าของกิจการ',
};
export const LEAVE_LABEL: Record<HrLeaveType, string> = LEAVE_TH;
export const PAY_STATUS: Record<'draft' | 'approved' | 'paid', [string, 'warn' | 'acc' | 'ok']> = {
  draft: ['ร่าง · แก้ได้', 'warn'], approved: ['อนุมัติแล้ว · รอจ่าย', 'acc'], paid: ['จ่ายแล้ว · ล็อก', 'ok'],
};
export { periodTH };

/** Today in the shop's time zone, YYYY-MM-DD. */
export const todayYmd = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
export const thisPeriod = () => todayYmd().slice(0, 7);
export const prevPeriod = (p: string) => {
  const [y, m] = p.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

/** Thai text for the module's own error reasons (details.reason), else the generic message. */
const REASONS: Record<string, string> = {
  OWNER_ONLY: 'เฉพาะเจ้าของร้านเท่านั้นที่ทำรายการนี้ได้',
  LAST_SUPER: 'ต้องมี Super admin ที่ใช้งานอยู่อย่างน้อย 1 คน ปิดใช้งานหรือลดบทบาทคนสุดท้ายไม่ได้',
  ADM_SELF: 'ปิดใช้งานหรือลดบทบาทบัญชีของตัวเองไม่ได้ ให้ Super admin คนอื่นทำให้',
  LICENSE_INVALID: 'license key ไม่ถูกต้อง (ลายเซ็นไม่ตรง หรือคัดลอกไม่ครบ)',
  LICENSE_EDITION: 'คีย์นี้ไม่ใช่ของรุ่น On-premise',
  LICENSE_SHOP_MISMATCH: 'คีย์นี้ออกให้ร้านอื่น (ชื่อร้านหรือเลขผู้เสียภาษีไม่ตรงกับร้านนี้)',
  LICENSE_READ_ONLY: 'ไลเซนส์หมดอายุ (หรือยังไม่ได้ใส่คีย์) ร้านอยู่ในโหมดอ่านอย่างเดียว ดู พิมพ์ และส่งออกได้ แต่ทำรายการใหม่ไม่ได้',
  TERMS_REQUIRED: 'เจ้าของร้านต้องลงนามสัญญาการใช้งานก่อน',
  SHOP_SUSPENDED: 'ร้านนี้ถูก SCG ระงับการใช้งานชั่วคราว ติดต่อ SCG',
  BACKUP_INCOMPLETE: 'ต้องเลือกปลายทางและตั้งรหัสเข้ารหัสข้อมูลสำรองก่อน',
  OAUTH_NOT_CONFIGURED: 'ปลายทางนี้ยังไม่เปิดให้ใช้ (SCG ยังไม่ได้ลงทะเบียนแอปกับผู้ให้บริการ) ใช้ S3 ไปก่อน',
  OAUTH_NOT_CONNECTED: 'ต้องเชื่อมบัญชีปลายทางก่อนเปิดการสำรองข้อมูล',
  BACKUP_DEST: 'เชื่อมต่อปลายทางสำรองข้อมูลไม่ได้ ตรวจการตั้งค่าและอินเทอร์เน็ต',
  BOX_DECRYPT: 'ถอดรหัสไม่ได้: รหัสผ่านไม่ถูกต้อง หรือไฟล์ถูกแก้ไข',
  NOT_EMPTY: 'เครื่องนี้มีข้อมูลร้านแล้ว กู้คืนได้เฉพาะเครื่องใหม่ที่ยังไม่มีร้าน',
  PAYROLL_LOCKED: 'งวดนี้ล็อกแล้ว แก้ไม่ได้',
  NO_EMPLOYEE: 'ผู้ใช้นี้ยังไม่ได้ผูกกับพนักงาน',
  CONSENT_REQUIRED: 'ต้องติ๊กยินยอมทุกข้อที่บังคับ',
  SIGNING_KEY_MISSING: 'เซิร์ฟเวอร์ยังไม่ได้ตั้ง LICENSE_SIGNING_KEY ออกคีย์ไม่ได้',
  RATE_LIMITED: 'ลองผิดหลายครั้งเกินไป รอ 10 นาทีแล้วลองใหม่',
  SHARE_URL_MISSING: 'ยังไม่ได้ตั้งปลายทางของ SCG (SCG_SHARE_URL) ในเครื่องหลัก',
  LICENSE_REQUIRED: 'ต้องใส่ license key ก่อน (คีย์ใช้ยืนยันกับ SCG ว่าเป็นร้านนี้)',
  USERNAME_TAKEN: 'ชื่อผู้ใช้นี้มีแล้วในร้าน (รวมพนักงานที่ลาออก) ใช้ชื่ออื่น',
  SELF_APPROVAL: 'อนุมัติรายการของตัวเองไม่ได้ ให้ผู้จัดการหรือเจ้าของคนอื่นอนุมัติ',
  CODE_TAKEN: 'รหัสร้านนี้มีแล้ว ใช้รหัสอื่น',
  ADM_ROLE: 'บทบาทผู้ดูแลของคุณทำรายการนี้ไม่ได้',
  NO_SUPPORT_GRANT: 'ร้านยังไม่ได้อนุญาตให้ SCG เข้าดู (หรือการอนุญาตหมดอายุแล้ว)',
  BOX_FORMAT: 'ไฟล์ไม่ถูกต้อง (ไม่ใช่ไฟล์ส่งออกของ SCG Shop ERP)',
  BOX_KIND: 'ไฟล์ผิดประเภท (เช่น ไฟล์สำรองข้อมูลแทนไฟล์ย้ายร้าน)',
  IMPORT_MISMATCH: 'ตรวจยอดหลังนำเข้าไม่ตรงกับไฟล์ ระบบยกเลิกการนำเข้าทั้งหมด',
  TERMS_VERSION: 'สัญญามีเวอร์ชันใหม่ โหลดหน้าใหม่แล้วอ่านอีกครั้ง',
  OAUTH_START_FAILED: 'ผู้ให้บริการไม่รับคำขอเชื่อมบัญชี ลองใหม่ภายหลัง',
  OAUTH_POLL_FAILED: 'เชื่อมบัญชีไม่สำเร็จ ลองใหม่อีกครั้ง',
  OAUTH_NETWORK: 'ติดต่อผู้ให้บริการไม่ได้ ตรวจอินเทอร์เน็ต',
};
registerReasons(REASONS);
const ADM_LOGIN: Record<string, string> = {
  DISABLED: 'บัญชีผู้ดูแลนี้ถูกปิดใช้งาน เข้าระบบไม่ได้ ให้ Super admin เปิดใช้งานให้',
  LOCKED: 'บัญชีถูกล็อกเพราะใส่รหัสผ่านผิด 5 ครั้ง ให้ Super admin ตั้งรหัสผ่านใหม่ให้',
  BAD_CREDENTIALS: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
};
export function admErr(e: unknown): string {
  if (e instanceof ApiFail) {
    const r = e.detail<string>('reason');
    if (e.code === 'UNAUTHORIZED' && r && ADM_LOGIN[r]) return ADM_LOGIN[r]!;
    if (r && REASONS[r]) return REASONS[r]!;
  }
  return errText(e);
}

/** Adds html.pa4 while mounted so window.print() uses A4 pages and prints the content area only. */
export function usePrintA4() {
  useEffect(() => {
    document.documentElement.classList.add('pa4');
    return () => document.documentElement.classList.remove('pa4');
  }, []);
}

export const useHrMe = () => {
  const { user } = useAuth();
  return useQuery({ queryKey: ['hr-me', user?.id], queryFn: () => api('GET', '/api/hr/me', { schema: HrMe }), staleTime: 60_000 });
};

export const LICENSE_STATE: Record<LicenseStatus['state'], [string, 'ok' | 'warn' | 'bad' | 'mut']> = {
  none: ['ยังไม่ได้ใส่คีย์', 'mut'], valid: ['ใช้งานได้', 'ok'], expiring: ['ใกล้หมดอายุ', 'warn'], expired: ['หมดอายุ · อ่านอย่างเดียว', 'bad'],
};

/** REQ-M17-03 printable payslip (mockup pSlip on A4). */
export function PayslipPaper({ s }: { s: HrPayslip }) {
  return (
    <div className="paper slip-a4" data-testid="payslip">
      <div className="ph">
        <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
          <div className="plogo">{s.shop.name.replace(/^ร้าน/, '').slice(0, 1)}</div>
          <div>
            <b style={{ fontSize: 15 }}>{s.shop.name}</b>
            {s.shop.address && <div>{s.shop.address}</div>}
            <div>{s.shop.taxId ? `เลขประจำตัวผู้เสียภาษี ${s.shop.taxId} · ${s.shop.branch || 'สำนักงานใหญ่'}` : ''}{s.shop.phone ? ` · โทร ${s.shop.phone}` : ''}</div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <h4>สลิปเงินเดือน</h4>
          <div className="pm">ลับเฉพาะ</div>
          <div>เลขที่ <b>{s.no}</b></div>
          <div>งวด {s.periodLabel}</div>
        </div>
      </div>
      <div className="two" style={{ marginBottom: 10 }}>
        <div><span className="pm">พนักงาน</span><br /><b>{s.employee.name}</b> ({s.employee.code})<br />{s.employee.position} · {EMP_TYPE_TH[s.employee.type]}</div>
        <div>
          <div><span className="pm">โอนเข้าบัญชี</span> {s.employee.bankAccount || '-'}</div>
          <div><span className="pm">วันที่จ่าย</span> {s.payDate ? th(s.payDate) : '-'}</div>
          <div><span className="pm">สถานะ</span> {PAY_STATUS[s.status][0]}</div>
        </div>
      </div>
      <div className="two">
        <table>
          <thead><tr><th>รายได้</th><th className="n">จำนวนเงิน</th></tr></thead>
          <tbody>
            {s.earnings.map((x) => <tr key={x.label}><td>{x.label}</td><td className="n">{fmt(x.amount)}</td></tr>)}
            <tr><td><b>รวมเงินได้</b></td><td className="n"><b>{fmt(s.gross)}</b></td></tr>
          </tbody>
        </table>
        <table>
          <thead><tr><th>รายการหัก</th><th className="n">จำนวนเงิน</th></tr></thead>
          <tbody>
            {s.deductions.length ? s.deductions.map((x) => <tr key={x.label}><td>{x.label}</td><td className="n">{fmt(x.amount)}</td></tr>) : <tr><td className="pm">ไม่มีรายการหัก</td><td /></tr>}
            <tr><td><b>รวมรายการหัก</b></td><td className="n"><b>{fmt(s.totalDeductions)}</b></td></tr>
          </tbody>
        </table>
      </div>
      <div className="net"><b>เงินได้สุทธิ</b><b data-testid="payslip-net">{fmt(s.net)} บาท</b></div>
      <div className="pbaht">({s.netText})</div>
      <div className="sig"><div>ผู้จ่ายเงิน</div><div>ผู้รับเงิน</div></div>
    </div>
  );
}
