CREATE TABLE IF NOT EXISTS "adjust_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"no" text NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"lines" jsonb NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"result_doc_no" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adjust_requests_status" CHECK ("adjust_requests"."status" in ('pending','approved','rejected'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"user_name" text NOT NULL,
	"action" text NOT NULL,
	"object" text NOT NULL,
	"ref" text,
	"detail" text DEFAULT '' NOT NULL,
	"chain_seq" bigint,
	"prev_hash" text,
	"hash" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"tax_id" text,
	"branch" text,
	"phone" text,
	"grp" text DEFAULT 'retail' NOT NULL,
	"credit_limit" numeric(14, 2) DEFAULT '0' NOT NULL,
	"term" jsonb DEFAULT '{"t":"cash"}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"paired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "doc_counters" (
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"period" text NOT NULL,
	"device" text DEFAULT '' NOT NULL,
	"seq" integer NOT NULL,
	CONSTRAINT "doc_counters_tenant_id_type_period_device_pk" PRIMARY KEY("tenant_id","type","period","device")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "doc_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"doc_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"unit_name" text NOT NULL,
	"unit_factor" numeric(14, 4) NOT NULL,
	"qty" numeric(14, 4) NOT NULL,
	"base_qty" numeric(14, 4) NOT NULL,
	"unit_price" numeric(14, 4) NOT NULL,
	"discount" numeric(14, 2) NOT NULL,
	"net" numeric(14, 2) NOT NULL,
	"net_after_bill" numeric(14, 2) NOT NULL,
	"vat" text NOT NULL,
	"returned_qty" numeric(14, 4) DEFAULT '0' NOT NULL,
	"cogs" numeric(14, 2),
	"src_line_id" uuid,
	CONSTRAINT "doc_lines_returned" CHECK ("doc_lines"."returned_qty" >= 0 and "doc_lines"."returned_qty" <= "doc_lines"."qty")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"no" text NOT NULL,
	"type" text NOT NULL,
	"date" date NOT NULL,
	"customer_id" uuid,
	"customer_name" text NOT NULL,
	"customer_phone" text,
	"vat_mode" text NOT NULL,
	"warehouse_id" uuid,
	"shift_id" uuid,
	"device_id" text,
	"gross" numeric(14, 2) NOT NULL,
	"line_disc" numeric(14, 2) NOT NULL,
	"bill_disc" numeric(14, 2) NOT NULL,
	"base7" numeric(14, 2) NOT NULL,
	"exempt" numeric(14, 2) NOT NULL,
	"vat" numeric(14, 2) NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"ar_balance" numeric(14, 2) DEFAULT '0' NOT NULL,
	"payments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"void_by" uuid,
	"void_at" timestamp with time zone,
	"void_reason" text,
	"created_by" uuid NOT NULL,
	"ref_doc_id" uuid,
	"ref_no" text,
	"idempotency_key" uuid,
	"member_id" text,
	"refund" text,
	"condition" text,
	"reason" text,
	"search_text" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docs_status" CHECK ("docs"."status" in ('active','void')),
	CONSTRAINT "docs_vat_mode" CHECK ("docs"."vat_mode" in ('inc','exc','none'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pairing_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"barcode" text,
	"category" text DEFAULT '' NOT NULL,
	"is_scg" boolean DEFAULT false NOT NULL,
	"kind" text DEFAULT 'stock' NOT NULL,
	"vat" text DEFAULT 'v7' NOT NULL,
	"price" numeric(14, 2) NOT NULL,
	"cost" numeric(14, 4) DEFAULT '0' NOT NULL,
	"units" jsonb NOT NULL,
	"reorder_point" numeric(14, 4) DEFAULT '0' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_kind" CHECK ("products"."kind" in ('stock','service')),
	CONSTRAINT "products_vat" CHECK ("products"."vat" in ('v7','exempt'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shift_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"note" text NOT NULL,
	"user_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_moves_type" CHECK ("shift_moves"."type" in ('in','out')),
	CONSTRAINT "shift_moves_amount" CHECK ("shift_moves"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"no" text NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"float" numeric(14, 2) NOT NULL,
	"summary" jsonb,
	"counted" numeric(14, 2),
	"expected" numeric(14, 2),
	"diff" numeric(14, 2),
	"note" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"no" text NOT NULL,
	"type" text NOT NULL,
	"date" date NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"to_warehouse_id" uuid,
	"vendor_id" uuid,
	"vendor_invoice_no" text,
	"delivery_no" text,
	"reason" text,
	"lines" jsonb NOT NULL,
	"total" numeric(14, 2),
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_lots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_lots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"qty_in" numeric(14, 4) NOT NULL,
	"remaining" numeric(14, 4) NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL,
	"ref" text NOT NULL,
	"source_lot_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_lots_remaining_nonneg" CHECK ("stock_lots"."remaining" >= 0),
	CONSTRAINT "stock_lots_remaining_le_in" CHECK ("stock_lots"."remaining" <= "stock_lots"."qty_in")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_move_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"move_id" uuid NOT NULL,
	"lot_id" bigint NOT NULL,
	"qty" numeric(14, 4) NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"doc_type" text NOT NULL,
	"doc_no" text NOT NULL,
	"doc_id" uuid NOT NULL,
	"doc_line_id" uuid,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"qty" numeric(14, 4) NOT NULL,
	"cost" numeric(14, 2) NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"tax_id" text DEFAULT '' NOT NULL,
	"branch" text DEFAULT 'สำนักงานใหญ่' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"vat_registered" boolean DEFAULT true NOT NULL,
	"b2b_vat_mode" text DEFAULT 'exc' NOT NULL,
	"doc_patterns" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"username" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"password_hash" text NOT NULL,
	"pin_hash" text,
	"status" text DEFAULT 'active' NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_status" CHECK ("users"."status" in ('active','resigned'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"tax_id" text,
	"branch" text,
	"phone" text,
	"term" jsonb DEFAULT '{"t":"cash"}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_pos" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "adjust_requests_tenant_no" ON "adjust_requests" USING btree ("tenant_id","no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_tenant_id" ON "audit_log" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customers_tenant_code" ON "customers" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "doc_lines_doc" ON "doc_lines" USING btree ("tenant_id","doc_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "docs_tenant_no" ON "docs" USING btree ("tenant_id","no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "docs_tenant_idem" ON "docs" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "docs_tenant_created" ON "docs" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "docs_ref" ON "docs" USING btree ("tenant_id","ref_doc_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "docs_shift" ON "docs" USING btree ("tenant_id","shift_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pairing_codes_code" ON "pairing_codes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_tenant_sku" ON "products" USING btree ("tenant_id","sku");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shifts_tenant_no" ON "shifts" USING btree ("tenant_id","no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shifts_one_open_per_user" ON "shifts" USING btree ("tenant_id","user_id") WHERE "shifts"."closed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_docs_tenant_no" ON "stock_docs" USING btree ("tenant_id","no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_docs_vendor_invoice" ON "stock_docs" USING btree ("tenant_id","vendor_id","vendor_invoice_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_lots_pw" ON "stock_lots" USING btree ("tenant_id","product_id","warehouse_id","received_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_move_lots_move" ON "stock_move_lots" USING btree ("tenant_id","move_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_moves_doc" ON "stock_moves" USING btree ("tenant_id","doc_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_moves_line" ON "stock_moves" USING btree ("tenant_id","doc_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_tenant_username" ON "users" USING btree ("tenant_id","username");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendors_tenant_code" ON "vendors" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "warehouses_tenant_code" ON "warehouses" USING btree ("tenant_id","code");