/**
 * Menu switches for one shop (packages/contracts/src/features.ts): packages, a switch per group, a box per menu.
 * Used live for cloud shops (Shops) and baked into on-prem license keys (Licenses).
 */
import { FEATURES, FEATURE_GROUPS, FEATURE_KEYS, FEATURE_PACKAGES, type FeatureGroup, type FeatureKey } from '@erp/contracts';

const GROUPS = Object.keys(FEATURE_GROUPS) as FeatureGroup[];

export const featureSummary = (features: readonly FeatureKey[] | null) =>
  features === null || features.length === FEATURE_KEYS.length ? 'ทุกเมนู' : `${features.length}/${FEATURE_KEYS.length} เมนู`;

export function FeaturePicker({ value, onChange }: { value: readonly FeatureKey[]; onChange: (v: FeatureKey[]) => void }) {
  const on = new Set(value);
  const set = (keys: readonly FeatureKey[], enable: boolean) => {
    const next = new Set(on);
    for (const k of keys) (enable ? next.add(k) : next.delete(k));
    onChange(FEATURE_KEYS.filter((k) => next.has(k)));
  };
  return (
    <div className="feat" data-testid="feature-picker">
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="small muted">แพ็กเกจ</span>
        {FEATURE_PACKAGES.map((p) => (
          <button key={p.id} type="button" className="btn sm" onClick={() => onChange([...p.features])} data-testid={`feat-pkg-${p.id}`}>{p.label}</button>
        ))}
        <span className="sp" />
        <span className="small"><b>{value.length}</b> / {FEATURE_KEYS.length} เมนู</span>
      </div>
      <div className="feat-groups">
        {GROUPS.map((g) => {
          const items = FEATURES.filter((f) => f.group === g);
          const n = items.filter((f) => on.has(f.key)).length;
          return (
            <fieldset key={g} className="feat-group">
              <legend>
                <label className="chk">
                  <input type="checkbox" checked={n === items.length} ref={(el) => { if (el) el.indeterminate = n > 0 && n < items.length; }}
                    onChange={(e) => set(items.map((f) => f.key), e.target.checked)} data-testid={`feat-group-${g}`} />
                  <b>{FEATURE_GROUPS[g]}</b> <span className="small muted">{n}/{items.length}</span>
                </label>
              </legend>
              {items.map((f) => (
                <label key={f.key} className="chk feat-item">
                  <input type="checkbox" checked={on.has(f.key)} onChange={(e) => set([f.key], e.target.checked)} data-testid={`feat-${f.key}`} />
                  <span>{f.label}</span><span className="mono small muted">{f.code}</span>
                </label>
              ))}
            </fieldset>
          );
        })}
      </div>
      <p className="small muted" style={{ margin: '6px 0 0' }}>
        เปิดเสมอ: ภาพรวมร้าน สัญญาและการยินยอม ประวัติการทำรายการ และการจัดการพนักงานและผู้ใช้ · ปิดเมนูแล้วข้อมูลเดิมยังอยู่ครบ เปิดกลับได้
      </p>
    </div>
  );
}
