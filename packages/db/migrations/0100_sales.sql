-- Group A "sales": M08 quotation / sales order / delivery order / B2B tax invoice, M10 AR (billing notes, receipts,
-- WHT), M09 projects (installments, deposits). Tax invoices and credit notes stay in the core `docs` table
-- (type 'INV' / 'CN') so the returns flow, the sales-tax view and the document list keep working; the
-- B2B-only facts of an invoice live in sales_invoices (1:1 with docs).
-- Every table: tenant_id + erp_secure_table (RLS, grants, no-delete trigger for documents).

-- ---------- shop settings for B2B documents ----------
CREATE TABLE sales_settings (
  tenant_id         uuid PRIMARY KEY REFERENCES tenants(id),
  quote_valid_days  integer NOT NULL DEFAULT 15 CHECK (quote_valid_days BETWEEN 1 AND 365),
  default_credit_limit numeric(14,2) NOT NULL DEFAULT 50000,
  -- [{bank, branch, account, name}] printed on quotations and credit invoices (REQ-M08-08)
  bank_accounts     jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
SELECT erp_secure_table('sales_settings');

-- ---------- price lists (BR-05 steps 2 and 3, REQ-M03 price lists) ----------
-- kind customer: one customer's own prices; kind group: prices for a customer group (customers.grp) with quantity
-- breaks. items = [{productId, unitIdx, minQty, price}], price per unit of unitIdx, VAT-inclusive when vat_included.
CREATE TABLE sales_price_lists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  code         text NOT NULL,
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('customer','group')),
  customer_id  uuid REFERENCES customers(id),
  grp          text,
  vat_included boolean NOT NULL DEFAULT true,
  valid_from   date,
  valid_to     date,
  active       boolean NOT NULL DEFAULT true,
  items        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  search_text  text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, code),
  CHECK ((kind = 'customer') = (customer_id IS NOT NULL)),
  CHECK ((kind = 'group') = (grp IS NOT NULL))
);
CREATE INDEX sales_price_lists_tenant_created ON sales_price_lists (tenant_id, created_at DESC, id);
CREATE INDEX sales_price_lists_customer ON sales_price_lists (tenant_id, customer_id) WHERE active;
CREATE INDEX sales_price_lists_grp ON sales_price_lists (tenant_id, grp) WHERE active;
SELECT erp_secure_table('sales_price_lists');

-- ---------- projects (M09) ----------
CREATE TABLE sales_projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  no          text NOT NULL,
  name        text NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id),
  site        text NOT NULL DEFAULT '',
  contact     text NOT NULL DEFAULT '',
  template    text NOT NULL DEFAULT 'custom',
  main_so_id  uuid,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  void_by     uuid REFERENCES users(id),
  void_at     timestamptz,
  void_reason text,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, no)
);
CREATE INDEX sales_projects_tenant_created ON sales_projects (tenant_id, created_at DESC, id);
SELECT erp_secure_table('sales_projects', true);

-- Billing schedule. Edited by retiring rows (active = false), never by deleting them.
CREATE TABLE sales_project_installments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  project_id  uuid NOT NULL REFERENCES sales_projects(id),
  n           integer NOT NULL,
  label       text NOT NULL DEFAULT '',
  pct         numeric(7,4) NOT NULL CHECK (pct > 0 AND pct <= 100),
  due_date    date NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_project_installments_project ON sales_project_installments (tenant_id, project_id, n);
SELECT erp_secure_table('sales_project_installments', true);

