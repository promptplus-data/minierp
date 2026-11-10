-- Customers created from POS / quotation / sales order carry an address and a free note (REQ: quick-create customer).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address text NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
