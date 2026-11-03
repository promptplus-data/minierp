-- M19-11 license keys (issued by SCG Admin on cloud, verified offline on-prem) and
-- M19-10 opt-in sales summary share (sent manually by an on-prem shop, stored on cloud per licensed shop).

-- ---------- on-prem: keys installed in this shop (latest installed row is the active one) ----------
CREATE TABLE licenses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  license_id   text NOT NULL,
  license_key  text NOT NULL,
  shop_name    text NOT NULL,
  tax_id       text NOT NULL,
  edition      text NOT NULL,
  key_type     text NOT NULL,            -- expiring | lifetime
  expires_at   date,                     -- null = lifetime
  issued_at    timestamptz NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  installed_by uuid REFERENCES users(id),
  CONSTRAINT licenses_type CHECK (key_type IN ('expiring','lifetime') AND ((key_type = 'lifetime') = (expires_at IS NULL)))
);
CREATE INDEX licenses_tenant_installed ON licenses (tenant_id, installed_at DESC);
SELECT erp_secure_table('licenses', true);

-- ---------- on-prem: summaries this shop chose to send (REQ-M19-10) ----------
CREATE TABLE sales_shares (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  from_date   date NOT NULL,
  to_date     date NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL,             -- sent | failed
  error       text,
  receipt_id  text,
  sent_by     uuid NOT NULL REFERENCES users(id),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_shares_status CHECK (status IN ('sent','failed'))
);
CREATE INDEX sales_shares_list ON sales_shares (tenant_id, sent_at DESC, id);
SELECT erp_secure_table('sales_shares', true);

-- ---------- cloud: license registry (SCG Admin issuing screen) ----------
CREATE TABLE license_registry (
  license_id  text PRIMARY KEY,
  license_key text NOT NULL,
  shop_name   text NOT NULL,
  tax_id      text NOT NULL,
  edition     text NOT NULL DEFAULT 'onprem',
  key_type    text NOT NULL,
  expires_at  date,
  issued_at   timestamptz NOT NULL,
  region      text NOT NULL DEFAULT '',
  note        text NOT NULL DEFAULT '',
  issued_by   text NOT NULL,
  revoked_at  timestamptz,
  revoked_by  text,
  CONSTRAINT license_registry_type CHECK (key_type IN ('expiring','lifetime') AND ((key_type = 'lifetime') = (expires_at IS NULL)))
);
CREATE INDEX license_registry_issued ON license_registry (issued_at DESC, license_id);

-- ---------- cloud: summaries received from licensed on-prem shops ----------
CREATE TABLE sales_share_inbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id  text NOT NULL REFERENCES license_registry(license_id),
  shop_name   text NOT NULL,
  tax_id      text NOT NULL,
  from_date   date NOT NULL,
  to_date     date NOT NULL,
  payload     jsonb NOT NULL,
  total       numeric(14,2) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_share_inbox_list ON sales_share_inbox (received_at DESC, id);
CREATE INDEX sales_share_inbox_license ON sales_share_inbox (license_id, received_at DESC);
CREATE TRIGGER sales_share_inbox_append_only BEFORE UPDATE OR DELETE ON sales_share_inbox FOR EACH ROW EXECUTE FUNCTION adm_append_only();

-- Registry and inbox: SCG Admin only, except that the public receiver endpoint (which first verifies the key's
-- Ed25519 signature) may look up one key and insert into the inbox with app.share_receiver = 'on'.
ALTER TABLE license_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_registry FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON license_registry USING (adm_is_platform()) WITH CHECK (adm_is_platform());
CREATE POLICY receiver_lookup ON license_registry FOR SELECT USING (coalesce(current_setting('app.share_receiver', true), '') = 'on');
ALTER TABLE sales_share_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_share_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_read ON sales_share_inbox FOR SELECT USING (adm_is_platform());
CREATE POLICY receiver_insert ON sales_share_inbox FOR INSERT WITH CHECK (coalesce(current_setting('app.share_receiver', true), '') = 'on');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON license_registry TO erp_app;
    GRANT SELECT, INSERT ON sales_share_inbox TO erp_app;
  END IF;
END $$;
