-- M17 HR: employees (with their login user, REQ-M01-10), leave, monthly payroll; per-shop admin settings.
-- Employees, leave requests and payroll rows are never deleted (BR-18): resign = status, reject = status.

-- ---------- per-shop settings owned by the admin group (SSO ceiling REQ-M01-11 / M17-02) ----------
CREATE TABLE adm_settings (
  tenant_id          uuid PRIMARY KEY REFERENCES tenants(id),
  sso_rate           numeric(6,4)  NOT NULL DEFAULT 0.05,
  sso_cap            numeric(14,2) NOT NULL DEFAULT 17500,
  sso_floor          numeric(14,2) NOT NULL DEFAULT 1650,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adm_settings_sso CHECK (sso_rate >= 0 AND sso_rate <= 1 AND sso_cap > 0 AND sso_floor >= 0)
);
SELECT erp_secure_table('adm_settings');

-- ---------- employees (REQ-M17-01) ----------
CREATE TABLE employees (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  code           text NOT NULL,
  name           text NOT NULL,
  position       text NOT NULL DEFAULT '',
  -- monthly / daily / parttime / external (e.g. outside accountant) / owner
  emp_type       text NOT NULL DEFAULT 'monthly',
  start_date     date NOT NULL,
  salary         numeric(14,2) NOT NULL DEFAULT 0,
  daily_rate     numeric(14,2) NOT NULL DEFAULT 0,
  commission_pct numeric(6,2)  NOT NULL DEFAULT 0,
  sso            boolean NOT NULL DEFAULT true,
  bank_account   text NOT NULL DEFAULT '',
  national_id    text NOT NULL DEFAULT '',
  phone          text NOT NULL DEFAULT '',
  -- yearly entitlement per leave type in days: {"sick":30,"personal":3,"vacation":6,"maternity":98,"other":0}
  leave_ent      jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'active',
  resigned_at    date,
  resign_reason  text,
  user_id        uuid REFERENCES users(id),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employees_status CHECK (status IN ('active','resigned')),
  CONSTRAINT employees_type CHECK (emp_type IN ('monthly','daily','parttime','external','owner')),
  CONSTRAINT employees_pay CHECK (salary >= 0 AND daily_rate >= 0 AND commission_pct >= 0 AND commission_pct <= 100),
  UNIQUE (tenant_id, code)
);
CREATE UNIQUE INDEX employees_tenant_user ON employees (tenant_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX employees_tenant_name ON employees (tenant_id, status, code, id);
SELECT erp_secure_table('employees', true);

-- ---------- leave (REQ-M17-04/05) ----------
CREATE TABLE leave_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  no           text NOT NULL,
  employee_id  uuid NOT NULL REFERENCES employees(id),
  leave_type   text NOT NULL,
  from_date    date NOT NULL,
  to_date      date NOT NULL,
  half_day     boolean NOT NULL DEFAULT false,
  days         numeric(6,1) NOT NULL,
  reason       text NOT NULL DEFAULT '',
  -- over-entitlement handling: days beyond the yearly entitlement, and whether they are deducted from pay
  over_days    numeric(6,1) NOT NULL DEFAULT 0,
  deduct       boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'pending',
  requested_by uuid NOT NULL REFERENCES users(id),
  decided_by   uuid REFERENCES users(id),
  decided_at   timestamptz,
  decide_note  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leave_requests_type CHECK (leave_type IN ('sick','personal','vacation','maternity','other','unpaid')),
  CONSTRAINT leave_requests_status CHECK (status IN ('pending','approved','rejected')),
  CONSTRAINT leave_requests_days CHECK (days > 0 AND over_days >= 0 AND over_days <= days AND to_date >= from_date),
  UNIQUE (tenant_id, no)
);
CREATE INDEX leave_requests_emp ON leave_requests (tenant_id, employee_id, from_date);
CREATE INDEX leave_requests_list ON leave_requests (tenant_id, created_at DESC, id);
SELECT erp_secure_table('leave_requests', true);

