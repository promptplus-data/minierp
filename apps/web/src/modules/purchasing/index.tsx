/**
 * "purchasing" web module: Agent B — M18 AP, M04 Import Hub, stock count/ledger/reorder, M05 GR. Usual sections: 'inv', 'data'.
 * Put screens in this folder (modules/purchasing/*.tsx) and list them here. Contract: ../types.ts.
 * Example:
 *   const ArList = lazy(() => import('./ArList'));
 *   nav:    [{ path: '/ar', label: 'ลูกหนี้ / รับชำระ', code: 'M10', section: 'sale', icon: 'ar', perm: 'fin.ar' }]
 *   routes: [{ path: '/ar', element: <ArList /> }, { path: '/ar/:no', element: <ArDetail /> }]
 */
import type { WebModule } from '../types';

export const purchasingModule: WebModule = {
  nav: [],
  routes: [],
};