-- ---------- quotations (REQ-M08-01/08/09) ----------
CREATE TABLE sales_quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  no            text NOT NULL,
  date          date NOT NULL,
  valid_until   date NOT NULL,
  customer_id   uuid NOT NULL REFERENCES customers(id),
  attn          text NOT NULL DEFAULT '',
  vat_mode      text NOT NULL CHECK (vat_mode IN ('inc','exc','none')),
  term          jsonb NOT NULL DEFAULT '{"t":"cash"}'::jsonb,
  salesperson_id uuid REFERENCES users(id),
  project_id    uuid REFERENCES sales_projects(id),
  note          text NOT NULL DEFAULT '',
  bill_disc     numeric(14,2) NOT NULL DEFAULT 0,
  gross         numeric(14,2) NOT NULL,
  line_disc     numeric(14,2) NOT NULL,
  base7         numeric(14,2) NOT NULL,
  exempt        numeric(14,2) NOT NULL,
  vat           numeric(14,2) NOT NULL,
  total         numeric(14,2) NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','lost','void')),
  revision      integer NOT NULL DEFAULT 1,
  void_by       uuid REFERENCES users(id),
  void_at       timestamptz,
  void_reason   text,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  search_text   text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, no)
);
CREATE INDEX sales_quotes_tenant_created ON sales_quotes (tenant_id, created_at DESC, id);
CREATE INDEX sales_quotes_customer ON sales_quotes (tenant_id, customer_id, valid_until);
SELECT erp_secure_table('sales_quotes', true);

-- product_id NULL = free-text line ("นอกระบบ", REQ-M08-09): no SKU, no cost, never touches stock.
-- Lines are replaced on edit by retiring the old revision (revision column), never deleted.
CREATE TABLE sales_quote_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  quote_id    uuid NOT NULL REFERENCES sales_quotes(id),
  revision    integer NOT NULL,
  line_no     integer NOT NULL,
  product_id  uuid REFERENCES products(id),
  unit_idx    integer,
  name        text NOT NULL,
  unit_name   text NOT NULL,
  unit_factor numeric(14,4) NOT NULL DEFAULT 1,
  qty         numeric(14,4) NOT NULL CHECK (qty > 0),
  unit_price  numeric(14,4) NOT NULL CHECK (unit_price >= 0),
  discount    jsonb,
  disc_amt    numeric(14,2) NOT NULL DEFAULT 0,
  net         numeric(14,2) NOT NULL,
  vat         text NOT NULL CHECK (vat IN ('v7','exempt')),
  CHECK ((product_id IS NULL) = (unit_idx IS NULL))
);
CREATE INDEX sales_quote_lines_quote ON sales_quote_lines (tenant_id, quote_id, revision, line_no);
SELECT erp_secure_table('sales_quote_lines', true);

-- Snapshot of every saved revision (REQ-M08-01 "เก็บ revision").
CREATE TABLE sales_quote_revisions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  quote_id   uuid NOT NULL REFERENCES sales_quotes(id),
  revision   integer NOT NULL,
  snapshot   jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, quote_id, revision)
);
SELECT erp_secure_table('sales_quote_revisions', true);

-- ---------- sales orders (REQ-M08-02/03/10, BR-08, BR-16, BR-23) ----------
CREATE TABLE sales_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  no            text NOT NULL,
  date          date NOT NULL,
  customer_id   uuid NOT NULL REFERENCES customers(id),
  quote_id      uuid REFERENCES sales_quotes(id),
  project_id    uuid REFERENCES sales_projects(id),
  warehouse_id  uuid REFERENCES warehouses(id),
  vat_mode      text NOT NULL CHECK (vat_mode IN ('inc','exc','none')),
  term          jsonb NOT NULL DEFAULT '{"t":"cash"}'::jsonb,
  salesperson_id uuid REFERENCES users(id),
  ship_to       text NOT NULL DEFAULT '',
  note          text NOT NULL DEFAULT '',
  bill_disc     numeric(14,2) NOT NULL DEFAULT 0,
  gross         numeric(14,2) NOT NULL,
  line_disc     numeric(14,2) NOT NULL,
  base7         numeric(14,2) NOT NULL,
  exempt        numeric(14,2) NOT NULL,
  vat           numeric(14,2) NOT NULL,
  total         numeric(14,2) NOT NULL,
  -- open (รอส่ง) / partial (ส่งบางส่วน) / delivered (ส่งครบ); refreshed by every delivery and delivery void
  dlv_status    text NOT NULL DEFAULT 'open' CHECK (dlv_status IN ('open','partial','delivered')),
  credit_approval jsonb,      -- BR-08 {by, name, balance, limit, overdue, at}
  below_cost_approval jsonb,  -- BR-16
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  void_by       uuid REFERENCES users(id),
  void_at       timestamptz,
  void_reason   text,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  search_text   text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, no)
);
CREATE INDEX sales_orders_tenant_created ON sales_orders (tenant_id, created_at DESC, id);
CREATE INDEX sales_orders_quote ON sales_orders (tenant_id, quote_id);
CREATE INDEX sales_orders_project ON sales_orders (tenant_id, project_id);
SELECT erp_secure_table('sales_orders', true);
ALTER TABLE sales_projects ADD CONSTRAINT sales_projects_main_so FOREIGN KEY (main_so_id) REFERENCES sales_orders(id);

