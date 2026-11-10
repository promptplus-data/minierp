-- Group A "sales" round 2: customer address book (ship-to picker), notes on every B2B document, BR-05 price source
-- per line, price-change / discount approval (manager PIN) and below-cost approval on quotations.

-- ---------- customer address book (ship-to picker on SO / DO) ----------
-- Saved from the picker ("+ บันทึกที่อยู่ใหม่"). Never deleted: retired with active = false.
CREATE TABLE IF NOT EXISTS customer_addresses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  label       text NOT NULL DEFAULT '',
  address     text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (length(trim(address)) > 0)
);
CREATE INDEX IF NOT EXISTS customer_addresses_customer ON customer_addresses (tenant_id, customer_id, created_at DESC) WHERE active;
CREATE UNIQUE INDEX IF NOT EXISTS customer_addresses_unique ON customer_addresses (tenant_id, customer_id, address) WHERE active;
SELECT erp_secure_table('customer_addresses');

-- ---------- notes (หมายเหตุ) on documents that had none ----------
ALTER TABLE sales_projects ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
ALTER TABLE sales_deposits ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';

-- ---------- BR-05 price source per line (shown on the line, carried QT → SO) ----------
-- list_price: the resolved price in the document's VAT basis when the line was saved; price_source: quote /
-- customerList / groupList / promo / retail / manual (free-text line); price_ref: quotation no / list code / promo code.
ALTER TABLE sales_quote_lines ADD COLUMN IF NOT EXISTS list_price numeric(14,4);
ALTER TABLE sales_quote_lines ADD COLUMN IF NOT EXISTS price_source text;
ALTER TABLE sales_quote_lines ADD COLUMN IF NOT EXISTS price_ref text;
ALTER TABLE sales_order_lines ADD COLUMN IF NOT EXISTS list_price numeric(14,4);
ALTER TABLE sales_order_lines ADD COLUMN IF NOT EXISTS price_source text;
ALTER TABLE sales_order_lines ADD COLUMN IF NOT EXISTS price_ref text;

-- ---------- approvals recorded on the document ----------
-- price_approval: price below the resolved list price and / or discount over the role cap ({by, name, reason, detail, at}).
ALTER TABLE sales_quotes ADD COLUMN IF NOT EXISTS below_cost_approval jsonb;
ALTER TABLE sales_quotes ADD COLUMN IF NOT EXISTS price_approval jsonb;
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS price_approval jsonb;
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS price_approval jsonb;
