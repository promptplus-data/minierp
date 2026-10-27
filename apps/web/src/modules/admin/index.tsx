/**
 * "admin" web module: Agent D — M17 HR/payroll ('hr'), M14 SCG Admin ('adm'), M19 settings ('sys').
 * Put screens in this folder (modules/admin/*.tsx) and list them here. Contract: ../types.ts.
 * Example:
 *   const ArList = lazy(() => import('./ArList'));
 *   nav:    [{ path: '/ar', label: 'ลูกหนี้ / รับชำระ', code: 'M10', section: 'sale', icon: 'ar', perm: 'fin.ar' }]
 *   routes: [{ path: '/ar', element: <ArList /> }, { path: '/ar/:no', element: <ArDetail /> }]
 */
import type { WebModule } from '../types';

export const adminModule: WebModule = {
  nav: [],
  routes: [],
};
