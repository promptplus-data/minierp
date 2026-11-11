-- Free goods (ของแถม), round 2:
--  * purchasing: how a goods receipt costs its free lines. 'zero' (default) keeps them at cost 0; 'allocate' spreads the
--    money actually paid over every line by relative market value. The shop default sits in purchasing_settings and
--    each receipt keeps the mode it was saved with. gr_lines keep the invoice price (unit_price) and the allocated
--    cost per receipt unit (alloc_unit_cost, null in zero mode) plus the market unit price used for a free line.
--  * sales: a POS / quotation / order / delivery / invoice line can be a free line at price 0. It cuts stock and goes to
--    COGS like any line, but is neither a manual discount nor a below-cost sale.

ALTER TABLE purchasing_settings ADD COLUMN IF NOT EXISTS free_goods_costing text NOT NULL DEFAULT 'zero'
  CHECK (free_goods_costing IN ('zero','allocate'));
ALTER TABLE stock_docs ADD COLUMN IF NOT EXISTS free_goods_costing text
  CHECK (free_goods_costing IS NULL OR free_goods_costing IN ('zero','allocate'));
ALTER TABLE gr_lines ADD COLUMN IF NOT EXISTS alloc_unit_cost numeric(14,4);
ALTER TABLE gr_lines ADD COLUMN IF NOT EXISTS market_unit_price numeric(14,4);

ALTER TABLE doc_lines ADD COLUMN IF NOT EXISTS free boolean NOT NULL DEFAULT false;
ALTER TABLE sales_quote_lines ADD COLUMN IF NOT EXISTS free boolean NOT NULL DEFAULT false;
ALTER TABLE sales_order_lines ADD COLUMN IF NOT EXISTS free boolean NOT NULL DEFAULT false;
ALTER TABLE sales_delivery_lines ADD COLUMN IF NOT EXISTS free boolean NOT NULL DEFAULT false;
