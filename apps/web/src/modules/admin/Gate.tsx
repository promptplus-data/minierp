/**
 * WebModule.Wrap of the admin module, around every signed-in screen:
 * - BR-15: a shop flagged by SCG Admin shows only the terms until the owner signs (the server refuses the rest anyway);
 * - REQ-M19-11 (both editions): license banner 30 days before expiry, and the read-only notice after expiry or
 *   while a required key is missing (cloud shops need a key once the server issues them).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LicenseStatus } from '@erp/contracts';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { IS_CLOUD } from '../../cloud';
import { th } from '../../ui';
import { TermsSign, useTerms } from './Terms';

export const useLicense = () => {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['license', user?.id], enabled: !!user, staleTime: 5 * 60_000,
    queryFn: () => api('GET', '/api/license', { schema: LicenseStatus }),
  });
};

function LicenseBanner() {
  const lic = useLicense();
  const { can } = useAuth();
  const s = lic.data;
  if (!s || (s.state !== 'expiring' && s.state !== 'expired' && !(s.state === 'none' && s.required))) return null;
  const owner = can('sys.settings') === 1;
  const link = owner ? <Link className="btn sm" to={IS_CLOUD ? '/terms' : '/system'}>ใส่ license key</Link> : <span className="small">แจ้งเจ้าของร้าน</span>;
  if (s.state === 'expiring') {
    return (
      <div className="adm-banner" role="status" data-testid="license-banner">
        <b>ไลเซนส์ใกล้หมดอายุ</b>
        <span>เหลืออีก {s.daysLeft} วัน (หมดอายุ {s.license?.expiresAt ? th(s.license.expiresAt) : '-'}) · ติดต่อ SCG เพื่อต่ออายุ แล้วใส่คีย์ใหม่</span>
        <span className="sp" />{link}
      </div>
    );
  }
  return (
    <div className="adm-banner bad" role="alert" data-testid="license-banner">
      <b>{s.state === 'expired' ? 'ไลเซนส์หมดอายุแล้ว' : 'ยังไม่ได้ใส่ license key'}</b>
      <span>โหมดอ่านอย่างเดียว: ดูข้อมูล พิมพ์ และส่งออกได้ แต่ออกเอกสารใหม่ไม่ได้</span>
      <span className="sp" />{link}
    </div>
  );
}

export default function AdminWrap({ children }: { children: ReactNode }) {
  const terms = useTerms();
  if (terms.data?.required && !terms.data.accepted) return <TermsSign st={terms.data} gate />;
  return (
    <>
      <LicenseBanner />
      {children}
    </>
  );
}
