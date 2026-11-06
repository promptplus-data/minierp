/**
 * "retail" web module (Agent C): M15 promotions, M16 production, customer price lists, product photos and POS machines.
 * The POS-side pieces (promo prices, bundles, held bills, POS ID) live in ./pos.tsx and are used by pos/Pos.tsx.
 */
import { lazy } from 'react';
import type { WebModule } from '../types';

const Promos = lazy(() => import('./Promos'));
const Production = lazy(() => import('./Production'));
const PriceLists = lazy(() => import('./PriceLists'));
const ProductImages = lazy(() => import('./ProductImages'));
const PosDevices = lazy(() => import('./PosDevices'));

const PROMO_ICON = '<path d="M3 12V4.5A1.5 1.5 0 0 1 4.5 3H12l9 9-9 9z"/><circle cx="8" cy="8" r="1.6"/>';
const PROD_ICON = '<path d="M3 21V10l5 3V10l5 3V10l5 3V4h3v17z"/><path d="M7 17h2M12 17h2M17 17h1"/>';
const PRICE_ICON = '<path d="M4 6h16M4 12h16M4 18h10"/><circle cx="18" cy="18" r="2.5"/>';
const IMG_ICON = '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>';
const DEV_ICON = '<rect x="4" y="3" width="16" height="12" rx="2"/><path d="M8 21h8M12 15v6"/>';

export const retailModule: WebModule = {
  nav: [
    { path: '/promos', label: 'โปรโมชั่นของร้าน', code: 'M15', section: 'sale', icon: PROMO_ICON, perm: 'promo.manage', order: 40 },
    { path: '/production', label: 'การผลิต', code: 'M16', section: 'inv', icon: PROD_ICON, perm: 'inv.produce', order: 60 },
    { path: '/price-lists', label: 'ราคาตามลูกค้า', code: 'M03', section: 'data', icon: PRICE_ICON, perm: 'data.master', order: 30 },
    { path: '/product-images', label: 'รูปสินค้าในหน้าขาย', code: 'M07', section: 'data', icon: IMG_ICON, perm: 'data.master', order: 40 },
    { path: '/pos-devices', label: 'เครื่อง POS และ ภ.พ.06', code: 'M01', section: 'sys', icon: DEV_ICON, perm: 'sys.settings', order: 40 },
  ],
  routes: [
    { path: '/promos', element: <Promos /> },
    { path: '/production', element: <Production /> },
    { path: '/production/:no', element: <Production /> },
    { path: '/price-lists', element: <PriceLists /> },
    { path: '/product-images', element: <ProductImages /> },
    { path: '/pos-devices', element: <PosDevices /> },
  ],
};
