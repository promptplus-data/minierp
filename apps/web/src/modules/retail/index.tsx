/**
 * "retail" web module: Agent C — M15 promotions, M16 production, held bills, customer price lists. Usual sections: 'sale', 'inv', 'data'.
 * Put screens in this folder (modules/retail/*.tsx) and list them here. Contract: ../types.ts.
 * Example:
 *   const ArList = lazy(() => import('./ArList'));
 *   nav:    [{ path: '/ar', label: 'ลูกหนี้ / รับชำระ', code: 'M10', section: 'sale', icon: 'ar', perm: 'fin.ar' }]
 *   routes: [{ path: '/ar', element: <ArList /> }, { path: '/ar/:no', element: <ArDetail /> }]
 */
import type { WebModule } from '../types';

export const retailModule: WebModule = {
  nav: [],
  routes: [],
};
