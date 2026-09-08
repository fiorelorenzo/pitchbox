-- Per-project voice override (#408): a suggestion filed under a product's
-- project should not sound like the operator's personal account, and vice
-- versa. Both columns null means "inherit the org's linkedin_assist tone" -
-- resolveEffectiveVoice (shared/src/linkedin-assist.ts) is the one place that
-- fallback is decided, so a null here is indistinguishable from a project
-- that predates this column.
--
-- Not an enum, matching the org-level tone stored in app_config's jsonb: the
-- vocabulary lives in code (assist/tone.ts), and an unrecognised value here
-- falls through to the org setting the same way an unrecognised jsonb value
-- falls through to the default.
ALTER TABLE "projects" ADD COLUMN "voice_tone" text;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "voice_tone_notes" text;
