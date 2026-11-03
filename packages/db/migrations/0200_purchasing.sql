-- Group B "purchasing": M18 AP (bills, payment vouchers, vendor returns), GR lines, delivery-file drafts (M19-08),
-- M04 Import Hub, stock counts (M06-05/06). Every table: tenant_id + erp_secure_table (RLS, grants, no-delete for documents).

-- ---------- shop settings for purchasing (BR-19) ----------
CREATE TABLE purchasing_settings (
  tenant_id          uuid PRIMARY KEY REFERENCES tenants(id),
  bill_discount_mode text NOT NULL DEFAULT 'sep' CHECK (bill_discount_mode IN ('sep','alloc')), -- sep = separate purchase discount
  updated_by         uuid REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
SELECT erp_secure_table('purchasing_settings');

-- ---------- goods receipt lines (one row per receipt line, written when a GR is confirmed) ----------
CREATE TABLE gr_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  gr_doc_id     uuid NOT NULL REFERENCES stock_docs(id),
  gr_no         text NOT NULL,
  line_no       integer NOT NULL,
  product_id    uuid NOT NULL REFERENCES products(id),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  unit_idx      integer NOT NULL,
  unit_name     text NOT NULL,
  unit_factor   numeric(14,4) NOT NULL,
  qty           numeric(14,4) NOT NULL CHECK (qty > 0),             -- in the line unit
  base_qty      numeric(14,4) NOT NULL CHECK (base_qty > 0),
  unit_price    numeric(14,4) NOT NULL CHECK (unit_price >= 0),     -- purchase price per line unit, before bill discount
  amount        numeric(14,2) NOT NULL,
  lot_unit_cost numeric(14,4) NOT NULL,                             -- per base unit, as stored on the lot
  lot_id        bigint NOT NULL REFERENCES stock_lots(id),
  returned_base_qty numeric(14,4) NOT NULL DEFAULT 0,
  CONSTRAINT gr_lines_returned CHECK (returned_base_qty >= 0 AND returned_base_qty <= base_qty)
);
CREATE INDEX gr_lines_doc ON gr_lines (tenant_id, gr_doc_id, line_no);
SELECT erp_secure_table('gr_lines', true);

-- ---------- AP bills (REQ-M18-01) ----------
CREATE TABLE ap_bills (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  no                text NOT NULL,
  source            text NOT NULL CHECK (source IN ('gr','opening')),
  vendor_id         uuid NOT NULL REFERENCES vendors(id),
  vendor_invoice_no text NOT NULL,
  gr_doc_id         uuid REFERENCES stock_docs(id),
  gr_no             text,
  date              date NOT NULL,
  due_date          date NOT NULL,
  base              numeric(14,2) NOT NULL,      -- goods value before bill discount, ex VAT
  discount          numeric(14,2) NOT NULL DEFAULT 0,
  discount_mode     text NOT NULL DEFAULT 'sep' CHECK (discount_mode IN ('sep','alloc')),
  vat               numeric(14,2) NOT NULL DEFAULT 0,
  total             numeric(14,2) NOT NULL,
  paid              numeric(14,2) NOT NULL DEFAULT 0,  -- includes withholding tax
  returned          numeric(14,2) NOT NULL DEFAULT 0,  -- vendor returns applied
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ap_bills_balance CHECK (paid >= 0 AND returned >= 0 AND paid + returned <= total)
);
CREATE UNIQUE INDEX ap_bills_tenant_no ON ap_bills (tenant_id, no);
CREATE UNIQUE INDEX ap_bills_gr ON ap_bills (tenant_id, gr_doc_id) WHERE gr_doc_id IS NOT NULL;
CREATE UNIQUE INDEX ap_bills_opening ON ap_bills (tenant_id, vendor_id, vendor_invoice_no) WHERE source = 'opening';
CREATE INDEX ap_bills_due ON ap_bills (tenant_id, due_date, id);
CREATE INDEX ap_bills_vendor ON ap_bills (tenant_id, vendor_id, date);
SELECT erp_secure_table('ap_bills', true);

-- ---------- payment vouchers (REQ-M18-02) ----------
CREATE TABLE ap_payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  no          text NOT NULL,
  date        date NOT NULL,
  vendor_id   uuid NOT NULL REFERENCES vendors(id),
  method      text NOT NULL CHECK (method IN ('transfer','cheque','cash')),
  ref         text,                       -- cheque no / transfer reference
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),      -- settled against bills (incl. WHT)
  wht_rate    numeric(5,2) NOT NULL DEFAULT 0,
  wht         numeric(14,2) NOT NULL DEFAULT 0 CHECK (wht >= 0),
  net         numeric(14,2) NOT NULL,                          -- cash actually paid
  note        text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ap_payments_tenant_no ON ap_payments (tenant_id, no);
