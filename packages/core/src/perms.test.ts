import { describe, expect, it } from 'vitest';
import { OWNER_ONLY, PERM_KEYS, ROLE_PERMS, approverRoles, perm } from './perms';

describe('perms', () => {
  it('owner has everything, discount cap 100', () => {
    for (const k of PERM_KEYS) expect(perm('owner', k)).toBe(k === 'pos.discCap' ? 100 : 1);
  });
  it('mockup seed values', () => {
    expect(perm('manager', 'pos.discCap')).toBe(20);
    expect(perm('sales', 'pos.discCap')).toBe(10);
    expect(perm('cashier', 'pos.delLine')).toBe('apv');
    expect(perm('manager', 'sys.users')).toBe('ro');
    expect(perm('manager', 'hr.salary')).toBe(0);
    expect(perm('extacct', 'data.export')).toBe(1);
    expect(perm('driver', 'pos.sell')).toBe(0);
    expect(perm('wh', 'inv.produce')).toBe(1);
  });
  it('below cost is owner-only approval', () => {
    expect(OWNER_ONLY.has('sales.belowCost')).toBe(true);
    expect(perm('manager', 'sales.belowCost')).toBe('apv');
    expect(perm('wh', 'sales.belowCost')).toBe(0);
    expect(approverRoles('sales.belowCost')).toEqual(['owner']);
    expect(approverRoles('pos.void')).toEqual(['owner', 'manager']);
  });
  it('every non-owner role has an explicit discount cap', () => {
    for (const r of Object.values(ROLE_PERMS)) expect(typeof r['pos.discCap']).toBe('number');
  });
});
