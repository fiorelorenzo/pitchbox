ALTER TABLE "contact_history" ADD COLUMN "uncontactable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_history" ADD COLUMN "uncontactable_reason" text;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "undeliverable_reason" text;