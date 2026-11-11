import type { Role } from './perms';

/**
 * BR-16 shop setting: who approves a sale below cost.
 * - owner: only the owner (the default, OWNER_ONLY in perms);
 * - owner_or_manager: the owner or a manager;
 * - none: no approval, the sale is still flagged "ต่ำกว่าทุน" and audit-logged.
 */
export const BELOW_COST_APPROVERS = ['owner', 'owner_or_manager', 'none'] as const;
export type BelowCostApprover = (typeof BELOW_COST_APPROVERS)[number];
export const DEFAULT_BELOW_COST_APPROVER: BelowCostApprover = 'owner';

export const BELOW_COST_APPROVER_TH: Record<BelowCostApprover, string> = {
  owner: 'เจ้าของร้านเท่านั้น',
  owner_or_manager: 'เจ้าของร้านหรือผู้จัดการ',
  none: 'ไม่ต้องอนุมัติ (แจ้งเตือนและบันทึกประวัติ)',
};

/** Roles whose PIN approves a below-cost sale under the setting. Empty for 'none'. */
export function belowCostApproverRoles(mode: BelowCostApprover): Role[] {
  return mode === 'none' ? [] : mode === 'owner_or_manager' ? ['owner', 'manager'] : ['owner'];
}

/**
 * How a below-cost sale by `role` goes through: 'none' = no approval at all, 'self' = the user is an approver and
 * confirms it himself (logged), 'pin' = another approver's PIN is needed.
 */
export function belowCostDecision(mode: BelowCostApprover, role: Role): 'none' | 'self' | 'pin' {
  if (mode === 'none') return 'none';
  return belowCostApproverRoles(mode).includes(role) ? 'self' : 'pin';
}

/** Parses a stored value; anything unknown falls back to the owner-only default. */
export const asBelowCostApprover = (v: unknown): BelowCostApprover =>
  (BELOW_COST_APPROVERS as readonly unknown[]).includes(v) ? (v as BelowCostApprover) : DEFAULT_BELOW_COST_APPROVER;
