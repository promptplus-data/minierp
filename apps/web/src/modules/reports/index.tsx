/**
 * "reports" web module (group E): M11 home dashboard ("/") and reports, M12 export to PEAK / FlowAccount / Express.
 * The home route is registered before the app's redirect-to-first-menu fallback (main.tsx), so "/" shows the dashboard.
 */
import { lazy } from 'react';
import type { WebModule } from '../types';

const Home = lazy(() => import('./Home'));
const Reports = lazy(() => import('./Reports'));
const Export = lazy(() => import('./Export'));

export const reportsModule: WebModule = {
  nav: [
    { path: '/', label: 'ภาพรวมร้าน', code: 'M11', section: 'ov', icon: 'dash', order: 10 },
    { path: '/reports', label: 'รายงาน', code: 'M11', section: 'data', icon: 'reports', perm: 'rep.view', order: 60 },
    { path: '/export', label: 'ส่งออกให้นักบัญชี', code: 'M12', section: 'data', icon: 'export', perm: 'data.export', order: 70 },
  ],
  routes: [
    { path: '/', element: <Home /> },
    { path: '/reports', element: <Reports /> },
    { path: '/export', element: <Export /> },
  ],
};
