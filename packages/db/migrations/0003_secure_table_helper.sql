-- One-line security setup for every new tenant table (packages/db/MIGRATIONS.md):
--   SELECT erp_secure_table('ar_receipts', true);   -- document: also gets the no-delete trigger
--   SELECT erp_secure_table('price_list_items');      -- master/config data: no trigger (erp_app still has no DELETE)
-- It does what 0001_rls_triggers.sql did by hand for the core tables:
--   * checks the table has a tenant_id column
--   * ENABLE + FORCE ROW LEVEL SECURITY and the tenant_isolation policy (tenant_id = app.tenant_id)
--   * GRANT SELECT, INSERT, UPDATE to erp_app (never DELETE / TRUNCATE) and USAGE on the table's own sequences
--   * is_document: BEFORE DELETE trigger erp_forbid_delete() (BR-03/BR-18/BR-22), named <table>_no_delete
-- Idempotent: safe to call again after ALTER TABLE.

CREATE OR REPLACE FUNCTION erp_secure_table(tbl regclass, is_document boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  rel text;
  seq regclass;
BEGIN
  SELECT relname INTO rel FROM pg_class WHERE oid = tbl;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = tbl AND attname = 'tenant_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'erp_secure_table: % has no tenant_id column (BR-14)', tbl;
  END IF;

  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = tbl AND polname = 'tenant_isolation') THEN
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s USING (tenant_id = erp_current_tenant()) WITH CHECK (tenant_id = erp_current_tenant())',
      tbl);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO erp_app', tbl);
    FOR seq IN
      SELECT d.objid::regclass FROM pg_depend d JOIN pg_class c ON c.oid = d.objid
      WHERE d.refobjid = tbl AND d.classid = 'pg_class'::regclass AND c.relkind = 'S' AND d.deptype IN ('a', 'i')
    LOOP
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO erp_app', seq);
    END LOOP;
  END IF;

  IF is_document AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = tbl AND tgname = rel || '_no_delete') THEN
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION erp_forbid_delete()', rel || '_no_delete', tbl);
  END IF;
END $$;
