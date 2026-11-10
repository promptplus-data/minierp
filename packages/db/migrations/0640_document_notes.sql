-- REQ (cross-cutting): every document created in purchasing / retail / HR carries a free note (หมายเหตุ), stored and
-- shown on its detail and print. The goods receipt keeps its note in stock_docs.reason (already used by transfers);
-- the AP bill created from it copies the note and can be edited later. Payment vouchers and MOs already had one.
ALTER TABLE ap_bills            ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
ALTER TABLE vendor_returns      ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
ALTER TABLE import_batches      ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
ALTER TABLE retail_promos       ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
ALTER TABLE retail_price_lists  ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
ALTER TABLE leave_requests      ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
ALTER TABLE payroll_runs        ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
