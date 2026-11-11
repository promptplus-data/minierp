-- Round 4 (ข้อ 7): member coupon on POS bills and sales orders. Cloud edition only (OQ-A2); on-prem never writes
-- these columns. The value is always recomputed by the server from the coupon provider (never the client amount).
--   customers.scgf_member_id   member id of the coupon app linked to the customer (nullable)
--   docs / sales_orders.coupon  {code,title,memberId,reservationId,redemptionId,status} of the one coupon on the doc
--   docs / sales_orders.coupon_amount  coupon value applied (DocTotals.coupon), kept apart from shop discounts
ALTER TABLE customers    ADD COLUMN IF NOT EXISTS scgf_member_id text;
ALTER TABLE docs         ADD COLUMN IF NOT EXISTS coupon jsonb;
ALTER TABLE docs         ADD COLUMN IF NOT EXISTS coupon_amount numeric(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS coupon jsonb;
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS coupon_amount numeric(14, 2) NOT NULL DEFAULT 0;
