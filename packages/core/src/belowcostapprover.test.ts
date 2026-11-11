import { describe, expect, it } from 'vitest';
import { asBelowCostApprover, belowCostApproverRoles, belowCostDecision } from './belowcostapprover';
import { approverRoles } from './perms';

describe('below-cost approver setting (BR-16)', () => {
  it('owner (default) matches the OWNER_ONLY permission rule', () => {
    expect(belowCostApproverRoles('owner')).toEqual(approverRoles('sales.belowCost'));
    expect(belowCostDecision('owner', 'owner')).toBe('self');
    expect(belowCostDecision('owner', 'manager')).toBe('pin');
    expect(belowCostDecision('owner', 'cashier')).toBe('pin');
  });
  it('owner_or_manager: a manager confirms himself, others need an owner / manager PIN', () => {
    expect(belowCostApproverRoles('owner_or_manager')).toEqual(['owner', 'manager']);
    expect(belowCostDecision('owner_or_manager', 'manager')).toBe('self');
    expect(belowCostDecision('owner_or_manager', 'sales')).toBe('pin');
  });
  it('none: nobody approves', () => {
    expect(belowCostApproverRoles('none')).toEqual([]);
    expect(belowCostDecision('none', 'cashier')).toBe('none');
  });
  it('unknown stored values fall back to owner', () => {
    expect(asBelowCostApprover('none')).toBe('none');
    expect(asBelowCostApprover(null)).toBe('owner');
    expect(asBelowCostApprover('everyone')).toBe('owner');
  });
});