CREATE INDEX ap_payments_created ON ap_payments (tenant_id, created_at DESC, id);
SELECT erp_secure_table('ap_payments', true);

CREATE TABLE ap_payment_allocs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  payment_id  uuid NOT NULL REFERENCES ap_payments(id),
  bill_id     uuid NOT NULL REFERENCES ap_bills(id),
  amount      numeric(14,2) NOT NULL CHECK (amount > 0)
);
CREATE INDEX ap_payment_allocs_payment ON ap_payment_allocs (tenant_id, payment_id);
CREATE INDEX ap_payment_allocs_bill ON ap_payment_allocs (tenant_id, bill_id);
SELECT erp_secure_table('ap_payment_allocs', true);

-- ---------- vendor returns (REQ-M18-03) ----------
CREATE TABLE vendor_returns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  no            text NOT NULL,
  date          date NOT NULL,
  vendor_id     uuid NOT NULL REFERENCES vendors(id),
  gr_doc_id     uuid NOT NULL REFERENCES stock_docs(id),
  gr_no         text NOT NULL,
  ap_bill_id    uuid REFERENCES ap_bills(id),
  reason        text NOT NULL,
  vendor_cn_no  text,
  base          numeric(14,2) NOT NULL,
  vat           numeric(14,2) NOT NULL,
  total         numeric(14,2) NOT NULL,
  ap_applied    numeric(14,2) NOT NULL,
  unapplied     numeric(14,2) NOT NULL DEFAULT 0,
  cogs          numeric(14,2) NOT NULL,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vendor_returns_tenant_no ON vendor_returns (tenant_id, no);
CREATE INDEX vendor_returns_created ON vendor_returns (tenant_id, created_at DESC, id);
SELECT erp_secure_table('vendor_returns', true);

CREATE TABLE vendor_return_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  return_id   uuid NOT NULL REFERENCES vendor_returns(id),
  gr_line_id  uuid NOT NULL REFERENCES gr_lines(id),
  product_id  uuid NOT NULL REFERENCES products(id),
  qty         numeric(14,4) NOT NULL CHECK (qty > 0),   -- in the GR line unit
  base_qty    numeric(14,4) NOT NULL CHECK (base_qty > 0),
  unit_price  numeric(14,4) NOT NULL,
  amount      numeric(14,2) NOT NULL,
  cogs        numeric(14,2) NOT NULL
);
CREATE INDEX vendor_return_lines_ret ON vendor_return_lines (tenant_id, return_id);
SELECT erp_secure_table('vendor_return_lines', true);

-- ---------- file imports: mapping profiles, product-code aliases, batches ----------
CREATE TABLE import_profiles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  kind             text NOT NULL,           -- 'delivery' or an Import Hub kind
  name             text NOT NULL,           -- source program / dealer
  header_signature text NOT NULL,
  mapping          jsonb NOT NULL,          -- field -> column index
  encoding         text,
  delimiter        text,
  vat_flag_default text,
  vendor_id        uuid REFERENCES vendors(id),
  active           boolean NOT NULL DEFAULT true,
  created_by       uuid NOT NULL REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX import_profiles_sig ON import_profiles (tenant_id, kind, header_signature, name);
SELECT erp_secure_table('import_profiles');

