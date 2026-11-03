/**
 * "purchasing" web module (group B): M05 receiving + delivery-file drafts (M19-08), M18 payables, M06 stock count,
 * stock ledger / reorder, M04 Import Hub. Screens live in this folder; contract: ../types.ts.
 */
import { lazy } from 'react';
import type { WebModule } from '../types';

const Receiving = lazy(() => import('./Receiving'));
const Ap = lazy(() => import('./Ap'));
const Count = lazy(() => import('./Count'));
const Ledger = lazy(() => import('./Ledger'));
const Import = lazy(() => import('./Import'));

export const purchasingModule: WebModule = {
  nav: [
    { path: '/purchasing', label: 'ซื้อเข้า / รับของ', code: 'M05', section: 'inv', icon: 'gr', perm: 'inv.receive', order: 10 },
    { path: '/stock-ledger', label: 'สมุดคุมสต็อก', code: 'M06', section: 'inv', icon: 'reports', perm: 'inv.view', order: 25 },
    { path: '/stock-count', label: 'นับสต็อก', code: 'M06', section: 'inv', icon: 'count', perm: ['inv.count', 'inv.adjApprove'], order: 30 },
    { path: '/ap', label: 'เจ้าหนี้ / จ่ายเงิน', code: 'M18', section: 'inv', icon: 'ar', perm: 'fin.ap', order: 40 },
    { path: '/import', label: 'นำเข้าข้อมูล', code: 'M04', section: 'data', icon: 'import', perm: ['data.import', 'fin.ap'], show: (can) => can('data.import') === 1 || can('fin.ap') === 1, order: 30 },
  ],
  routes: [
    { path: '/purchasing', element: <Receiving /> },
    { path: '/stock-ledger', element: <Ledger /> },
    { path: '/stock-count', element: <Count /> },
    { path: '/ap', element: <Ap /> },
    { path: '/import', element: <Import /> },
  ],
};
