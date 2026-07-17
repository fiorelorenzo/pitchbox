ALTER TABLE "users" ADD COLUMN "is_instance_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "users" SET "is_instance_admin" = true WHERE "id" = (
  SELECT COALESCE(
    (
      SELECT "m"."user_id"
      FROM "memberships" "m"
      INNER JOIN "organizations" "o" ON "o"."id" = "m"."organization_id"
      WHERE "o"."slug" = 'default' AND "m"."role" = 'owner'
      ORDER BY "m"."id" ASC
      LIMIT 1
    ),
    (SELECT MIN("id") FROM "users")
  )
);