ALTER TABLE "operator_voice_samples" ADD COLUMN "genre" text DEFAULT 'post' NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_voice_samples" ADD COLUMN "source" text DEFAULT 'capture' NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_voice_samples" ADD COLUMN "context" text;