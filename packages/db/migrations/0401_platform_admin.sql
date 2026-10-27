-- M14 SCG Admin (cloud). Platform administrators are NOT shop users: they live in their own global tables,
-- sign in separately and never get an app.tenant_id. Access rules (BR-14 stays intact):
--   * global platform tables are readable / writable by erp_app only inside a transaction that set
--     app.platform = 'on' (the server does that only after verifying a platform-admin token);
--   * cross-tenant reads go through the SECURITY DEFINER functions below, which return aggregates / tight columns
--     only and refuse to run unless app.platform = 'on'. They run as the migration owner, which must bypass RLS
--     (superuser or BYPASSRLS, as the on-prem installer's `erp` role and managed cloud owners do);
--   * writes into a shop (create tenant, suspend, push master, import) run in that shop's own tenant transaction.

CREATE OR REPLACE FUNCTION adm_is_platform() RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.platform', true), '') = 'on' $$;

CREATE OR REPLACE FUNCTION adm_require_platform() RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT adm_is_platform() THEN
    RAISE EXCEPTION 'SCG Admin context required' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- ---------- platform administrators ----------
CREATE TABLE platform_admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  name          text NOT NULL,
  role          text NOT NULL DEFAULT 'support',
  password_hash text NOT NULL,
  status        text NOT NULL DEFAULT 'active',
  failed_logins integer NOT NULL DEFAULT 0,
  locked_at     timestamptz,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_admins_role CHECK (role IN ('super','master','onboarding','support','analyst')),
  CONSTRAINT platform_admins_status CHECK (status IN ('active','disabled'))
);

-- Append-only log of every SCG Admin action (the shop-side effects are also written to the shop's audit_log).
CREATE TABLE platform_audit (
  id         bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  at         timestamptz NOT NULL DEFAULT now(),
  admin_id   uuid,
  admin_name text NOT NULL,
  action     text NOT NULL,
  object     text NOT NULL,
  ref        text,
  detail     text NOT NULL DEFAULT ''
);
CREATE OR REPLACE FUNCTION adm_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (BR-18): % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER platform_audit_append_only BEFORE UPDATE OR DELETE ON platform_audit FOR EACH ROW EXECUTE FUNCTION adm_append_only();

-- ---------- tenant registry columns (REQ-M14-01/03/04) ----------
ALTER TABLE tenants ADD COLUMN adm_status text NOT NULL DEFAULT 'active';
ALTER TABLE tenants ADD COLUMN adm_status_reason text;
ALTER TABLE tenants ADD COLUMN adm_edition text NOT NULL DEFAULT 'cloud';
ALTER TABLE tenants ADD COLUMN adm_region text NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN adm_customer_code text NOT NULL DEFAULT '';
ALTER TABLE tenants ADD CONSTRAINT tenants_adm_status CHECK (adm_status IN ('active','suspended'));
ALTER TABLE tenants ADD CONSTRAINT tenants_adm_edition CHECK (adm_edition IN ('cloud','onprem'));

-- ---------- central SCG product master + recommended prices (REQ-M14-02) ----------
CREATE TABLE central_products (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku        text NOT NULL UNIQUE,
  name       text NOT NULL,
  category   text NOT NULL DEFAULT '',
  units      jsonb NOT NULL,          -- [{"name":"ถุง","factor":"1"},{"name":"พาเลท","factor":"40"}]
  barcode    text,
  image_url  text,
  vat        text NOT NULL DEFAULT 'v7',
  active     boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT central_products_vat CHECK (vat IN ('v7','exempt'))
);
CREATE TABLE central_prices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     uuid NOT NULL REFERENCES central_products(id),
  retail         numeric(14,2) NOT NULL CHECK (retail >= 0),
  wholesale      numeric(14,2) NOT NULL DEFAULT 0 CHECK (wholesale >= 0),
  effective_from date NOT NULL,
  pushed_at      timestamptz,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX central_prices_product ON central_prices (product_id, effective_from DESC, created_at DESC);
CREATE TABLE central_pushes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at          timestamptz NOT NULL DEFAULT now(),
  what        text NOT NULL,
  products    integer NOT NULL,
  shops       integer NOT NULL,
  target      text NOT NULL,          -- 'all' or a comma list of shop codes
  by_name     text NOT NULL
);
CREATE TRIGGER central_pushes_append_only BEFORE UPDATE OR DELETE ON central_pushes FOR EACH ROW EXECUTE FUNCTION adm_append_only();

