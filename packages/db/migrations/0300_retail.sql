-- Module group C "retail": M15 promotions, M16 production, held POS bills (REQ-M07-08), customer price lists (BR-05),
-- product images (REQ-M07-11). Every table: tenant_id + erp_secure_table() (BR-14). erp_app never gets DELETE, so
-- removals are status / active flags.

-- ---------- M15 promotions ----------
-- items: discount promo [{"productId": uuid}], bundle [{"productId": uuid, "qtyPerSet": "100"}] (base units).
-- Bills snapshot the promo on doc_lines, so editing or closing a promo never changes issued bills (REQ-M15-04).
CREATE TABLE retail_promos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  code            text NOT NULL,
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('disc', 'bundle')),
  mode            text CHECK (mode IN ('pct', 'amt', 'fixed')),
  value           numeric(14,4),
  set_price       numeric(14,2),
  sku             text,
  items           jsonb NOT NULL,
  channels        text[] NOT NULL DEFAULT '{pos}',
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'closed')),
  below_cost      boolean NOT NULL DEFAULT false,
  below_cost_by   uuid REFERENCES users(id),
  below_cost_detail text,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users(id),
  updated_at      timestamptz,
  closed_by       uuid REFERENCES users(id),
  closed_at       timestamptz,
  CHECK (end_date >= start_date),
  CHECK (kind <> 'disc' OR (mode IS NOT NULL AND value IS NOT NULL AND value >= 0)),
  CHECK (kind <> 'bundle' OR (set_price IS NOT NULL AND set_price > 0)),
  CHECK (channels <@ ARRAY['pos', 'b2b']::text[] AND cardinality(channels) > 0),
  UNIQUE (tenant_id, code)
);
CREATE INDEX retail_promos_tenant_dates ON retail_promos (tenant_id, status, start_date, end_date);
CREATE UNIQUE INDEX retail_promos_tenant_sku ON retail_promos (tenant_id, sku) WHERE sku IS NOT NULL;
SELECT erp_secure_table('retail_promos', true);

-- POS lines priced by a promo / bundle / price list (snapshot; additive columns on the core doc_lines table).
-- A bundle sale writes one doc line per component with its pro-rata revenue (BR-17); retail_bundle_no groups them.
ALTER TABLE doc_lines
  ADD COLUMN retail_promo_id     uuid,
  ADD COLUMN retail_promo_name   text,
  ADD COLUMN retail_list_price   numeric(14,4),
  ADD COLUMN retail_price_source text,
  ADD COLUMN retail_bundle_no    integer,
  ADD COLUMN retail_bundle_sets  numeric(14,4),
  ADD COLUMN retail_bundle_qty   numeric(14,4),
  ADD COLUMN retail_bundle_price numeric(14,2);
CREATE INDEX doc_lines_retail_promo ON doc_lines (tenant_id, retail_promo_id) WHERE retail_promo_id IS NOT NULL;

-- ---------- BR-05 price lists ----------
CREATE TABLE retail_price_lists (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  name           text NOT NULL,
  customer_id    uuid REFERENCES customers(id),
  customer_group text CHECK (customer_group IN ('retail', 'whole', 'contr')),
  vat_included   boolean NOT NULL DEFAULT true,
  valid_from     date,
  valid_to       date,
  active         boolean NOT NULL DEFAULT true,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz,
  CHECK ((customer_id IS NULL) <> (customer_group IS NULL)),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX retail_price_lists_customer ON retail_price_lists (tenant_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX retail_price_lists_group ON retail_price_lists (tenant_id, customer_group) WHERE customer_group IS NOT NULL;
SELECT erp_secure_table('retail_price_lists');

CREATE TABLE retail_price_list_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  list_id    uuid NOT NULL REFERENCES retail_price_lists(id),
  product_id uuid NOT NULL REFERENCES products(id),
  unit_idx   integer NOT NULL DEFAULT 0 CHECK (unit_idx >= 0),
  min_qty    numeric(14,4) NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  price      numeric(14,2) NOT NULL CHECK (price >= 0),
  active     boolean NOT NULL DEFAULT true,
  UNIQUE (list_id, product_id, unit_idx, min_qty)
);
CREATE INDEX retail_price_list_items_product ON retail_price_list_items (tenant_id, product_id) WHERE active;
SELECT erp_secure_table('retail_price_list_items');

-- ---------- REQ-M07-08 held bills ----------
-- cart: the POS cart as the client builds it (lines, bundles, bill discount, customer). Holding never touches stock.
CREATE TABLE retail_held_bills (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  shift_id    uuid NOT NULL REFERENCES shifts(id),
  device_id   text NOT NULL,
  user_id     uuid NOT NULL REFERENCES users(id),
  label       text NOT NULL,
  customer_id uuid REFERENCES customers(id),
  cart        jsonb NOT NULL,
  item_count  integer NOT NULL,
  total       numeric(14,2) NOT NULL,
  status      text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'resumed', 'discarded')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  closed_by   uuid REFERENCES users(id)
);
CREATE INDEX retail_held_bills_shift ON retail_held_bills (tenant_id, shift_id, status, created_at);
SELECT erp_secure_table('retail_held_bills');