CREATE TABLE sales_order_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  so_id          uuid NOT NULL REFERENCES sales_orders(id),
  line_no        integer NOT NULL,
  product_id     uuid NOT NULL REFERENCES products(id),
  unit_idx       integer NOT NULL,
  name           text NOT NULL,
  unit_name      text NOT NULL,
  unit_factor    numeric(14,4) NOT NULL,
  qty            numeric(14,4) NOT NULL CHECK (qty > 0),
  base_qty       numeric(14,4) NOT NULL,
  unit_price     numeric(14,4) NOT NULL CHECK (unit_price >= 0),
  discount       jsonb,
  disc_amt       numeric(14,2) NOT NULL DEFAULT 0,
  net            numeric(14,2) NOT NULL,
  net_after_bill numeric(14,2) NOT NULL,
  vat            text NOT NULL CHECK (vat IN ('v7','exempt')),
  quote_line_id  uuid REFERENCES sales_quote_lines(id)
);
CREATE INDEX sales_order_lines_so ON sales_order_lines (tenant_id, so_id, line_no);
SELECT erp_secure_table('sales_order_lines', true);

-- ---------- delivery orders (REQ-M08-04/10, M09-02) ----------
-- From a sales order (cuts stock FIFO at the delivery date) or from an invoice whose goods the customer left at
-- the shop (stock was already cut by the invoice; warehouse_id NULL, proof of delivery only).
CREATE TABLE sales_deliveries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  no           text NOT NULL,
  date         date NOT NULL,
  customer_id  uuid REFERENCES customers(id),
  customer_name text NOT NULL,
  so_id        uuid REFERENCES sales_orders(id),
  inv_doc_id   uuid REFERENCES docs(id),
  project_id   uuid REFERENCES sales_projects(id),
  warehouse_id uuid REFERENCES warehouses(id),
  ship_to      text NOT NULL DEFAULT '',
  vehicle      text NOT NULL DEFAULT '',
  note         text NOT NULL DEFAULT '',
  total        numeric(14,2) NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  void_by      uuid REFERENCES users(id),
  void_at      timestamptz,
  void_reason  text,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  search_text  text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, no),
  CHECK ((so_id IS NULL) <> (inv_doc_id IS NULL))
);
CREATE INDEX sales_deliveries_tenant_created ON sales_deliveries (tenant_id, created_at DESC, id);
CREATE INDEX sales_deliveries_so ON sales_deliveries (tenant_id, so_id);
CREATE INDEX sales_deliveries_inv ON sales_deliveries (tenant_id, inv_doc_id);
SELECT erp_secure_table('sales_deliveries', true);

