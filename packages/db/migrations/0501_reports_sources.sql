-- Group E (reports): plug-in views that point the M11 / M12 reports at the tables the other groups built.
-- security_invoker: the caller's RLS applies, so a shop sees only its own rows. Read-only; no data is copied.

-- Purchase documents for the input VAT report and the purchase book: AP bills raised by goods receipts (M18).
-- base7 / exempt are AFTER the bill discount (VAT is charged on the discounted amount, core purchaseBill); `discount` is
-- kept apart so the journal can show it. Opening balances are not purchases of the period.
CREATE VIEW rpt_purchase_docs WITH (security_invoker = true) AS
  SELECT b.tenant_id, b.id, b.gr_doc_id, b.date, b.no, b.vendor_invoice_no,
         v.code AS vendor_code, v.name AS vendor_name, v.tax_id, v.branch,
         CASE WHEN b.vat > 0 THEN b.base - b.discount ELSE 0 END AS base7,
         CASE WHEN b.vat > 0 THEN 0 ELSE b.base - b.discount END AS exempt,
         b.vat, b.total, b.status, b.discount
    FROM ap_bills b JOIN vendors v ON v.id = b.vendor_id
   WHERE b.source = 'gr';
GRANT SELECT ON rpt_purchase_docs TO PUBLIC;

-- Goods delivered (delivery-file drafts) that nobody has confirmed yet (M05).
CREATE VIEW rpt_gr_pending WITH (security_invoker = true) AS
  SELECT tenant_id, id, dn_no, received_on::timestamptz AS delivered_at
    FROM gr_drafts WHERE status = 'draft';
GRANT SELECT ON rpt_gr_pending TO PUBLIC;

-- Open receivables: tax invoices with a balance, due date from the B2B invoice (M10); POS credit sales fall back to the bill date.
CREATE VIEW rpt_ar_open WITH (security_invoker = true) AS
  SELECT d.tenant_id, d.id, d.no, coalesce(c.name, d.customer_name) AS customer, d.ar_balance AS balance,
         coalesce(si.due_date, d.date) AS due_date
    FROM docs d
    LEFT JOIN sales_invoices si ON si.doc_id = d.id
    LEFT JOIN customers c ON c.id = d.customer_id
   WHERE d.status = 'active' AND d.ar_balance > 0;
GRANT SELECT ON rpt_ar_open TO PUBLIC;

-- AP bills by period (VAT report, purchase book) and open pending drafts.
CREATE INDEX IF NOT EXISTS ap_bills_tenant_date ON ap_bills (tenant_id, date);
