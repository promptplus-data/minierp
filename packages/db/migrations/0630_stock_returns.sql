-- Stock workstream (0630-0639): damaged-goods warehouse, per-line return condition, partial stock-count approval / recount,
-- notes on adjust requests and credit notes.

-- ---------- warehouses: kind ----------
-- 'damaged' (คลังของเสีย) holds defective returned goods: never POS, never sellable (sales / DO / invoices / production refuse it),
-- excluded from available stock. Stock leaves it only by transfer, write-off (adjust request with approval) or issue.
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'normal';
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;
ALTER TABLE warehouses ADD CONSTRAINT warehouses_kind CHECK (kind IN ('normal','damaged'));
ALTER TABLE warehouses ADD CONSTRAINT warehouses_damaged_not_pos CHECK (kind <> 'damaged' OR NOT is_pos);
-- At most one system-created damaged warehouse per shop (auto-created on the first damaged return; concurrent returns
-- race on this index and re-read the winner).
CREATE UNIQUE INDEX IF NOT EXISTS warehouses_tenant_system_damaged ON warehouses (tenant_id) WHERE kind = 'damaged' AND is_system;

-- ---------- returns (credit notes) ----------
-- Per-line condition of returned goods: good → sellable warehouse, damaged → damaged warehouse (both at original FIFO cost).
ALTER TABLE doc_lines ADD COLUMN IF NOT EXISTS return_condition text;
ALTER TABLE doc_lines ADD CONSTRAINT doc_lines_return_condition CHECK (return_condition IS NULL OR return_condition IN ('good','damaged'));
-- Free note typed on the return screen. TODO(merge): unify with docs.note once the POS workstream adds it.
ALTER TABLE docs ADD COLUMN IF NOT EXISTS cn_note text;

-- ---------- adjustment requests ----------
ALTER TABLE adjust_requests ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
-- lines[i].state ('approved' | 'rejected' | 'recount') is written when a request is decided line by line.

-- ---------- stock counts: partial approval and recount (REQ-M06-06) ----------
-- Line state: counting (editable) → review (variance waiting for approval) → approved / rejected, or back to counting
-- (สั่งนับใหม่). 'done' = no variance or not counted at submit. Moves during the whole round stay netted against the
-- snapshot taken at open, so a recount compares with snapshot + every move since the round opened.
ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS round integer NOT NULL DEFAULT 1;
ALTER TABLE stock_count_lines ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'counting';
ALTER TABLE stock_count_lines ADD CONSTRAINT stock_count_lines_state CHECK (state IN ('counting','review','approved','rejected','done'));
ALTER TABLE stock_count_lines ADD COLUMN IF NOT EXISTS round integer NOT NULL DEFAULT 1;
ALTER TABLE stock_count_lines ADD COLUMN IF NOT EXISTS prev_counted_qty numeric(14,4);
ALTER TABLE stock_count_lines ADD COLUMN IF NOT EXISTS adjust_request_id uuid REFERENCES adjust_requests(id);
-- Rounds submitted before this migration: lines in their adjustment request follow the request, the rest are final.
UPDATE stock_count_lines l
   SET state = CASE a.status WHEN 'pending' THEN 'review' WHEN 'approved' THEN 'approved' ELSE 'rejected' END, adjust_request_id = a.id
  FROM stock_counts c JOIN adjust_requests a ON a.id = c.adjust_request_id
 WHERE c.id = l.count_id AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.lines) e WHERE e->>'productId' = l.product_id::text);
UPDATE stock_count_lines l SET state = 'done' FROM stock_counts c
 WHERE c.id = l.count_id AND c.status <> 'counting' AND l.state = 'counting';

-- Reserved stock (REQ-M06-01): open sales-order lines and their delivered quantity.
CREATE INDEX IF NOT EXISTS sales_order_lines_product ON sales_order_lines (tenant_id, product_id);
