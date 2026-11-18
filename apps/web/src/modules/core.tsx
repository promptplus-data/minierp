/** Phase 1 screens (M03, M06, M07, M08, BR-18). Same shape as the module groups. */
import Products from '../pages/Products';
import Stock from '../stock/Stock';
import Pos from '../pos/Pos';
import SalesDocs from '../pages/SalesDocs';
import DocDetail from '../pages/DocDetail';
import Returns from '../pages/Returns';
import Audit from '../pages/Audit';
import Warehouses from '../pages/Warehouses';
import Customers from './sales/Customers';
import type { WebModule } from './types';

export const coreModule: WebModule = {
  nav: [
    { path: '/pos', label: 'ขายหน้าร้าน (POS)', code: 'M07', section: 'sale', icon: 'pos', perm: 'pos.sell', order: 10 },
    { path: '/sales', label: 'เอกสารขาย', code: 'M08', section: 'sale', icon: 'sales', perm: ['sales.doc', 'pos.sell', 'fin.ar'], order: 20 },
    { path: '/returns', label: 'รับคืนสินค้า', code: 'M08', section: 'sale', icon: 'returns', perm: 'sales.return', order: 30 },
    { path: '/stock', label: 'คลังสินค้า', code: 'M06', section: 'inv', icon: 'stock', perm: 'inv.view', order: 20 },
    { path: '/customers', label: 'ข้อมูลลูกค้า', code: 'M03', section: 'data', icon: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a5.5 5.5 0 0 1 3.5 6"/>', perm: ['data.master', 'sales.doc', 'fin.ar'], order: 15 },
    { path: '/products', label: 'สินค้าและหน่วยนับ', code: 'M03', section: 'data', icon: 'master', perm: 'data.master', order: 10 },
    { path: '/warehouses', label: 'คลังและประเภทคลัง', code: 'M06', section: 'data', icon: 'stock', perm: 'sys.settings', order: 20 },
    { path: '/audit', label: 'ประวัติการทำรายการ', code: 'BR-18', section: 'sys', icon: 'log', perm: 'sys.log', order: 90 },
  ],
  routes: [
    { path: '/pos', element: <Pos /> },
    { path: '/sales', element: <SalesDocs /> },
    { path: '/sales/:no', element: <DocDetail /> },
    { path: '/returns', element: <Returns /> },
    { path: '/stock', element: <Stock /> },
    { path: '/products', element: <Products /> },
    { path: '/customers', element: <Customers /> },
    { path: '/audit', element: <Audit /> },
    { path: '/warehouses', element: <Warehouses /> },
  ],
};
