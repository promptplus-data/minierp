-- The on-prem edition (Prompt OS) sends nothing to SCG, so the M19-10 sales-summary share is gone on both sides:
-- the on-prem send log, the cloud inbox and the receiver's lookup policy on the license registry.
DROP POLICY IF EXISTS receiver_lookup ON license_registry;
DROP TABLE IF EXISTS sales_share_inbox;
DROP TABLE IF EXISTS sales_shares;
