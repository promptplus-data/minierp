-- Finance extras:
--  * sales deposits for any customer (not only projects): มัดจำ (guarantee, no VAT until used) and รับเงินล่วงหน้า
--    (advance, tax invoice when received). A deposit may point at a sales order; invoices use it through
--    sales_deposit_applications (counted while the invoice is active). An advance is returned with a credit note.
--  * ขอลดหนี้ขาย: a credit-note request on an invoice (price reduction, no goods back), approved by a manager / owner.
--  * มัดจำซื้อ: money paid to a vendor in advance (optional PO), used later in a payment voucher.
--  * รับวางบิลซื้อ: a vendor billing note groups open AP bills with the agreed payment date.
--  * ปรับปรุงต้นทุน: a cost adjustment of the remaining lots, approved; the owner switches the feature on or off.

ALTER TABLE sales_deposits ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE sales_deposits ADD COLUMN IF NOT EXISTS so_id uuid REFERENCES sales_orders(id);
ALTER TABLE sales_deposits ADD COLUMN IF NOT EXISTS refund_doc_id uuid REFERENCES docs(id);
CREATE INDEX IF NOT EXISTS sales_deposits_customer ON sales_deposits (tenant_id, customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sales_deposits_created ON sales_deposits (tenant_id, created_at DESC, id);

CREATE TABLE sales_deposit_applications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  deposit_id     uuid NOT NULL REFERENCES sales_deposits(id),
  invoice_doc_id uuid NOT NULL REFERENCES docs(id),
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_deposit_applications_deposit ON sales_deposit_applications (tenant_id, deposit_id);
CREATE INDEX sales_deposit_applications_invoice ON sales_deposit_applications (tenant_id, invoice_doc_id);
SELECT erp_secure_table('sales_deposit_applications', true);

CREATE TABLE ar_cn_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  no              text NOT NULL,
  date            date NOT NULL,
  invoice_doc_id  uuid NOT NULL REFERENCES docs(id),
  customer_id     uuid REFERENCES customers(id),
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),   -- including VAT
  reason          text NOT NULL,
  note            text NOT NULL DEFAULT '',
  -- what is not taken off the invoice balance goes back this way
  refund_method   text NOT NULL DEFAULT 'transfer' CHECK (refund_method IN ('cash','transfer','credit')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by    uuid NOT NULL REFERENCES users(id),
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  decide_note     text NOT NULL DEFAULT '',
  cn_doc_id       uuid REFERENCES docs(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, no)
);
CREATE INDEX ar_cn_requests_created ON ar_cn_requests (tenant_id, created_at DESC, id);
SELECT erp_secure_table('ar_cn_requests', true);

CREATE TABLE ap_deposits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  no          text NOT NULL,
  date        date NOT NULL,
  vendor_id   uuid NOT NULL REFERENCES vendors(id),
  po_id       uuid REFERENCES purchase_orders(id),
  method      text NOT NULL CHECK (method IN ('transfer','cheque','cash')),
  ref         text,
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  -- refunded: the part not used yet came back from the vendor
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','refunded','void')),
  closed_amount numeric(14,2) NOT NULL DEFAULT 0,
  closed_note text,
  closed_by   uuid REFERENCES users(id),
  closed_at   timestamptz,
  note        text NOT NULL DEFAULT '',
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, no)
);
CREATE INDEX ap_deposits_created ON ap_deposits (tenant_id, created_at DESC, id);
SELECT erp_secure_table('ap_deposits', true);

CREATE TABLE ap_deposit_allocs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  deposit_id  uuid NOT NULL REFERENCES ap_deposits(id),
  payment_id  uuid NOT NULL REFERENCES ap_payments(id),
  amount      numeric(14,2) NOT NULL CHECK (amount > 0)
);
CREATE INDEX ap_deposit_allocs_deposit ON ap_deposit_allocs (tenant_id, deposit_id);
CREATE INDEX ap_deposit_allocs_payment ON ap_deposit_allocs (tenant_id, payment_id);
SELECT erp_secure_table('ap_deposit_allocs', true);
ALTER TABLE ap_payments ADD COLUMN IF NOT EXISTS deposit_used numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE ap_payments ADD COLUMN IF NOT EXISTS billing_note_id uuid;

CREATE TABLE ap_billing_notes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  no             text NOT NULL,
  date           date NOT NULL,               -- the day the vendor's billing note was received
  vendor_id      uuid NOT NULL REFERENCES vendors(id),
  vendor_doc_no  text NOT NULL DEFAULT '',
  due_date       date NOT NULL,               -- agreed payment date
  total          numeric(14,2) NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  note           text NOT NULL DEFAULT '',
  void_reason    text,
  void_by        uuid REFERENCES users(id),
  void_at        timestamptz,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, no)
);
CREATE INDEX ap_billing_notes_created ON ap_billing_notes (tenant_id, created_at DESC, id);
SELECT erp_secure_table('ap_billing_notes', true);
ALTER TABLE ap_payments ADD CONSTRAINT ap_payments_billing_note FOREIGN KEY (billing_note_id) REFERENCES ap_billing_notes(id);

CREATE TABLE ap_billing_note_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  bn_id       uuid NOT NULL REFERENCES ap_billing_notes(id),
  bill_id     uuid NOT NULL REFERENCES ap_bills(id),
  amount      numeric(14,2) NOT NULL          -- balance of the bill when it was billed
);
CREATE INDEX ap_billing_note_lines_bn ON ap_billing_note_lines (tenant_id, bn_id);
CREATE INDEX ap_billing_note_lines_bill ON ap_billing_note_lines (tenant_id, bill_id);
SELECT erp_secure_table('ap_billing_note_lines', true);

ALTER TABLE purchasing_settings ADD COLUMN IF NOT EXISTS cost_adjust_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE cost_adjustments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  no            text NOT NULL,
  date          date NOT NULL,
  -- [{productId, warehouseId|null, qty, oldCost, newCost}] ; qty / oldCost are the remaining stock when requested
  lines         jsonb NOT NULL,
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  value_change  numeric(14,2),
  requested_by  uuid NOT NULL REFERENCES users(id),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  decide_note   text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, no)
);
CREATE INDEX cost_adjustments_created ON cost_adjustments (tenant_id, created_at DESC, id);
SELECT erp_secure_table('cost_adjustments', true);
