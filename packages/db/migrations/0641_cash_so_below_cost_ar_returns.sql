-- Round 4 sales (owner requests 4, 5, 9).
-- 5. BR-16 below-cost approver chosen by the shop: owner (default) / owner_or_manager / none (flag + audit only).
--    On tenants so /api/meta can give every screen (POS, sales, promotions) the same rule.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS below_cost_approver text NOT NULL DEFAULT 'owner'
  CHECK (below_cost_approver IN ('owner', 'owner_or_manager', 'none'));

-- 9b. A credit note against a bill that is still owed first reduces that bill's receivable (up to what is owed);
--     ar_applied is that part. The rest is refunded (docs.payments, cash / transfer) or, with refund = 'credit',
--     stays as a customer credit (total - ar_applied). Older credit-refund notes applied their whole total.
ALTER TABLE docs ADD COLUMN IF NOT EXISTS ar_applied numeric(14,2) NOT NULL DEFAULT 0;
UPDATE docs SET ar_applied = total WHERE type = 'CN' AND refund = 'credit' AND ar_applied = 0;
