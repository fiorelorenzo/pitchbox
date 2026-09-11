CREATE TABLE "operator_voice_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"platform_id" integer NOT NULL,
	"text" text NOT NULL,
	"posted_at" timestamp with time zone,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operator_voice_messages" ADD CONSTRAINT "operator_voice_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_voice_messages" ADD CONSTRAINT "operator_voice_messages_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_voice_messages_org_external_unique" ON "operator_voice_messages" USING btree ("organization_id","external_id");