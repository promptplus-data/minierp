-- Per-shop menu entitlements (see packages/contracts/src/features.ts) and cloud license keys.
-- Cloud: SCG Admin sets the enabled menus live per shop; null = every menu (existing shops keep everything).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS adm_features text[];
-- On-prem keys carry their menus inside the signed key; the registry keeps a copy for the issuing screen.
ALTER TABLE license_registry ADD COLUMN IF NOT EXISTS features text[];

-- A cloud shop checks its installed key against the registry (revoked keys stop counting). The shop's own
-- transaction cannot read the platform registry, so it asks this function: one boolean, nothing else leaves.
CREATE OR REPLACE FUNCTION license_revoked(p_license_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM license_registry WHERE license_id = p_license_id AND revoked_at IS NOT NULL);
$$;

DROP FUNCTION IF EXISTS adm_tenant_overview();
CREATE FUNCTION adm_tenant_overview()
RETURNS TABLE (id uuid, code text, name text, tax_id text, vat_registered boolean, edition text, region text, customer_code text,
               status text, status_reason text, created_at timestamptz, users integer, bills_30d integer, last_bill_at timestamptz,
               sales_month numeric, features text[])
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
                                                       AND d.date >= date_trunc('month', (now() AT TIME ZONE 'Asia/Bangkok'))::date),
         t.adm_features
    FROM tenants t;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['adm_tenant_overview()','license_revoked(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO erp_app', f);
    END IF;
  END LOOP;
END $$;
