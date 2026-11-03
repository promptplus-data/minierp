/** M11 reports: tabs for sales/GP, stock, VAT, internal cost, promotions and (cloud only) SCG Family coupons. */
import { lazy, Suspense, useState } from 'react';
import { IS_CLOUD } from '../../cloud';
import { useAuth } from '../../auth';
import SalesReport from './SalesReport';
import StockReport from './StockReport';
import VatReport from './VatReport';
import { CostReport, PromoReport } from './MoreReports';
import './reports.css';

// SCG Family is cloud only (OQ-A2): the screen is not even part of the on-prem bundle.
const CouponReport = IS_CLOUD ? lazy(() => import('./Coupons')) : null;

type Tab = 'sales' | 'stock' | 'vat' | 'cost' | 'promo' | 'coupon';

export default function Reports() {
  const { can } = useAuth();
  const tabs: [Tab, string][] = [['sales', 'ยอดขายและกำไร'], ['stock', 'สต็อกคงเหลือ'], ['vat', 'ภาษีขาย / ภาษีซื้อ']];
  if (can('data.cost') === 1) tabs.push(['cost', 'ต้นทุนภายในร้าน']);
  tabs.push(['promo', 'โปรโมชั่น']);
  if (CouponReport) tabs.push(['coupon', 'คูปอง SCG Family']);
  const [tab, setTab] = useState<Tab>('sales');
  return (
    <div className="card">
      <div className="tabs rp-tabs" role="tablist" aria-label="รายงาน">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)} data-testid={`tab-${k}`}>{l}</button>)}
      </div>
      {tab === 'sales' && <SalesReport />}
      {tab === 'stock' && <StockReport />}
      {tab === 'vat' && <VatReport />}
      {tab === 'cost' && <CostReport />}
      {tab === 'promo' && <PromoReport />}
      {tab === 'coupon' && CouponReport && <Suspense fallback={<div className="sk" />}><CouponReport /></Suspense>}
    </div>
  );
}