CREATE TABLE sales_delivery_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  delivery_id  uuid NOT NULL REFERENCES sales_deliveries(id),
  line_no      integer NOT NULL,
  so_line_id   uuid REFERENCES sales_order_lines(id),
  inv_line_id  uuid REFERENCES doc_lines(id),
  product_id   uuid NOT NULL REFERENCES products(id),
  name         text NOT NULL,
  unit_name    text NOT NULL,
  unit_factor  numeric(14,4) NOT NULL,
  qty          numeric(14,4) NOT NULL CHECK (qty > 0),
  base_qty     numeric(14,4) NOT NULL,
  unit_price   numeric(14,4) NOT NULL,
  -- this delivery's share of the source line's net after bill discount (before VAT in exc mode)
  value        numeric(14,2) NOT NULL,
  cogs         numeric(14,2)
);
CREATE INDEX sales_delivery_lines_delivery ON sales_delivery_lines (tenant_id, delivery_id, line_no);
CREATE INDEX sales_delivery_lines_so_line ON sales_delivery_lines (tenant_id, so_line_id);
CREATE INDEX sales_delivery_lines_inv_line ON sales_delivery_lines (tenant_id, inv_line_id);
SELECT erp_secure_table('sales_delivery_lines', true);

-- ---------- deposits (REQ-M09-03/06, BR-06) ----------
CREATE TABLE sales_deposits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  no             text NOT NULL,
  date           date NOT NULL,
  project_id     uuid NOT NULL REFERENCES sales_projects(id),
  customer_id    uuid NOT NULL REFERENCES customers(id),
  -- guarantee: ใบรับเงินมัดจำ, no VAT until applied or forfeited; advance: tax invoice on the receipt date
  type           text NOT NULL CHECK (type IN ('guarantee','advance')),
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  method         text NOT NULL,
  invoice_doc_id uuid REFERENCES docs(id),
  forfeit_doc_id uuid REFERENCES docs(id),
  refund         jsonb,   -- {amount, method, date, by}
  -- forfeited / refunded: the part not yet deducted by installment invoices at that time
  closed_amount  numeric(14,2) NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','forfeited','refunded','void')),
  void_by        uuid REFERENCES users(id),
  void_at        timestamptz,
  void_reason    text,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, no)
);
CREATE INDEX sales_deposits_project ON sales_deposits (tenant_id, project_id);
SELECT erp_secure_table('sales_deposits', true);

-- ---------- B2B tax invoices: extension of docs (type 'INV') ----------
CREATE TABLE sales_invoices (
  doc_id         uuid PRIMARY KEY REFERENCES docs(id),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  kind           text NOT NULL CHECK (kind IN ('credit','cash')),
  -- abb: full tax invoice issued later for a POS abbreviated invoice (docs.ref_doc_id = the ABB, which is voided)
  source         text NOT NULL CHECK (source IN ('delivery','direct','installment','deposit','forfeit','abb')),
  so_id          uuid REFERENCES sales_orders(id),
  project_id     uuid REFERENCES sales_projects(id),
  installment_id uuid REFERENCES sales_project_installments(id),
  deposit_id     uuid REFERENCES sales_deposits(id),
  term           jsonb NOT NULL DEFAULT '{"t":"cash"}'::jsonb,
  due_date       date NOT NULL,
  -- direct invoice whose goods the customer leaves at the shop: delivered later by DO (REQ-M08-10)
  goods_left     boolean NOT NULL DEFAULT false,
  -- installment: gross before deposit, deduction of an advance deposit (in the total) or applied guarantee deposit (paid off the balance)
  gross_amount   numeric(14,2),
  deposit_deduct numeric(14,2) NOT NULL DEFAULT 0,
  deposit_type   text,
  text_lines     jsonb NOT NULL DEFAULT '[]'::jsonb,
  attn           text NOT NULL DEFAULT '',
  note           text NOT NULL DEFAULT '',
  salesperson_id uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_invoices_due ON sales_invoices (tenant_id, kind, due_date);
CREATE INDEX sales_invoices_project ON sales_invoices (tenant_id, project_id);
CREATE INDEX sales_invoices_installment ON sales_invoices (tenant_id, installment_id);
SELECT erp_secure_table('sales_invoices', true);

-- Which deliveries an invoice billed. A delivery is "invoiced" while one of its invoices is active.
CREATE TABLE sales_invoice_deliveries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  invoice_doc_id uuid NOT NULL REFERENCES docs(id),
  delivery_id    uuid NOT NULL REFERENCES sales_deliveries(id)
);
CREATE INDEX sales_invoice_deliveries_dlv ON sales_invoice_deliveries (tenant_id, delivery_id);
CREATE INDEX sales_invoice_deliveries_inv ON sales_invoice_deliveries (tenant_id, invoice_doc_id);
SELECT erp_secure_table('sales_invoice_deliveries', true);

