ALTER TABLE "ledger"."journal_entries" ALTER COLUMN "booked_by_user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "ledger"."journal_entry_revisions" ALTER COLUMN "changed_by_user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "ledger"."ledger_advisor_balances" ALTER COLUMN "uploaded_by_user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "ledger"."ledger_filings" ALTER COLUMN "created_by_user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "ledger"."ledger_handovers" ALTER COLUMN "created_by_user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "ledger"."ledger_open_item_matches" ALTER COLUMN "created_by_user_id" SET DATA TYPE text;