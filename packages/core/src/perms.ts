/**
 * Role permissions, ported from the mockup `roles` seed plus its later additions
 * (`RP` overrides and `sales.belowCost: 'apv'` for manager/cashier/sales).
 * Values: 0 = no, 1 = yes, 'ro' = read only, 'apv' = allowed with approver PIN, number = cap (pos.discCap %).
 */
export type PermValue = 0 | 1 | 'ro' | 'apv' | number;
export type Role = 'owner' | 'manager' | 'cashier' | 'sales' | 'wh' | 'driver' | 'acct' | 'extacct';

export const PERM_KEYS = [
  'pos.sell', 'pos.delLine', 'pos.void', 'pos.discCap', 'pos.price', 'sales.belowCost',
  'sales.doc', 'sales.project', 'sales.creditApv', 'sales.return', 'sales.voidDoc',
  'inv.receive', 'inv.view', 'inv.adj', 'inv.adjApprove', 'inv.count', 'inv.seeSys', 'inv.produce',
  'fin.ar', 'fin.shift', 'fin.ap',
  'data.cost', 'data.master', 'data.import', 'data.export', 'rep.view', 'promo.manage',
  'hr.manage', 'hr.salary', 'hr.leave',
  'sys.users', 'sys.settings', 'sys.log',
] as const;
export type PermKey = (typeof PERM_KEYS)[number];

type Grants = Partial<Record<PermKey, PermValue>>;

