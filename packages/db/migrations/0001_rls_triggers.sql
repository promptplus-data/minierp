-- Hand-written: tenant isolation (BR-14/M19), no hard delete (BR-03/BR-22/BR-18),
-- append-only hash-chained audit log (BR-18), returns search index (REQ-M08-06), app role grants.

-- ---------- returns bill picker: trigram index ----------
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS docs_search_trgm ON docs USING gin (search_text gin_trgm_ops);

-- ---------- tenant isolation ----------
-- The server sets app.tenant_id with set_config(..., true) at the start of every transaction.
-- Unset / empty -> NULL -> no rows match.
CREATE OR REPLACE FUNCTION erp_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','warehouses','products','customers','vendors','doc_counters','shifts','shift_moves',
    'docs','doc_lines','stock_docs','stock_lots','stock_moves','stock_move_lots','adjust_requests','pairing_codes','devices','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE: the table owner is subject to the policy too (matters when the app connects as the owner, non-superuser).
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = erp_current_tenant()) WITH CHECK (tenant_id = erp_current_tenant())', t);
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants USING (id = erp_current_tenant()) WITH CHECK (id = erp_current_tenant());

-- Login has no tenant yet: the server sets app.auth_lookup = 'on' (transaction-local) only inside the
-- login / pairing lookup transaction, which may then read users and tenants across tenants. Read-only.
CREATE POLICY auth_lookup ON users FOR SELECT USING (current_setting('app.auth_lookup', true) = 'on');
CREATE POLICY auth_lookup ON tenants FOR SELECT USING (current_setting('app.auth_lookup', true) = 'on');
CREATE POLICY auth_lookup ON pairing_codes FOR SELECT USING (current_setting('app.auth_lookup', true) = 'on');

-- ---------- no hard delete ----------
CREATE OR REPLACE FUNCTION erp_forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'rows in % are never deleted (BR-03/BR-18/BR-22); void or deactivate instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['docs','doc_lines','stock_docs','stock_lots','stock_moves','stock_move_lots','shifts','shift_moves',
    'adjust_requests','users','tenants','products','customers','vendors','warehouses']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION erp_forbid_delete()', t || '_no_delete', t);
  END LOOP;
END $$;

-- ---------- audit log: append-only + per-tenant hash chain ----------
CREATE OR REPLACE FUNCTION erp_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (BR-18): % is not allowed', TG_OP USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION erp_audit_append_only();

-- hash = sha256(prev_hash || canonical row text). A per-tenant advisory lock (held to commit) makes
-- chain_seq / prev_hash a single line even with concurrent writers.
CREATE OR REPLACE FUNCTION erp_audit_row_text(a audit_log) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('|', a.chain_seq::text, a.tenant_id::text, extract(epoch FROM a.at)::text, coalesce(a.user_id::text, ''),
                   a.user_name, a.action, a.object, coalesce(a.ref, ''), a.detail)
$$;

CREATE OR REPLACE FUNCTION erp_audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_seq bigint;
  last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('erp_audit:' || NEW.tenant_id::text, 0));
  SELECT chain_seq, hash INTO last_seq, last_hash FROM audit_log
    WHERE tenant_id = NEW.tenant_id ORDER BY chain_seq DESC NULLS LAST LIMIT 1;
  NEW.chain_seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := coalesce(last_hash, '');
  NEW.hash := encode(sha256(convert_to(NEW.prev_hash || erp_audit_row_text(NEW), 'UTF8')), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION erp_audit_chain();
CREATE UNIQUE INDEX audit_log_chain_seq ON audit_log (tenant_id, chain_seq);

-- Recomputes the chain; returns the first broken chain_seq or NULL when intact.
CREATE OR REPLACE FUNCTION erp_audit_verify(t uuid) RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_log;
  prev text := '';
BEGIN
  FOR r IN SELECT * FROM audit_log WHERE tenant_id = t ORDER BY chain_seq LOOP
    IF r.prev_hash IS DISTINCT FROM prev
       OR r.hash IS DISTINCT FROM encode(sha256(convert_to(prev || erp_audit_row_text(r), 'UTF8')), 'hex') THEN
      RETURN r.chain_seq;
    END IF;
    prev := r.hash;
  END LOOP;
  RETURN NULL;
END $$;

-- ---------- application role ----------
-- The server runs every request transaction as erp_app (SET LOCAL ROLE) so RLS applies even when the
-- connection user is a superuser (superusers always bypass RLS). erp_app has no DELETE / TRUNCATE at all
-- and cannot UPDATE audit_log. If the migrating user may not create roles, the server falls back to
-- connecting as the (non-superuser) owner, which FORCE ROW LEVEL SECURITY still restricts.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    BEGIN
      CREATE ROLE erp_app NOLOGIN;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'erp_app role not created (no CREATEROLE); relying on FORCE ROW LEVEL SECURITY';
    END;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    BEGIN
      EXECUTE format('GRANT erp_app TO %I', current_user);
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'could not grant erp_app to %: %', current_user, SQLERRM;
    END;
    GRANT USAGE ON SCHEMA public TO erp_app;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO erp_app;
    REVOKE UPDATE ON audit_log FROM erp_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO erp_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO erp_app;
  END IF;
END $$;
