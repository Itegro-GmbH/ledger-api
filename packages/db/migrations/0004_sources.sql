CREATE TABLE "ledger"."accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"iban" text,
	"bic" text,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"holder" text,
	"platform" text,
	"contact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_tenant_iban_key" UNIQUE("tenant_id","iban"),
	CONSTRAINT "accounts_type_check" CHECK ("ledger"."accounts"."type" in ('bank', 'clearing')),
	CONSTRAINT "accounts_clearing_owner_check" CHECK ("ledger"."accounts"."platform" is null or "ledger"."accounts"."contact_id" is null)
);
--> statement-breakpoint
CREATE TABLE "ledger"."contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"legal_form" text,
	"address_line1" text,
	"address_line2" text,
	"postal_code" text,
	"city" text,
	"country" text DEFAULT 'DE',
	"vat_id" text,
	"tax_number" text,
	"register_court" text,
	"register_number" text,
	"leitweg_id" text,
	"iban" text,
	"bic" text,
	"bank_name" text,
	"account_holder" text,
	"sepa_creditor_id" text,
	"phone" text,
	"email" text,
	"website" text,
	"contact_person" text,
	"customer_number" text,
	"supplier_number" text,
	"payment_terms_days" integer,
	"relation_type" text,
	"notes" text,
	"source" text NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by_user_id" uuid,
	"first_seen_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name_normalized" text NOT NULL,
	"vat_id_normalized" text,
	"iban_normalized" text,
	CONSTRAINT "contacts_relation_type_check" CHECK ("ledger"."contacts"."relation_type" is null or "ledger"."contacts"."relation_type" in ('supplier', 'customer', 'authority', 'insurance', 'bank', 'other')),
	CONSTRAINT "contacts_source_check" CHECK ("ledger"."contacts"."source" in ('auto', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "ledger"."document_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"kind" text NOT NULL,
	"confidence" real NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"explanation" text,
	"matched_by" text NOT NULL,
	"allocated_amount_cents" integer NOT NULL,
	"arbiter_cache_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	CONSTRAINT "document_transactions_document_transaction_key" UNIQUE("document_id","transaction_id"),
	CONSTRAINT "document_transactions_status_check" CHECK ("ledger"."document_transactions"."status" in ('suggested', 'confirmed', 'rejected')),
	CONSTRAINT "document_transactions_kind_check" CHECK ("ledger"."document_transactions"."kind" in ('exact', 'skonto', 'partial', 'collective', 'ai', 'manual')),
	CONSTRAINT "document_transactions_matched_by_check" CHECK ("ledger"."document_transactions"."matched_by" in ('auto', 'ai', 'user'))
);
--> statement-breakpoint
CREATE TABLE "ledger"."documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_ref" text,
	"kind" text NOT NULL,
	"direction" text,
	"title" text,
	"sender" text,
	"summary" text,
	"original_file_name" text,
	"file_url" text,
	"invoice_number" text,
	"document_date" date,
	"due_date" date,
	"service_date" date,
	"service_period_from" date,
	"service_period_to" date,
	"currency" text,
	"total_amount_cents" integer,
	"net_total_cents" integer,
	"tax_total_cents" integer,
	"pass_through_cents" integer,
	"tax_breakdown" jsonb,
	"reverse_charge" boolean,
	"platform" text,
	"contact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_kind_check" CHECK ("ledger"."documents"."kind" in ('letter', 'incoming_invoice', 'outgoing_invoice', 'reminder', 'receipt', 'bank_statement', 'payout_report', 'platform_settlement', 'contract', 'authority_letter', 'other')),
	CONSTRAINT "documents_direction_check" CHECK ("ledger"."documents"."direction" is null or "ledger"."documents"."direction" in ('incoming', 'outgoing', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "ledger"."import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"source_document_id" uuid,
	"statement_from" date,
	"statement_to" date,
	"opening_balance_cents" integer,
	"closing_balance_cents" integer,
	"rows_total" integer NOT NULL,
	"rows_imported" integer NOT NULL,
	"rows_duplicate" integer NOT NULL,
	"balance_mismatch" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batches_source_document_key" UNIQUE("source_document_id")
);
--> statement-breakpoint
CREATE TABLE "ledger"."payment_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"counterparty_name_normalized" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"learned_from_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_aliases_tenant_name_key" UNIQUE("tenant_id","counterparty_name_normalized")
);
--> statement-breakpoint
CREATE TABLE "ledger"."payment_no_document_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"counterparty_name_normalized" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_no_document_rules_tenant_name_key" UNIQUE("tenant_id","counterparty_name_normalized")
);
--> statement-breakpoint
CREATE TABLE "ledger"."settlement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"clearing_account_id" uuid NOT NULL,
	"source_document_id" uuid NOT NULL,
	"transaction_id" uuid,
	"type" text NOT NULL,
	"external_line_id" text NOT NULL,
	"gross_cents" integer,
	"fee_cents" integer,
	"net_cents" integer,
	"currency" text,
	"booking_date" date,
	"payout_id" text,
	"charge_id" text,
	"invoice_id" text,
	"customer_name" text,
	"customer_email" text,
	"product_name" text,
	"country_of_sale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_lines_document_external_key" UNIQUE("source_document_id","external_line_id"),
	CONSTRAINT "settlement_lines_type_check" CHECK ("ledger"."settlement_lines"."type" in ('revenue', 'fee', 'refund', 'payout', 'adjustment'))
);
--> statement-breakpoint
CREATE TABLE "ledger"."transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"booking_date" date NOT NULL,
	"value_date" date,
	"amount_cents" integer NOT NULL,
	"currency" text,
	"credit_debit" text NOT NULL,
	"counterparty_name" text,
	"counterparty_iban" text,
	"counterparty_bic" text,
	"remittance_text" text,
	"end_to_end_id" text,
	"mandate_id" text,
	"creditor_id" text,
	"bank_tx_code" text,
	"bank_reference" text,
	"idempotency_key" text NOT NULL,
	"import_batch_id" uuid,
	"source_document_id" uuid,
	"transfer_group_id" uuid,
	"raw" jsonb,
	"no_document_needed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_account_idempotency_key" UNIQUE("account_id","idempotency_key"),
	CONSTRAINT "transactions_credit_debit_check" CHECK ("ledger"."transactions"."credit_debit" in ('credit', 'debit'))
);
--> statement-breakpoint
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "ledger"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "ledger"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."contacts" ADD CONSTRAINT "contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "ledger"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."document_transactions" ADD CONSTRAINT "document_transactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "ledger"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."document_transactions" ADD CONSTRAINT "document_transactions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "ledger"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "ledger"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."documents" ADD CONSTRAINT "documents_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "ledger"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."import_batches" ADD CONSTRAINT "import_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "ledger"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."import_batches" ADD CONSTRAINT "import_batches_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "ledger"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."payment_aliases" ADD CONSTRAINT "payment_aliases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "ledger"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."payment_aliases" ADD CONSTRAINT "payment_aliases_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "ledger"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."payment_no_document_rules" ADD CONSTRAINT "payment_no_document_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "ledger"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."settlement_lines" ADD CONSTRAINT "settlement_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "ledger"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."settlement_lines" ADD CONSTRAINT "settlement_lines_clearing_account_id_accounts_id_fk" FOREIGN KEY ("clearing_account_id") REFERENCES "ledger"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."settlement_lines" ADD CONSTRAINT "settlement_lines_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "ledger"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."transactions" ADD CONSTRAINT "transactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "ledger"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."transactions" ADD CONSTRAINT "transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "ledger"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger"."transactions" ADD CONSTRAINT "transactions_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "ledger"."import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_tenant_idx" ON "ledger"."accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_tenant_platform_clearing_key" ON "ledger"."accounts" USING btree ("tenant_id","platform") WHERE "ledger"."accounts"."type" = 'clearing';--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_tenant_contact_clearing_key" ON "ledger"."accounts" USING btree ("tenant_id","contact_id") WHERE "ledger"."accounts"."type" = 'clearing';--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_tenant_vat_normalized_key" ON "ledger"."contacts" USING btree ("tenant_id","vat_id_normalized") WHERE "ledger"."contacts"."vat_id_normalized" is not null;--> statement-breakpoint
CREATE INDEX "contacts_tenant_iban_normalized_idx" ON "ledger"."contacts" USING btree ("tenant_id","iban_normalized");--> statement-breakpoint
CREATE INDEX "contacts_tenant_name_normalized_postal_idx" ON "ledger"."contacts" USING btree ("tenant_id","name_normalized","postal_code");--> statement-breakpoint
CREATE INDEX "contacts_tenant_name_idx" ON "ledger"."contacts" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "document_transactions_tenant_status_idx" ON "ledger"."document_transactions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "document_transactions_transaction_idx" ON "ledger"."document_transactions" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "documents_tenant_document_date_idx" ON "ledger"."documents" USING btree ("tenant_id","document_date");--> statement-breakpoint
CREATE INDEX "documents_tenant_contact_idx" ON "ledger"."documents" USING btree ("tenant_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_tenant_external_ref_key" ON "ledger"."documents" USING btree ("tenant_id","external_ref") WHERE "ledger"."documents"."external_ref" is not null;--> statement-breakpoint
CREATE INDEX "import_batches_tenant_account_idx" ON "ledger"."import_batches" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE INDEX "settlement_lines_tenant_idx" ON "ledger"."settlement_lines" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "settlement_lines_clearing_account_idx" ON "ledger"."settlement_lines" USING btree ("clearing_account_id");--> statement-breakpoint
CREATE INDEX "settlement_lines_tenant_type_idx" ON "ledger"."settlement_lines" USING btree ("tenant_id","type");--> statement-breakpoint
CREATE INDEX "settlement_lines_account_type_booking_date_idx" ON "ledger"."settlement_lines" USING btree ("clearing_account_id","type","booking_date");--> statement-breakpoint
CREATE INDEX "transactions_tenant_booking_date_idx" ON "ledger"."transactions" USING btree ("tenant_id","booking_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_account_booking_date_idx" ON "ledger"."transactions" USING btree ("account_id","booking_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_tenant_counterparty_iban_idx" ON "ledger"."transactions" USING btree ("tenant_id","counterparty_iban");--> statement-breakpoint
CREATE INDEX "transactions_tenant_amount_idx" ON "ledger"."transactions" USING btree ("tenant_id","amount_cents");