-- Shop products linked to the central master: master fields are SCG's, the selling price is the shop's.
ALTER TABLE products ADD COLUMN adm_central_id uuid;
ALTER TABLE products ADD COLUMN adm_srp numeric(14,2);
ALTER TABLE products ADD COLUMN adm_price_custom boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX products_tenant_central ON products (tenant_id, adm_central_id) WHERE adm_central_id IS NOT NULL;

-- The push sets app.central_push = 'on' in the shop's transaction. Any other update of a linked product may change
-- the price (then it is the shop's own price from now on) but not the master fields (REQ-M14-02).
CREATE OR REPLACE FUNCTION adm_central_product_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.adm_central_id IS NULL OR coalesce(current_setting('app.central_push', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.sku IS DISTINCT FROM OLD.sku OR NEW.name IS DISTINCT FROM OLD.name OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.units IS DISTINCT FROM OLD.units OR NEW.barcode IS DISTINCT FROM OLD.barcode OR NEW.is_scg IS DISTINCT FROM OLD.is_scg
     OR NEW.adm_central_id IS DISTINCT FROM OLD.adm_central_id OR NEW.adm_srp IS DISTINCT FROM OLD.adm_srp THEN
    RAISE EXCEPTION 'SCG master fields of % are managed centrally; only the selling price can change (REQ-M14-02)', OLD.sku
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.price IS DISTINCT FROM OLD.price THEN
    NEW.adm_price_custom := true;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER products_central_guard BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION adm_central_product_guard();

-- ---------- RLS on the global platform tables ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_admins','platform_audit','central_pushes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY platform_only ON %I USING (adm_is_platform()) WITH CHECK (adm_is_platform())', t);
  END LOOP;
  -- The central catalogue is not shop data: every shop may read it; only SCG Admin writes it.
  FOREACH t IN ARRAY ARRAY['central_products','central_prices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY read_all ON %I FOR SELECT USING (true)', t);
    EXECUTE format('CREATE POLICY platform_write ON %I FOR INSERT WITH CHECK (adm_is_platform())', t);
    EXECUTE format('CREATE POLICY platform_update ON %I FOR UPDATE USING (adm_is_platform()) WITH CHECK (adm_is_platform())', t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON platform_admins, platform_audit, central_products, central_prices, central_pushes TO erp_app;
    REVOKE UPDATE ON platform_audit, central_pushes FROM erp_app;
    GRANT USAGE, SELECT ON SEQUENCE platform_audit_id_seq TO erp_app;
  END IF;
END $$;

-- ---------- cross-tenant reads (SECURITY DEFINER, platform context only) ----------
-- Tenant list with usage numbers for the shops screen and the KPI (no shop documents or personal data leave).
CREATE OR REPLACE FUNCTION adm_tenant_overview()
RETURNS TABLE (id uuid, code text, name text, tax_id text, vat_registered boolean, edition text, region text, customer_code text,
               status text, status_reason text, created_at timestamptz, users integer, bills_30d integer, last_bill_at timestamptz,
               sales_month numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM adm_require_platform();
  RETURN QUERY
  SELECT t.id, t.code, t.name, t.tax_id, t.vat_registered, t.adm_edition, t.adm_region, t.adm_customer_code,
         t.adm_status, t.adm_status_reason, t.created_at,
         (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.status = 'active')::integer,
         (SELECT count(*) FROM docs d WHERE d.tenant_id = t.id AND d.type IN ('ABB','INV','RC') AND d.status = 'active'
                                       AND d.created_at >= now() - interval '30 days')::integer,
         (SELECT max(d.created_at) FROM docs d WHERE d.tenant_id = t.id AND d.type IN ('ABB','INV','RC')),
         (SELECT coalesce(sum(d.total), 0) FROM docs d WHERE d.tenant_id = t.id AND d.type IN ('ABB','INV','RC') AND d.status = 'active'
                                                       AND d.date >= date_trunc('month', (now() AT TIME ZONE 'Asia/Bangkok'))::date)
    FROM tenants t;
END $$;

-- Whether a shop already uses a code / tax id (tenant create and import validation).
CREATE OR REPLACE FUNCTION adm_tenant_code_taken(c text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM adm_require_platform();
  RETURN EXISTS (SELECT 1 FROM tenants WHERE code = c);
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['adm_tenant_overview()','adm_tenant_code_taken(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO erp_app', f);
    END IF;
  END LOOP;
END $$;