-- ---------- payroll (REQ-M17-02/03/06) ----------
CREATE TABLE payroll_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  period       text NOT NULL,                 -- 'YYYY-MM'
  status       text NOT NULL DEFAULT 'draft', -- draft -> approved -> paid (locked)
  sso_rate     numeric(6,4)  NOT NULL,
  sso_cap      numeric(14,2) NOT NULL,
  sso_floor    numeric(14,2) NOT NULL,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  approved_by  uuid REFERENCES users(id),
  approved_at  timestamptz,
  paid_by      uuid REFERENCES users(id),
  paid_at      timestamptz,
  pay_date     date,
  CONSTRAINT payroll_runs_status CHECK (status IN ('draft','approved','paid')),
  CONSTRAINT payroll_runs_period CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  UNIQUE (tenant_id, period)
);
SELECT erp_secure_table('payroll_runs', true);

CREATE TABLE payroll_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  run_id          uuid NOT NULL REFERENCES payroll_runs(id),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  -- snapshot of the employee at calculation time (the slip prints this)
  emp_code        text NOT NULL,
  emp_name        text NOT NULL,
  emp_position    text NOT NULL,
  emp_type        text NOT NULL,
  bank_account    text NOT NULL,
  pay             text NOT NULL,                 -- monthly | daily
  rate            numeric(14,2) NOT NULL,        -- salary or daily rate used
  commission_pct  numeric(6,2)  NOT NULL,
  sso_enrolled    boolean NOT NULL,
  -- inputs
  days            numeric(6,1) NOT NULL DEFAULT 26,
  ot              numeric(14,2) NOT NULL DEFAULT 0,
  allowance       numeric(14,2) NOT NULL DEFAULT 0,
  advance         numeric(14,2) NOT NULL DEFAULT 0,
  tax_override    numeric(14,2),
  unpaid_days     numeric(6,1)  NOT NULL DEFAULT 0,
  commission_base numeric(14,2) NOT NULL DEFAULT 0,
  -- results (core.payRow)
  base            numeric(14,2) NOT NULL,
  commission      numeric(14,2) NOT NULL,
  unpaid_amt      numeric(14,2) NOT NULL,
  gross           numeric(14,2) NOT NULL,
  sso             numeric(14,2) NOT NULL,
  tax             numeric(14,2) NOT NULL,
  net             numeric(14,2) NOT NULL,
  CONSTRAINT payroll_lines_inputs CHECK (days >= 0 AND ot >= 0 AND allowance >= 0 AND advance >= 0 AND (tax_override IS NULL OR tax_override >= 0)),
  UNIQUE (run_id, employee_id)
);
CREATE INDEX payroll_lines_run ON payroll_lines (tenant_id, run_id, emp_code);
SELECT erp_secure_table('payroll_lines', true);

-- Locked after paid (REQ-M17-02): a paid run never changes; lines change only while the run is a draft.
CREATE OR REPLACE FUNCTION hr_payroll_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  -- Whole-shop import (M19-07) replays paid history inside the new tenant's transaction.
  IF coalesce(current_setting('app.bulk_import', true), '') = 'on' AND TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'payroll_runs' THEN
    IF OLD.status = 'paid' THEN
      RAISE EXCEPTION 'payroll % is paid and locked (REQ-M17-02)', OLD.period USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO st FROM payroll_runs WHERE id = NEW.run_id;
  IF st IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'payroll lines change only while the run is a draft (status %)', st USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_runs_lock BEFORE UPDATE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock();
CREATE TRIGGER payroll_lines_lock BEFORE INSERT OR UPDATE ON payroll_lines FOR EACH ROW EXECUTE FUNCTION hr_payroll_lock();

-- Labour cost per month for reports (REQ-M17-06 -> REQ-M11-06): approved or paid runs only.
-- security_invoker: the caller's RLS applies, so a shop sees only its own months.
CREATE VIEW hr_labour_cost_monthly WITH (security_invoker = true) AS
  SELECT r.tenant_id, r.period, r.status,
         coalesce(sum(l.gross), 0)::numeric(14,2) AS gross,
         coalesce(sum(l.sso), 0)::numeric(14,2)   AS employer_sso,
         (coalesce(sum(l.gross), 0) + coalesce(sum(l.sso), 0))::numeric(14,2) AS total,
         count(l.id)::int AS headcount
    FROM payroll_runs r LEFT JOIN payroll_lines l ON l.run_id = r.id
   WHERE r.status IN ('approved','paid')
   GROUP BY r.tenant_id, r.period, r.status;
GRANT SELECT ON hr_labour_cost_monthly TO PUBLIC;
