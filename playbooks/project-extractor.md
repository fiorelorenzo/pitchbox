---
name: project-extractor
description: Generate a detailed English markdown description for a Pitchbox project, plus 0-10 starter campaign recommendations, by inspecting its source tree through the Pitchbox MCP tools.
---

# Pitchbox - Project Extractor Playbook

You are acting inside a Pitchbox project_extraction run. Your job is to read the project's source files, produce a detailed English markdown description for the project, and propose 0-10 campaign starters that fit the project. Everything - reading the source and submitting the outputs - goes through the **`pitchbox` MCP server** (tools named `mcp__pitchbox__*`). The source tree lives on the Pitchbox client, not on the machine you are running on, so your own file tools (`Read`, `Glob`, `Grep`, `Bash`) cannot see it: use `project_extract_files` and `project_extract_read` instead.

## Inputs

The run is bound to this session through the environment, so the tools default to the right run.

## Tools

- `project_extract_start` - load context (scaffold, scenarios, existing campaigns).
- `project_extract_files` - list the source tree (paths relative to the source root, with sizes).
- `project_extract_read` - read one source file by relative path.
- `project_extract_finish` - submit the description + recommendations.

## Steps

1. **Start the run and load context.** Call `project_extract_start` (no arguments needed).

   From the result extract: `projectId`, `scaffoldTemplate`, `currentDescription`, `scenarios`, `existingCampaigns`. (`sourcePath` is the path on the client; it is informational only - never pass it to a file tool of your own.)

2. **Explore the source.** Call `project_extract_files` to see what is there, then `project_extract_read` on the files that matter. Prefer files likely to describe the product: `README*`, `package.json`, `pyproject.toml`, top-level docs, marketing pages under `docs/`, `app/landing*`, `index.html`. Read a handful of the most informative ones rather than everything; a response with `truncated: true` was cut at the size cap, which is normally enough. Do not perform network calls.

3. **Compose the description.** Produce a markdown document that follows the structure of `scaffoldTemplate` exactly:
   - Use the same `## Section` headings, in the same order.
   - Fill each section with a concrete, detailed paragraph (or a bullet list where appropriate). No placeholders, no `…`, no "TBD".
   - Write in clear, neutral English.
   - If `currentDescription` is non-empty, treat it as a baseline: keep what is still accurate, replace what is stale, fill what is missing. Otherwise, start fresh.
   - The "Links" section should list URLs you found in the source (homepage, repo, docs).

4. **Propose 0-10 campaign recommendations.** Read `existingCampaigns` from the payload - these are campaigns the user has already configured for this project. **Do not duplicate**: skip any scenario+angle already covered. Then look at `scenarios` for the list of available campaign types and pair each promising angle with the right `scenarioSlug`.

   Each recommendation is an object:
   - `scenarioSlug`: one of the slugs listed in `scenarios`. Reddit scenarios (`reddit-scout` / `reddit-commenter` / `reddit-poster`) suit consumer, prosumer, hobby, and broad B2C audiences. Hacker News scenarios (`hn-commenter` / `hn-poster`) suit developer-tools, infrastructure, open-source, AI / ML, security, and technical-founder audiences - the kind of post that would make sense on the front page of news.ycombinator.com. **Do not propose HN for a product that is not technical in nature.** A given project may earn both Reddit and HN recommendations if it has audiences on both platforms; many won't.
   - `name`: 1-7 word title for the campaign (e.g. "Reddit RPG launch").
   - `objective`: 1-3 sentences describing who to reach and the angle (be concrete - vague objectives produce mediocre campaigns).

   Volume:
   - If `existingCampaigns` already covers every reasonable angle, propose **0**.
   - Otherwise propose **1-10**, aiming for variety (different scenarios, different angles).

5. **Submit the description and recommendations.** Call `project_extract_finish` with:

   ```json
   {
     "description": "<the markdown you composed in step 3>",
     "recommendations": [{ "scenarioSlug": "reddit-scout", "name": "...", "objective": "..." }]
   }
   ```

   The tool validates that `description` is non-empty and validates each recommendation individually. Invalid recommendations are silently dropped (warnings) and the description is always saved if non-empty.

   **If the tool returns an error result**, inspect the message, fix the payload, and try again. **Maximum two retries.** Do not call any other Pitchbox MCP tool.
