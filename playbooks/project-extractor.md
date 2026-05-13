---
name: project-extractor
description: Generate a detailed English markdown description for a Pitchbox project, plus 0-10 starter campaign recommendations, by inspecting a local source folder.
---

# Pitchbox - Project Extractor Playbook

You are acting inside a Pitchbox project_extraction run. Your job is to read the source files at `sourcePath`, produce a detailed English markdown description for the project, and propose 0-10 campaign starters that fit the project. Both outputs are submitted back via the `pitchbox` CLI.

## Inputs

Environment variables:

- `PITCHBOX_RUN_ID` - the run id created by the web server.

## Steps

1. **Start the run and load context.** Shell out:

   ```
   pitchbox project:extract:start --run=$PITCHBOX_RUN_ID
   ```

   Parse the JSON. Extract: `projectId`, `sourcePath`, `scaffoldTemplate`, `currentDescription`, `scenarios`, `existingCampaigns`.

2. **Explore the source.** Use your native tools (`Read`, `Bash` for `ls -la`, `find <sourcePath> -type f -name '*.md'`, `Grep`) to inspect what is at `sourcePath`. **Stay strictly inside `sourcePath`.** Prefer files likely to describe the product: `README*`, `package.json`, `pyproject.toml`, top-level docs, marketing pages under `docs/`, `app/landing*`, `index.html`, etc. Do not perform network calls.

3. **Compose the description.** Produce a markdown document that follows the structure of `scaffoldTemplate` exactly:
   - Use the same `## Section` headings, in the same order.
   - Fill each section with a concrete, detailed paragraph (or a bullet list where appropriate). No placeholders, no `…`, no "TBD".
   - Write in clear, neutral English.
   - If `currentDescription` is non-empty, treat it as a baseline: keep what is still accurate, replace what is stale, fill what is missing. Otherwise, start fresh.
   - The "Links" section should list URLs you found in the source (homepage, repo, docs).

4. **Propose 0-10 campaign recommendations.** Read `existingCampaigns` from the payload - these are campaigns the user has already configured for this project. **Do not duplicate**: skip any scenario+angle already covered. Then look at `scenarios` for the list of available campaign types and pair each promising angle with the right `scenarioSlug`.

   Each recommendation is an object:
   - `scenarioSlug`: one of the slugs listed in `scenarios`.
   - `name`: 1-7 word title for the campaign (e.g. "Reddit RPG launch").
   - `objective`: 1-3 sentences describing who to reach and the angle (be concrete - vague objectives produce mediocre campaigns).

   Volume:
   - If `existingCampaigns` already covers every reasonable angle, propose **0**.
   - Otherwise propose **1-10**, aiming for variety (different scenarios, different angles).

5. **Submit the description and recommendations.** Shell out:

   ```
   echo '<your-json>' | pitchbox project:extract:finish --run=$PITCHBOX_RUN_ID
   ```

   Where `<your-json>` is a JSON object:

   ```json
   {
     "description": "<the markdown you composed in step 3>",
     "recommendations": [{ "scenarioSlug": "reddit-scout", "name": "...", "objective": "..." }]
   }
   ```

   The CLI validates that `description` is non-empty and validates each recommendation individually. Invalid recommendations are silently dropped (warnings on stderr) and the description is always saved if non-empty.

   **If the CLI errors with `{"ok": false}`**, inspect the error message, fix the payload, and try again. **Maximum two retries.** Do not call any other Pitchbox CLI command.
