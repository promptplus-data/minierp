/**
 * "admin" web module (Agent D): M17 HR / payroll / leave ('hr'), M02 terms + M19 system screens ('sys'),
 * the SCG Admin console (M14, cloud only, its own sign-in at /scg) and the restore wizard (on-prem, /restore).
 * Wrap: terms gate (BR-15) and the on-prem license banner (REQ-M19-11).
 */
import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';
import { IS_CLOUD } from '../../cloud';
import type { WebModule } from '../types';
import AdminWrap from './Gate';

const HrPage = lazy(() => import('./HrPage'));
const Leave = lazy(() => import('./Leave'));
const Payslips = lazy(() => import('./Payslips'));
const Terms = lazy(() => import('./Terms'));
const TermsSigned = lazy(() => import('./Terms').then((m) => ({ default: m.TermsSigned })));
const System = lazy(() => import('./System'));
const Restore = lazy(() => import('./Restore'));
// Static VITE_EDITION test: the on-prem build drops the console and its chunks entirely.
const ScgApp = import.meta.env.VITE_EDITION === 'cloud' ? lazy(() => import('./scg/ScgApp')) : null;

const CAL = '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 3v3M16 3v3M8 14h3"/>';
const DOC = '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 14l2 2 4-4"/>';
const SRV = '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6"/>';

const publicRoutes: RouteObject[] = [];
if (ScgApp) publicRoutes.push({ path: '/scg/*', element: <ScgApp /> });
if (!IS_CLOUD) publicRoutes.push({ path: '/restore', element: <Restore /> });

export const adminModule: WebModule = {
  nav: [
    { path: '/hr', label: 'พนักงานและเงินเดือน', code: 'M17', section: 'hr', icon: 'settings', perm: ['hr.manage', 'hr.salary'], order: 10 },
    { path: '/leave', label: 'วันลา', code: 'M17', section: 'hr', icon: CAL, order: 20 },
    { path: '/system', label: 'ระบบและข้อมูลร้าน', code: 'M19', section: 'sys', icon: SRV, perm: 'sys.settings', edition: 'onprem', order: 70 },
    { path: '/terms', label: 'สัญญาและการยินยอม', code: 'M02', section: 'sys', icon: DOC, perm: 'sys.settings', order: 80 },
  ],
  routes: [
    { path: '/hr', element: <HrPage /> },
    { path: '/leave', element: <Leave /> },
    { path: '/payslip/:period', element: <Payslips /> },
    { path: '/terms', element: <Terms /> },
    { path: '/terms/signed', element: <TermsSigned /> },
    ...(IS_CLOUD ? [] : [{ path: '/system', element: <System /> }]),
  ],
  publicRoutes,
  Wrap: AdminWrap,
};
