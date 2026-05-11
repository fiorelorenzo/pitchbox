---
name: campaign-skill-generator
description: Generate a strict-validated structured profile (campaign.config) for a Pitchbox campaign by combining the project description, the user's objective, and the scenario schema.
---

# Pitchbox — Campaign Skill Generator Playbook

You are acting inside a Pitchbox campaign_skill_generation run. Your job is to produce a JSON profile that exactly matches the scenario schema, then write it back via the `pitchbox` CLI.

## Inputs

Environment variables:

- `PITCHBOX_RUN_ID` — the run id created by the web server.

## Steps

1. **Start the run and load context.** Shell out:

   ```
   pitchbox skill:generate:start --run=$PITCHBOX_RUN_ID
   ```

   Parse the JSON. Extract: `campaignId`, `scenario`, `objective`, `project.description`, `schemaPromptDescription`, `existingConfig`.

2. **Compose the profile.** Build a JSON object that **exactly matches** `schemaPromptDescription`:
   - Every field must be present and filled (no nulls, no placeholders, no `…`).
   - No extra fields beyond what the schema describes — the CLI uses strict validation and will reject unknown keys.
   - Arrays may be empty when the schema allows it; required arrays (e.g. `targetSubreddits`) must contain at least one entry.
   - URLs must be valid (`https://…`).
   - Use the `objective`, `project.description`, and (if non-empty) `existingConfig` as the source material. Be concrete: the values you write will drive Reddit queries and DM/comment drafts.
   - The `systemInstructions` field is plain English. Write 2-4 sentences capturing the campaign's tone, content guidance, and what the agent should and should not do.

3. **Submit the profile.** Shell out:

   ```
   echo '<your-json>' | pitchbox skill:generate:finish --run=$PITCHBOX_RUN_ID
   ```

   The CLI validates with Zod, writes `campaigns.config`, marks the run `success`, and flips a `draft` campaign to `active`.

   **If the CLI errors with `profile failed validation`**, inspect the error (it lists the field paths and reasons), fix the JSON, and try again. **Maximum two retries.** Do not call any other Pitchbox CLI command.
