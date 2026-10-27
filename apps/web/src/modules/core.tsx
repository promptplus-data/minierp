/** Phase 1 screens (M03, M06, M07, M08, BR-18). Same shape as the module groups. */
import Products from '../pages/Products';
import Stock from '../stock/Stock';
import Pos from '../pos/Pos';
import SalesDocs from '../pages/SalesDocs';
import DocDetail from '../pages/DocDetail';
import Returns from '../pages/Returns';
import Audit from '../pages/Audit';
import type { WebModule } from './types';

export const coreModule: WebModule = {
  nav: [
    { path: '/pos', label: 'ขายหน้าร้าน (POS)', code: 'M07', section: 'sale', icon: 'pos', perm: 'pos.sell', order: 10 },
    { path: '/sales', label: 'เอกสารขาย', code: 'M08', section: 'sale', icon: 'sales', perm: ['sales.doc', 'pos.sell', 'fin.ar'], order: 20 },
    { path: '/returns', label: 'รับคืนสินค้า', code: 'M08', section: 'sale', icon: 'returns', perm: 'sales.return', order: 30 },
    { path: '/stock', label: 'คลังสินค้า', code: 'M06', section: 'inv', icon: 'stock', perm: 'inv.view', order: 20 },
    { path: '/products', label: 'สินค้าและหน่วยนับ', code: 'M03', section: 'data', icon: 'master', perm: 'data.master', order: 10 },
    { path: '/audit', label: 'ประวัติการทำรายการ', code: 'BR-18', section: 'sys', icon: 'log', perm: 'sys.log', order: 90 },
  ],
  routes: [
    { path: '/pos', element: <Pos /> },
    { path: '/sales', element: <SalesDocs /> },
    { path: '/sales/:no', element: <DocDetail /> },
    { path: '/returns', element: <Returns /> },
    { path: '/stock', element: <Stock /> },
    { path: '/products', element: <Products /> },
    { path: '/audit', element: <Audit /> },
  ],
};