/** Owner is '*' (everything) and is not listed here. Missing keys mean 0. */
export const ROLE_PERMS: Readonly<Record<Exclude<Role, 'owner'>, Readonly<Grants>>> = {
  manager: {
    'pos.sell': 1, 'pos.delLine': 1, 'pos.void': 1, 'pos.discCap': 20, 'pos.price': 1, 'sales.belowCost': 'apv',
    'sales.doc': 1, 'sales.project': 1, 'sales.creditApv': 1, 'sales.return': 1, 'sales.voidDoc': 1,
    'inv.receive': 1, 'inv.view': 1, 'inv.adj': 1, 'inv.adjApprove': 1, 'inv.count': 1, 'inv.seeSys': 1, 'inv.produce': 1,
    'fin.ar': 1, 'fin.shift': 1, 'fin.ap': 1,
    'data.cost': 1, 'data.master': 1, 'data.import': 1, 'data.export': 1, 'rep.view': 1, 'promo.manage': 1,
    'hr.manage': 1, 'hr.salary': 0, 'hr.leave': 1,
    'sys.users': 'ro', 'sys.settings': 0, 'sys.log': 1,
  },
  cashier: {
    'pos.sell': 1, 'pos.delLine': 'apv', 'pos.void': 'apv', 'pos.discCap': 0, 'pos.price': 0, 'sales.belowCost': 'apv',
    'sales.doc': 0, 'sales.project': 0, 'sales.creditApv': 0, 'sales.return': 'apv', 'sales.voidDoc': 'apv',
    'inv.receive': 0, 'inv.view': 'ro', 'inv.adj': 0, 'inv.adjApprove': 0, 'inv.count': 0, 'inv.seeSys': 0,
    'fin.ar': 0, 'fin.shift': 1,
    'data.cost': 0, 'data.master': 0, 'data.import': 0, 'data.export': 0, 'rep.view': 0, 'promo.manage': 'ro',
    'sys.users': 0, 'sys.settings': 0,
  },
  sales: {
    'pos.sell': 1, 'pos.delLine': 1, 'pos.void': 'apv', 'pos.discCap': 10, 'pos.price': 'apv', 'sales.belowCost': 'apv',
    'sales.doc': 1, 'sales.project': 1, 'sales.creditApv': 'apv', 'sales.return': 'apv', 'sales.voidDoc': 'apv',
    'inv.receive': 0, 'inv.view': 'ro', 'inv.adj': 0, 'inv.adjApprove': 0, 'inv.count': 0, 'inv.seeSys': 0,
    'fin.ar': 'ro', 'fin.shift': 0,
    'data.cost': 0, 'data.master': 0, 'data.import': 0, 'data.export': 0, 'rep.view': 'ro', 'promo.manage': 'ro',
    'sys.users': 0, 'sys.settings': 0,
  },
  wh: {
    'pos.sell': 0, 'pos.delLine': 0, 'pos.void': 0, 'pos.discCap': 0, 'pos.price': 0,
    'sales.doc': 'ro', 'sales.project': 0, 'sales.creditApv': 0, 'sales.return': 0,
    'inv.receive': 1, 'inv.view': 1, 'inv.adj': 1, 'inv.adjApprove': 0, 'inv.count': 1, 'inv.seeSys': 0, 'inv.produce': 1,
    'fin.ar': 0, 'fin.shift': 0,
    'data.cost': 0, 'data.master': 0, 'data.import': 0, 'data.export': 0, 'rep.view': 0,
    'sys.users': 0, 'sys.settings': 0,
  },
  driver: {
    'pos.sell': 0, 'pos.delLine': 0, 'pos.void': 0, 'pos.discCap': 0, 'pos.price': 0,
    'sales.doc': 'ro', 'sales.project': 0, 'sales.creditApv': 0, 'sales.return': 0,
    'inv.receive': 0, 'inv.view': 0, 'inv.adj': 0, 'inv.adjApprove': 0, 'inv.count': 0, 'inv.seeSys': 0,
    'fin.ar': 0, 'fin.shift': 0,
    'data.cost': 0, 'data.master': 0, 'data.import': 0, 'data.export': 0, 'rep.view': 0,
    'sys.users': 0, 'sys.settings': 0,
  },
  acct: {
    'pos.sell': 0, 'pos.delLine': 0, 'pos.void': 0, 'pos.discCap': 0, 'pos.price': 0,
    'sales.doc': 'ro', 'sales.project': 'ro', 'sales.creditApv': 0, 'sales.return': 0,
    'inv.receive': 0, 'inv.view': 'ro', 'inv.adj': 0, 'inv.adjApprove': 0, 'inv.count': 0, 'inv.seeSys': 0,
    'fin.ar': 1, 'fin.shift': 1, 'fin.ap': 1,
    'data.cost': 1, 'data.master': 'ro', 'data.import': 0, 'data.export': 1, 'rep.view': 1,
    'sys.users': 0, 'sys.settings': 0, 'sys.log': 'ro',
  },
  extacct: {
    'pos.sell': 0, 'pos.delLine': 0, 'pos.void': 0, 'pos.discCap': 0, 'pos.price': 0,
    'sales.doc': 'ro', 'sales.project': 0, 'sales.creditApv': 0, 'sales.return': 0,
    'inv.receive': 0, 'inv.view': 'ro', 'inv.adj': 0, 'inv.adjApprove': 0, 'inv.count': 0, 'inv.seeSys': 0,
    'fin.ar': 'ro', 'fin.shift': 0, 'fin.ap': 'ro',
    'data.cost': 1, 'data.master': 0, 'data.import': 0, 'data.export': 1, 'rep.view': 1,
    'sys.users': 0, 'sys.settings': 0, 'sys.log': 'ro',
  },
};

/** Actions only the owner may approve; a manager PIN is not enough. */
export const OWNER_ONLY: ReadonlySet<PermKey> = new Set<PermKey>(['sales.belowCost']);

/** Permission value for a role. Owner: everything, discount cap 100. Unknown key/role: 0. */
export function perm(role: Role, key: PermKey): PermValue {
  if (role === 'owner') return key === 'pos.discCap' ? 100 : 1;
  return ROLE_PERMS[role]?.[key] ?? 0;
}

/** Roles whose PIN can approve an 'apv' action. */
export const approverRoles = (key: PermKey): Role[] => (OWNER_ONLY.has(key) ? ['owner'] : ['owner', 'manager']);
