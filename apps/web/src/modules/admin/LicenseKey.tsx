/**
 * REQ-M19-11 license key status and entry (owner). On-prem: the "License key" tab of the system screen.
 * Cloud: a card on the terms screen (cloud shops enter the cloud key SCG issued them the same way).
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LicenseStatus } from '@erp/contracts';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { th, thTime, useToast } from '../../ui';
import { LICENSE_STATE, admErr } from './common';
import { useLicense } from './Gate';
import { IS_CLOUD } from '../../cloud';

export default function LicenseKey() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const lic = useLicense();
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  const owner = user?.role === 'owner';
  const install = async () => {
    setErr('');
    try {
      const out = await api('POST', '/api/license', { body: { key: key.trim() }, schema: LicenseStatus });
      qc.setQueryData(['license', user?.id], out);
      setKey('');
      toast(out.license?.expiresAt ? `ติดตั้ง license แล้ว · ใช้ได้ถึง ${th(out.license.expiresAt)}` : 'ติดตั้ง license แบบตลอดชีพแล้ว');
    } catch (e) {
      setErr(admErr(e));
    }
  };
  const s = lic.data;
  return (
    <div className="grid g2">
      <div>
        <h4 className="sec">สถานะ</h4>
        {lic.isLoading && <div className="sk" />}
        {s && (
          <div className="kv" style={{ marginTop: 8 }} data-testid="license-status">
            <span>สถานะ</span><span><span className={`pill p-${LICENSE_STATE[s.state][1]}`}>{LICENSE_STATE[s.state][0]}</span></span>
            {s.license && <>
              <span>เลขที่ license</span><span className="mono">{s.license.licenseId}</span>
              <span>ออกให้</span><span>{s.license.shopName} · {s.license.taxId}</span>
              <span>ประเภท</span><span>{s.license.type === 'lifetime' ? 'ตลอดชีพ' : 'มีวันหมดอายุ'}</span>
              <span>หมดอายุ</span><span>{s.license.expiresAt ? `${th(s.license.expiresAt)}${s.daysLeft !== null ? ` (${s.daysLeft >= 0 ? `เหลือ ${s.daysLeft} วัน` : `เลยมา ${-s.daysLeft} วัน`})` : ''}` : '-'}</span>
              <span>ติดตั้งเมื่อ</span><span>{s.installedAt ? thTime(s.installedAt) : '-'}</span>
            </>}
          </div>
        )}
        <p className="small muted">{IS_CLOUD
          ? 'คีย์ผูกกับชื่อร้านและเลขผู้เสียภาษี SCG ออกให้ที่หน้าผู้ดูแล · แบบตลอดชีพใช้ได้จนกว่า SCG ยกเลิก · ไม่มีคีย์ หมดอายุ หรือถูกยกเลิก ร้านดูข้อมูล พิมพ์ และส่งออกได้ แต่บันทึกรายการใหม่ไม่ได้'
          : 'คีย์ผูกกับชื่อร้านและเลขผู้เสียภาษี เซ็นดิจิทัลโดย SCG ตรวจได้ในเครื่องโดยไม่ต้องต่อเน็ต · ระบบเตือนก่อนหมดอายุ 30 วัน · หมดอายุแล้วดูข้อมูล พิมพ์ และส่งออกได้ แต่ออกเอกสารใหม่ไม่ได้'}</p>
      </div>
      <div>
        <h4 className="sec">ใส่คีย์ใหม่ / ต่ออายุ</h4>
        {owner ? (
          <>
            <textarea className="adm-key" style={{ marginTop: 8 }} value={key} placeholder="SCG1.xxxxx.yyyyy (วางคีย์ที่ได้รับจาก SCG)" onChange={(e) => setKey(e.target.value)} aria-label="license key" data-testid="license-key" spellCheck={false} />
            {err && <div className="err" role="alert" data-testid="license-error">{err}</div>}
            <button className="btn pri" style={{ marginTop: 8 }} disabled={key.trim().length < 20} onClick={() => void install()} data-testid="license-install">ติดตั้ง license</button>
          </>
        ) : <div className="note small">เฉพาะเจ้าของร้านใส่คีย์ได้</div>}
      </div>
    </div>
  );
}
