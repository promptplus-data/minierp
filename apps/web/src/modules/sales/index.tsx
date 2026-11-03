/**
 * "sales" web module (Agent A): M08 ขายส่ง / เงินเชื่อ (quotation → sales order → delivery order → tax invoice),
 * M09 ขายโครงการ (projects, installments, deposits, variation orders), M10 ลูกหนี้ / รับชำระ (aging, billing notes, receipts + WHT).
 */
import { lazy } from 'react';
import type { WebModule } from '../types';

const B2b = lazy(() => import('./B2b'));
const QuoteDetail = lazy(() => import('./Details').then((m) => ({ default: m.QuoteDetail })));
const OrderDetail = lazy(() => import('./Details').then((m) => ({ default: m.OrderDetail })));
const DeliveryDetail = lazy(() => import('./Details').then((m) => ({ default: m.DeliveryDetail })));
const InvoiceDetail = lazy(() => import('./Details').then((m) => ({ default: m.InvoiceDetail })));
const Projects = lazy(() => import('./Projects'));
const ProjectDetail = lazy(() => import('./Projects').then((m) => ({ default: m.ProjectDetail })));
const Ar = lazy(() => import('./Ar'));
const BillingNoteDetail = lazy(() => import('./Ar').then((m) => ({ default: m.BillingNoteDetail })));
const ReceiptDetail = lazy(() => import('./Ar').then((m) => ({ default: m.ReceiptDetail })));

export const salesModule: WebModule = {
  nav: [
    { path: '/b2b', label: 'ขายส่ง / เงินเชื่อ', code: 'M08', section: 'sale', icon: 'sales', perm: ['sales.doc', 'inv.receive', 'fin.ar'], order: 22 },
    { path: '/projects', label: 'ขายโครงการ', code: 'M09', section: 'sale', icon: 'project', perm: ['sales.project', 'fin.ar'], order: 24 },
    { path: '/ar', label: 'ลูกหนี้ / รับชำระ', code: 'M10', section: 'sale', icon: 'ar', perm: 'fin.ar', order: 26 },
  ],
  routes: [
    { path: '/b2b', element: <B2b /> },
    { path: '/b2b/qt/:no', element: <QuoteDetail /> },
    { path: '/b2b/so/:no', element: <OrderDetail /> },
    { path: '/b2b/do/:no', element: <DeliveryDetail /> },
    { path: '/b2b/inv/:no', element: <InvoiceDetail /> },
    { path: '/projects', element: <Projects /> },
    { path: '/projects/:id', element: <ProjectDetail /> },
    { path: '/ar', element: <Ar /> },
    { path: '/ar/bn/:no', element: <BillingNoteDetail /> },
    { path: '/ar/rc/:no', element: <ReceiptDetail /> },
  ],
};
