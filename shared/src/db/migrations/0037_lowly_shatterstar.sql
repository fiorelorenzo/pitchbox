ALTER TABLE "extension_devices" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "extension_devices" ADD CONSTRAINT "extension_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;