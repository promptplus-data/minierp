/**
 * "reports" web module: Agent E — M11 reports, M12 accounting export. Usual sections: 'ov', 'data'.
 * Put screens in this folder (modules/reports/*.tsx) and list them here. Contract: ../types.ts.
 * Example:
 *   const ArList = lazy(() => import('./ArList'));
 *   nav:    [{ path: '/ar', label: 'ลูกหนี้ / รับชำระ', code: 'M10', section: 'sale', icon: 'ar', perm: 'fin.ar' }]
 *   routes: [{ path: '/ar', element: <ArList /> }, { path: '/ar/:no', element: <ArDetail /> }]
 */
import type { WebModule } from '../types';

export const reportsModule: WebModule = {
  nav: [],
  routes: [],
};
