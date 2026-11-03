-- M02 terms of use / consent (BR-15). A shop flagged adm_terms_required (shops opened by SCG Admin) can be used only
-- after its owner accepted the current terms version. Acceptances are never changed or deleted (BR-18).
ALTER TABLE tenants ADD COLUMN adm_terms_required boolean NOT NULL DEFAULT false;

CREATE TABLE terms_acceptances (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  version      text NOT NULL,
  signer_name  text NOT NULL,
  signer_title text NOT NULL DEFAULT '',
  consents     jsonb NOT NULL,
  accepted_by  uuid NOT NULL REFERENCES users(id),
  ip           text,
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);
CREATE INDEX terms_acceptances_tenant ON terms_acceptances (tenant_id, accepted_at DESC);
SELECT erp_secure_table('terms_acceptances', true);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    REVOKE UPDATE ON terms_acceptances FROM erp_app;
  END IF;
END $$;