-- ---------- REQ-M07-11 product images (non-SCG products; SCG images come from the central master) ----------
CREATE TABLE retail_product_images (
  product_id uuid PRIMARY KEY REFERENCES products(id),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  mime       text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  data       bytea,
  bytes      integer NOT NULL DEFAULT 0 CHECK (bytes <= 262144),
  version    integer NOT NULL DEFAULT 1,
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retail_product_images_tenant ON retail_product_images (tenant_id) WHERE data IS NOT NULL;
SELECT erp_secure_table('retail_product_images');

-- ---------- M16 production ----------
-- A BOM version is immutable; editing creates the next version and moves "active" to it (one active per product).
-- components: [{"productId": uuid, "qtyPerUnit": "0.5"}] in the material's base unit per 1 base unit produced.
CREATE TABLE retail_boms (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  product_id        uuid NOT NULL REFERENCES products(id),
  version           integer NOT NULL,
  components        jsonb NOT NULL,
  labour_per_unit   numeric(14,4) NOT NULL DEFAULT 0 CHECK (labour_per_unit >= 0),
  overhead_per_unit numeric(14,4) NOT NULL DEFAULT 0 CHECK (overhead_per_unit >= 0),
  note              text NOT NULL DEFAULT '',
  active            boolean NOT NULL DEFAULT true,
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, product_id, version)
);
CREATE UNIQUE INDEX retail_boms_one_active ON retail_boms (tenant_id, product_id) WHERE active;
SELECT erp_secure_table('retail_boms', true);

CREATE TABLE retail_mos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  no                text NOT NULL,
  date              date NOT NULL,
  product_id        uuid NOT NULL REFERENCES products(id),
  bom_id            uuid NOT NULL REFERENCES retail_boms(id),
  plan_qty          numeric(14,4) NOT NULL CHECK (plan_qty > 0),
  issue_wh          uuid NOT NULL REFERENCES warehouses(id),
  output_wh         uuid NOT NULL REFERENCES warehouses(id),
  status            text NOT NULL DEFAULT 'wip' CHECK (status IN ('wip', 'closed', 'cancelled')),
  labour_per_unit   numeric(14,4) NOT NULL DEFAULT 0,
  overhead_per_unit numeric(14,4) NOT NULL DEFAULT 0,
  materials_cost    numeric(14,2) NOT NULL DEFAULT 0,
  returned_cost     numeric(14,2) NOT NULL DEFAULT 0,
  labour_cost       numeric(14,2),
  overhead_cost     numeric(14,2),
  good_qty          numeric(14,4) NOT NULL DEFAULT 0,
  reject_qty        numeric(14,4) NOT NULL DEFAULT 0,
  unit_cost         numeric(14,4),
  lot_id            bigint,
  note              text NOT NULL DEFAULT '',
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  closed_by         uuid REFERENCES users(id),
  closed_at         timestamptz,
  cancel_reason     text,
  UNIQUE (tenant_id, no)
);
CREATE INDEX retail_mos_tenant_created ON retail_mos (tenant_id, created_at DESC, id);
SELECT erp_secure_table('retail_mos', true);

CREATE TABLE retail_mo_materials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  mo_id         uuid NOT NULL REFERENCES retail_mos(id),
  line_no       integer NOT NULL,
  product_id    uuid NOT NULL REFERENCES products(id),
  std_qty       numeric(14,4) NOT NULL,
  issue_qty     numeric(14,4) NOT NULL CHECK (issue_qty >= 0),
  cost          numeric(14,2) NOT NULL DEFAULT 0,
  returned_qty  numeric(14,4) NOT NULL DEFAULT 0,
  returned_cost numeric(14,2) NOT NULL DEFAULT 0,
  CHECK (returned_qty >= 0 AND returned_qty <= issue_qty)
);
CREATE INDEX retail_mo_materials_mo ON retail_mo_materials (tenant_id, mo_id);
SELECT erp_secure_table('retail_mo_materials', true);

CREATE TABLE retail_mo_outputs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  mo_id       uuid NOT NULL REFERENCES retail_mos(id),
  good_qty    numeric(14,4) NOT NULL CHECK (good_qty >= 0),
  reject_qty  numeric(14,4) NOT NULL DEFAULT 0 CHECK (reject_qty >= 0),
  note        text NOT NULL DEFAULT '',
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (good_qty + reject_qty > 0)
);
CREATE INDEX retail_mo_outputs_mo ON retail_mo_outputs (tenant_id, mo_id);
SELECT erp_secure_table('retail_mo_outputs', true);

-- ---------- REQ-M01-07 POS machines and the Revenue Department POS ID (ภ.พ.06) ----------
-- code is the device name a shift is opened on (shifts.device_id). Once a shop registers any machine, an
-- abbreviated tax invoice (ABB) can be issued only on a registered, approved machine that has a POS ID.
CREATE TABLE retail_pos_devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  code         text NOT NULL,
  name         text NOT NULL,
  rd_pos_id    text,
  approved_on  date,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'retired')),
  note         text NOT NULL DEFAULT '',
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES users(id),
  updated_at   timestamptz,
  CHECK (status <> 'approved' OR (rd_pos_id IS NOT NULL AND rd_pos_id <> '' AND approved_on IS NOT NULL)),
  UNIQUE (tenant_id, code)
);
SELECT erp_secure_table('retail_pos_devices');
