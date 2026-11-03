-- Group E (reports): M11 reports, M12 accounting export.
-- Reports read the core tables only; this file adds the export tables and the indexes the monthly
-- reports need (REQ-M11-01 / NFR-04: a month in < 10 s).

-- ---------- GL mapping for exports (REQ-M12-02 / M12-06, mockup Master data › ภาษีและผังบัญชี) ----------
-- One row per shop. Missing row = the defaults below (core DEFAULT_GL).
CREATE TABLE report_gl_map (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id),
  sale       text NOT NULL DEFAULT '410101',
  buy        text NOT NULL DEFAULT '114102',
  cogs       text NOT NULL DEFAULT '510103',
  pdisc      text NOT NULL DEFAULT '510104',
  ar         text NOT NULL DEFAULT '113101',
  ap         text NOT NULL DEFAULT '212101',
  vat_out    text NOT NULL DEFAULT '215101',
  vat_in     text NOT NULL DEFAULT '115101',
  cash       text NOT NULL DEFAULT '111101',
  coupon     text NOT NULL DEFAULT '410901',
  deposit    text NOT NULL DEFAULT '217101',
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT erp_secure_table('report_gl_map');

-- ---------- export history (REQ-M12-04) ----------
CREATE TABLE export_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  template    text NOT NULL,
  dataset     text NOT NULL,
  format      text NOT NULL DEFAULT 'csv',
  date_from   date,
  date_to     date,
  only_new    boolean NOT NULL DEFAULT false,
  rows        integer NOT NULL,
  docs        integer NOT NULL DEFAULT 0,
  files       integer NOT NULL,
  warnings    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT export_runs_format CHECK (format IN ('csv', 'xlsx'))
);
CREATE INDEX export_runs_tenant_created ON export_runs (tenant_id, created_at DESC, id);
SELECT erp_secure_table('export_runs', true);

-- The generated files are kept so the accountant can download a past export again.
CREATE TABLE export_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  run_id       uuid NOT NULL REFERENCES export_runs(id),
  seq          integer NOT NULL,
  name         text NOT NULL,
  content_type text NOT NULL,
  rows         integer NOT NULL,
  content      bytea NOT NULL,
  UNIQUE (run_id, seq)
);
CREATE INDEX export_files_run ON export_files (tenant_id, run_id, seq);
SELECT erp_secure_table('export_files', true);

-- Which documents went out in which run: "only not yet exported" and "changed after export" warnings.
CREATE TABLE export_run_docs (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  run_id    uuid NOT NULL REFERENCES export_runs(id),
  source    text NOT NULL,          -- 'docs' | 'stock_docs' (later: module tables, e.g. AP bills)
  doc_id    uuid NOT NULL,
  doc_no    text NOT NULL,
  PRIMARY KEY (run_id, source, doc_id)
);
CREATE INDEX export_run_docs_doc ON export_run_docs (tenant_id, source, doc_id);
SELECT erp_secure_table('export_run_docs', true);

-- ---------- report indexes on core tables ----------
-- sales by day / month / VAT report: docs of a period, by type
CREATE INDEX IF NOT EXISTS docs_tenant_date_type ON docs (tenant_id, date, type);
-- stock as of a date and slow movers: ledger by time and by product
CREATE INDEX IF NOT EXISTS stock_moves_tenant_at ON stock_moves (tenant_id, at);
CREATE INDEX IF NOT EXISTS stock_moves_product_at ON stock_moves (tenant_id, product_id, at DESC);
CREATE INDEX IF NOT EXISTS stock_move_lots_lot ON stock_move_lots (tenant_id, lot_id);
-- purchase VAT / purchase book: goods receipts of a period
CREATE INDEX IF NOT EXISTS stock_docs_tenant_date_type ON stock_docs (tenant_id, date, type);
