/** CLOUD ONLY. Prompt Plus single sign-on (REQ-M01-01): placeholder until the SSO integration ships. */
import { useState } from 'react';
import { useMeta } from '../data';

export default function SsoButton() {
  const meta = useMeta();
  const [note, setNote] = useState(false);
  if (!meta.data?.capabilities.promptPlusSso) return null;
  return (
    <>
      <button className="btn pri" style={{ width: '100%', justifyContent: 'center', marginTop: 16 }} onClick={() => setNote(true)} data-testid="pp-sso">
        เข้าด้วยบัญชี Prompt Plus (เจ้าของร้าน)
      </button>
      {note && <div className="note small" style={{ marginTop: 8 }} role="status">การเข้าด้วยบัญชี Prompt Plus (SSO) กำลังจะมาเร็ว ๆ นี้ ตอนนี้ให้เข้าด้วยชื่อผู้ใช้ของร้านไปก่อน</div>}
    </>
  );
}
