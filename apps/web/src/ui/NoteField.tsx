/** หมายเหตุ (free note) on every document form, and how a saved note shows on a detail / print page. */
import { useState } from 'react';

export const NOTE_MAX = 500;

export function NoteField({ value, onChange, testId = 'note', placeholder = 'เช่น รายละเอียดเพิ่มเติม ข้อตกลงกับคู่ค้า', label = 'หมายเหตุ', rows = 2, span = true, disabled }: {
  value: string; onChange: (v: string) => void; testId?: string; placeholder?: string; label?: string; rows?: number; span?: boolean; disabled?: boolean;
}) {
  return (
    <label className="f" style={span ? { gridColumn: '1/-1' } : undefined}>{label}
      <textarea name="note" data-field="note" rows={rows} maxLength={NOTE_MAX} value={value} placeholder={placeholder} disabled={disabled}
        onChange={(e) => onChange(e.target.value)} data-testid={testId} />
    </label>
  );
}

/** Read-only note for detail pages (`kv` grids): renders nothing when empty unless `dash`. */
export function NoteText({ note, dash }: { note: string | null | undefined; dash?: boolean }) {
  if (!note?.trim()) return dash ? <span className="muted">-</span> : null;
  return <span style={{ whiteSpace: 'pre-wrap' }} data-testid="doc-note">{note}</span>;
}

/** Note shown on a detail page with an inline editor (AP bill, payroll run). */
export function EditableNote({ note, canEdit, onSave, testId = 'note-edit' }: { note: string; canEdit: boolean; onSave: (v: string) => Promise<void>; testId?: string }) {
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (edit === null) {
    return (
      <span className="row" style={{ alignItems: 'flex-start' }}>
        <NoteText note={note} dash />
        {canEdit && <button type="button" className="btn sm" onClick={() => setEdit(note)} data-testid={testId}>แก้หมายเหตุ</button>}
      </span>
    );
  }
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      <textarea rows={2} maxLength={NOTE_MAX} value={edit} onChange={(e) => setEdit(e.target.value)} aria-label="หมายเหตุ" data-testid={`${testId}-input`} autoFocus />
      <span className="row">
        <button type="button" className="btn sm" onClick={() => setEdit(null)}>ยกเลิก</button>
        <button type="button" className="btn sm pri" disabled={busy} data-testid={`${testId}-save`}
          onClick={async () => { setBusy(true); try { await onSave(edit); setEdit(null); } finally { setBusy(false); } }}>บันทึกหมายเหตุ</button>
      </span>
    </span>
  );
}
