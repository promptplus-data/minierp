-- M19-09 optional cloud backup (on-prem; off by default) and M14-05 read-only support access with shop consent (cloud).

CREATE TABLE backup_config (
  tenant_id        uuid PRIMARY KEY REFERENCES tenants(id),
  enabled          boolean NOT NULL DEFAULT false,
  provider         text,                          -- s3 | gdrive | onedrive
  -- provider settings: bucket / endpoint / region / prefix / keys, or OAuth refresh token + folder.
  -- Stays on the shop's own server; never sent to SCG.
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- scrypt(passphrase, key_salt) -> AES-256 key, kept on the shop's own server so scheduled backups can run
  -- unattended. The passphrase itself is never stored; restoring on a new machine needs the passphrase again.
  key_salt         text,
  derived_key      text,
  schedule         text NOT NULL DEFAULT 'daily',  -- off | daily
  last_success_at  timestamptz,
  last_failure_at  timestamptz,
  last_error       text,
  last_file        text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_config_provider CHECK (provider IS NULL OR provider IN ('s3','gdrive','onedrive')),
  CONSTRAINT backup_config_schedule CHECK (schedule IN ('off','daily'))
);
SELECT erp_secure_table('backup_config');

CREATE TABLE backup_runs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  at         timestamptz NOT NULL DEFAULT now(),
  provider   text NOT NULL,
  trigger    text NOT NULL,        -- manual | schedule
  file_name  text,
  bytes      bigint,
  status     text NOT NULL,        -- ok | failed
  error      text,
  user_id    uuid REFERENCES users(id),
  CONSTRAINT backup_runs_status CHECK (status IN ('ok','failed'))
);
CREATE INDEX backup_runs_list ON backup_runs (tenant_id, at DESC, id);
SELECT erp_secure_table('backup_runs', true);

-- Shop consent for SCG support to look at the shop read-only until expires_at (REQ-M14-05).
CREATE TABLE support_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  granted_by  uuid NOT NULL REFERENCES users(id),
  note        text NOT NULL DEFAULT '',
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_grants_tenant ON support_grants (tenant_id, expires_at DESC);
SELECT erp_secure_table('support_grants', true);
