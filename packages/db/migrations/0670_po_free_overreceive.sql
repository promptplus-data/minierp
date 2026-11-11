-- Purchase orders, round 2:
--  * free goods (ของแถม): a PO line or a goods-receipt line can be free. A free line costs 0 (FIFO lot at 0) and
--    is left out of the AP bill amount. A free GR line links only to a free PO line.
--  * over-receipt against a PO: allowed with a note, kept on the goods receipt.

ALTER TABLE purchase_order_lines ADD COLUMN IF NOT EXISTS free boolean NOT NULL DEFAULT false;
ALTER TABLE gr_lines ADD COLUMN IF NOT EXISTS free boolean NOT NULL DEFAULT false;
ALTER TABLE stock_docs ADD COLUMN IF NOT EXISTS over_receive_note text;
