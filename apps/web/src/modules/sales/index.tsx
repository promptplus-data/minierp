/**
 * "sales" web module: Agent A — M08 quotation/SO/DO/invoice, M10 AR, M09 projects. Usual section: 'sale'.
 * Put screens in this folder (modules/sales/*.tsx) and list them here. Contract: ../types.ts.
 * Example:
 *   const ArList = lazy(() => import('./ArList'));
 *   nav:    [{ path: '/ar', label: 'ลูกหนี้ / รับชำระ', code: 'M10', section: 'sale', icon: 'ar', perm: 'fin.ar' }]
 *   routes: [{ path: '/ar', element: <ArList /> }, { path: '/ar/:no', element: <ArDetail /> }]
 */
import type { WebModule } from '../types';

export const salesModule: WebModule = {
  nav: [],
  routes: [],
};