CREATE TABLE product_code_aliases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  vendor_id     uuid REFERENCES vendors(id),
  external_code text NOT NULL,
  product_id    uuid NOT NULL REFERENCES products(id),
  unit_map      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- file unit text -> unit index
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid NOT NULL REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_code_aliases_code ON product_code_aliases (tenant_id, coalesce(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(external_code));
SELECT erp_secure_table('product_code_aliases');

CREATE TABLE import_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  no            text NOT NULL,
  kind          text NOT NULL,
  mode          text NOT NULL CHECK (mode IN ('onboarding','ongoing','delivery')),
  source        text NOT NULL,
  file_name     text NOT NULL,
  file_sha256   text NOT NULL,
  rows_total    integer NOT NULL,
  rows_created  integer NOT NULL DEFAULT 0,
  rows_updated  integer NOT NULL DEFAULT 0,
  rows_skipped  integer NOT NULL DEFAULT 0,
  rows_error    integer NOT NULL DEFAULT 0,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX import_batches_tenant_no ON import_batches (tenant_id, no);
CREATE INDEX import_batches_sha ON import_batches (tenant_id, kind, file_sha256);
CREATE INDEX import_batches_created ON import_batches (tenant_id, created_at DESC, id);
SELECT erp_secure_table('import_batches', true);

-- Natural keys of imported transactional rows (opening lots / AR / AP): re-running a file never duplicates them.
CREATE TABLE import_keys (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  kind       text NOT NULL,
  key        text NOT NULL,
  batch_id   uuid NOT NULL REFERENCES import_batches(id),
  PRIMARY KEY (tenant_id, kind, key)
);
SELECT erp_secure_table('import_keys', true);

-- Opening AR balances (REQ-M04-02) imported at onboarding; no tax document is issued. Read by the AR module.
CREATE TABLE ar_opening_balances (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  customer_id  uuid NOT NULL REFERENCES customers(id),
  doc_no       text NOT NULL,
  date         date NOT NULL,
  due_date     date NOT NULL,
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  balance      numeric(14,2) NOT NULL CHECK (balance >= 0),
  batch_id     uuid NOT NULL REFERENCES import_batches(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ar_opening_doc ON ar_opening_balances (tenant_id, customer_id, doc_no);
SELECT erp_secure_table('ar_opening_balances', true);

-- PEAK contact template fields that the core customers / vendors tables do not have (REQ-M03-05).
ALTER TABLE customers ADD COLUMN purchasing_contact jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE vendors ADD COLUMN purchasing_contact jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ---------- delivery-file drafts (M19-08): one draft goods receipt per delivery note ----------
CREATE TABLE gr_drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  batch_id        uuid REFERENCES import_batches(id),
  dn_no           text,
  po_no           text,
  invoice_no      text,
  dealer_name     text,
  vendor_id       uuid REFERENCES vendors(id),
  warehouse_id    uuid REFERENCES warehouses(id),
  delivery_date   date,
  received_on     date NOT NULL,            -- business date the draft arrived (BR-10 age)
  vat_flag        text NOT NULL DEFAULT 'exc' CHECK (vat_flag IN ('inc','exc','none')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','cancelled')),
  confirmed_doc_id uuid REFERENCES stock_docs(id),
  confirmed_no    text,
  short_reason    text,
  force_reason    text,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX gr_drafts_open_dn ON gr_drafts (tenant_id, dn_no) WHERE status = 'draft' AND dn_no IS NOT NULL;
CREATE INDEX gr_drafts_status ON gr_drafts (tenant_id, status, received_on, id);
SELECT erp_secure_table('gr_drafts', true);

CREATE TABLE gr_draft_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  draft_id       uuid NOT NULL REFERENCES gr_drafts(id),
  line_no        integer NOT NULL,
  row_no         integer NOT NULL,           -- line in the source file
  external_code  text NOT NULL,
  external_name  text NOT NULL,
  unit_text      text NOT NULL,
  qty            numeric(14,4) NOT NULL CHECK (qty > 0),
  unit_price     numeric(14,4) NOT NULL CHECK (unit_price >= 0),
  line_discount  numeric(14,2) NOT NULL DEFAULT 0,
  product_id     uuid REFERENCES products(id),
  unit_idx       integer,
  received_qty   numeric(14,4),
  damaged_qty    numeric(14,4) NOT NULL DEFAULT 0,
  warnings       jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX gr_draft_lines_draft ON gr_draft_lines (tenant_id, draft_id, line_no);
SELECT erp_secure_table('gr_draft_lines', true);

-- ---------- stock counts (REQ-M06-05/06, BR-09) ----------
CREATE TABLE stock_counts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  no                 text NOT NULL,
  warehouse_id       uuid NOT NULL REFERENCES warehouses(id),
  category           text,
  status             text NOT NULL DEFAULT 'counting' CHECK (status IN ('counting','submitted','cancelled')),
  opened_by          uuid NOT NULL REFERENCES users(id),
  opened_at          timestamptz NOT NULL DEFAULT now(),
  submitted_by       uuid REFERENCES users(id),
  submitted_at       timestamptz,
  adjust_request_id  uuid REFERENCES adjust_requests(id),
  adjust_request_no  text,
  note               text
);
CREATE UNIQUE INDEX stock_counts_tenant_no ON stock_counts (tenant_id, no);
CREATE INDEX stock_counts_opened ON stock_counts (tenant_id, opened_at DESC, id);
SELECT erp_secure_table('stock_counts', true);

CREATE TABLE stock_count_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  count_id      uuid NOT NULL REFERENCES stock_counts(id),
  product_id    uuid NOT NULL REFERENCES products(id),
  system_qty    numeric(14,4) NOT NULL,        -- snapshot when the count was opened
  counted_qty   numeric(14,4) CHECK (counted_qty >= 0),
  moved_qty     numeric(14,4),                 -- stock movements during the count (set on submit)
  counted_by    uuid REFERENCES users(id),
  counted_at    timestamptz,
  UNIQUE (count_id, product_id)
);
CREATE INDEX stock_count_lines_count ON stock_count_lines (tenant_id, count_id);
SELECT erp_secure_table('stock_count_lines', true);

-- Ledger paging (REQ-M06-01): moves per product / warehouse, newest first.
CREATE INDEX stock_moves_pw_at ON stock_moves (tenant_id, product_id, warehouse_id, at DESC, id DESC);
CREATE INDEX stock_moves_at ON stock_moves (tenant_id, at DESC, id DESC);
