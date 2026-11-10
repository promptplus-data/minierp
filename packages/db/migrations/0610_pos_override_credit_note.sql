-- POS (M07): bill note, discount reason, manager-override approvals, credit sales into AR.

-- Every document carries a free note (POS: set in the payment dialog, printed on the slip). Owned by POS.
ALTER TABLE docs ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
-- Reason chip (+ text) required whenever a POS bill has a manual discount or a changed price.
ALTER TABLE docs ADD COLUMN IF NOT EXISTS disc_reason text;

-- Manager override: a manager / owner PIN verified once when the cashier enters a discount or a price over the
-- role cap, returning this row's id as a short-lived token. The sale carries it; the sale is accepted while its
-- discount stays within max_amount / max_pct and every changed price is >= the approved one. Single use.
CREATE TABLE pos_disc_approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  shift_id    uuid NOT NULL REFERENCES shifts(id),
  approver_id uuid NOT NULL REFERENCES users(id),
  max_amount  numeric(14,2) NOT NULL DEFAULT 0,
  max_pct     numeric(9,4) NOT NULL DEFAULT 0,
  -- [{productId, unitIdx, price}] lowest approved unit prices
  prices      jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason      text,
  expires_at  timestamptz NOT NULL,
  used_doc_id uuid REFERENCES docs(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pos_disc_approvals_shift ON pos_disc_approvals (tenant_id, shift_id);
SELECT erp_secure_table('pos_disc_approvals', true);

-- POS credit sale (เงินเชื่อ): the bill gets a sales_invoices row (kind credit, source pos) so it is a receivable.
ALTER TABLE sales_invoices DROP CONSTRAINT IF EXISTS sales_invoices_source_check;
ALTER TABLE sales_invoices ADD CONSTRAINT sales_invoices_source_check
  CHECK (source IN ('delivery','direct','installment','deposit','forfeit','abb','pos'));