-- ---------- billing notes (REQ-M10-01) ----------
CREATE TABLE ar_billing_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  no           text NOT NULL,
  date         date NOT NULL,
  customer_id  uuid NOT NULL REFERENCES customers(id),
  collect_date date,           -- วันนัดรับเช็ค
  note         text NOT NULL DEFAULT '',
  total        numeric(14,2) NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  void_by      uuid REFERENCES users(id),
  void_at      timestamptz,
  void_reason  text,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  search_text  text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, no)
);
CREATE INDEX ar_billing_notes_tenant_created ON ar_billing_notes (tenant_id, created_at DESC, id);
SELECT erp_secure_table('ar_billing_notes', true);

CREATE TABLE ar_billing_note_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  bn_id          uuid NOT NULL REFERENCES ar_billing_notes(id),
  line_no        integer NOT NULL,
  invoice_doc_id uuid NOT NULL REFERENCES docs(id),
  amount         numeric(14,2) NOT NULL,
  due_date       date NOT NULL
);
CREATE INDEX ar_billing_note_lines_bn ON ar_billing_note_lines (tenant_id, bn_id, line_no);
CREATE INDEX ar_billing_note_lines_inv ON ar_billing_note_lines (tenant_id, invoice_doc_id);
SELECT erp_secure_table('ar_billing_note_lines', true);

-- ---------- receipts (REQ-M10-02/03) ----------
CREATE TABLE ar_receipts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  no            text NOT NULL,
  date          date NOT NULL,
  customer_id   uuid NOT NULL REFERENCES customers(id),
  method        text NOT NULL CHECK (method IN ('cash','transfer','cheque','promptpay','card')),
  cheque        jsonb,                 -- {no, bank, date}
  settled       numeric(14,2) NOT NULL CHECK (settled > 0),
  wht_rate      numeric(5,2),
  wht           numeric(14,2) NOT NULL DEFAULT 0 CHECK (wht >= 0),
  wht_cert_no   text,                  -- 50 ทวิ
  cash          numeric(14,2) NOT NULL,
  note          text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  void_by       uuid REFERENCES users(id),
  void_at       timestamptz,
  void_reason   text,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  search_text   text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, no),
  CHECK (cash + wht = settled)
);
CREATE INDEX ar_receipts_tenant_created ON ar_receipts (tenant_id, created_at DESC, id);
CREATE INDEX ar_receipts_customer ON ar_receipts (tenant_id, customer_id, date);
SELECT erp_secure_table('ar_receipts', true);

CREATE TABLE ar_receipt_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  receipt_id     uuid NOT NULL REFERENCES ar_receipts(id),
  line_no        integer NOT NULL,
  invoice_doc_id uuid NOT NULL REFERENCES docs(id),
  settled        numeric(14,2) NOT NULL CHECK (settled > 0),
  wht_base       numeric(14,2) NOT NULL,
  wht            numeric(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX ar_receipt_lines_receipt ON ar_receipt_lines (tenant_id, receipt_id, line_no);
CREATE INDEX ar_receipt_lines_inv ON ar_receipt_lines (tenant_id, invoice_doc_id);
SELECT erp_secure_table('ar_receipt_lines', true);
