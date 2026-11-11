-- Purchase orders (ใบสั่งซื้อ, PO): ordered from a vendor, optionally made from a quotation / sales order
-- (source_type + source_no), received through the normal goods receipt (gr_lines.po_line_id).
-- Received quantities are derived from the active GR lines that point at each PO line, so voiding a GR
-- rolls the PO back without a separate counter. GR void (stock_docs.void_*) is new here too.

CREATE TABLE purchase_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  no            text NOT NULL,
  date          date NOT NULL,
  vendor_id     uuid NOT NULL REFERENCES vendors(id),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  expected_date date,
  vendor_ref    text NOT NULL DEFAULT '',
  note          text NOT NULL DEFAULT '',
  vat_mode      text NOT NULL CHECK (vat_mode IN ('inc','exc','none')),
  gross         numeric(14,2) NOT NULL,
  line_disc     numeric(14,2) NOT NULL,
  base7         numeric(14,2) NOT NULL,
  exempt        numeric(14,2) NOT NULL,
  vat           numeric(14,2) NOT NULL,
  total         numeric(14,2) NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','received','closed','void')),
  source_type   text CHECK (source_type IN ('QT','SO')),
  source_id     uuid,
  source_no     text,
  search_text   text NOT NULL DEFAULT '',
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_by     uuid REFERENCES users(id),
  closed_at     timestamptz,
  close_reason  text,
  void_by       uuid REFERENCES users(id),
  void_at       timestamptz,
  void_reason   text,
  CONSTRAINT purchase_orders_source CHECK ((source_type IS NULL) = (source_no IS NULL))
);
CREATE UNIQUE INDEX purchase_orders_tenant_no ON purchase_orders (tenant_id, no);
CREATE INDEX purchase_orders_tenant_created ON purchase_orders (tenant_id, created_at DESC, id DESC);
CREATE INDEX purchase_orders_source ON purchase_orders (tenant_id, source_no) WHERE source_no IS NOT NULL;
SELECT erp_secure_table('purchase_orders', true);

CREATE TABLE purchase_order_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  po_id          uuid NOT NULL REFERENCES purchase_orders(id),
  line_no        integer NOT NULL,
  product_id     uuid NOT NULL REFERENCES products(id),
  unit_idx       integer NOT NULL,
  unit_name      text NOT NULL,
  unit_factor    numeric(14,4) NOT NULL,
  qty            numeric(14,4) NOT NULL CHECK (qty > 0),        -- in the line unit
  base_qty       numeric(14,4) NOT NULL CHECK (base_qty > 0),
  unit_cost      numeric(14,4) NOT NULL CHECK (unit_cost >= 0), -- per line unit, document VAT basis
  discount       jsonb,
  disc_amt       numeric(14,2) NOT NULL DEFAULT 0,
  net            numeric(14,2) NOT NULL,
  vat            text NOT NULL CHECK (vat IN ('v7','exempt')),
  source_line_id uuid,                                           -- quotation / sales order line it was made from
  source_qty     numeric(14,4)                                   -- that line's ordered qty when the PO was made
);
CREATE INDEX purchase_order_lines_po ON purchase_order_lines (tenant_id, po_id, line_no);
SELECT erp_secure_table('purchase_order_lines', true);

ALTER TABLE gr_lines ADD COLUMN IF NOT EXISTS po_id uuid REFERENCES purchase_orders(id);
ALTER TABLE gr_lines ADD COLUMN IF NOT EXISTS po_line_id uuid REFERENCES purchase_order_lines(id);
CREATE INDEX IF NOT EXISTS gr_lines_po_line ON gr_lines (tenant_id, po_line_id) WHERE po_line_id IS NOT NULL;

-- Goods receipt void (BR-22: flag, never delete). Only GR rows use these columns.
ALTER TABLE stock_docs ADD COLUMN IF NOT EXISTS void_at timestamptz;
ALTER TABLE stock_docs ADD COLUMN IF NOT EXISTS void_by uuid REFERENCES users(id);
ALTER TABLE stock_docs ADD COLUMN IF NOT EXISTS void_reason text;
