-- Customer master: a customer can be set inactive (kept for old documents, hidden from pickers).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

-- Shop roles managed by the owner:
--  * builtin = true: the shop's own permission set for a built-in role (key = manager, cashier, ...); no row = default.
--  * builtin = false: a role the owner created (e.g. "ฝ่ายบุคคล"); `base` is the built-in role it behaves as where a
--    rule is about the role itself (approver PIN, labels), `grants` decides every permission.
CREATE TABLE shop_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  key         text NOT NULL,
  name        text NOT NULL,
  base        text NOT NULL CHECK (base IN ('manager','cashier','sales','wh','driver','acct','extacct')),
  builtin     boolean NOT NULL DEFAULT false,
  grants      jsonb NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);
SELECT erp_secure_table('shop_roles', false);
ALTER TABLE users ADD COLUMN IF NOT EXISTS shop_role_id uuid REFERENCES shop_roles(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_type text;  -- ช่าง / เจ้าของบ้าน / งานโครงการ / บริษัทรับเหมา or the shop's own words
