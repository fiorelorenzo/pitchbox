---
name: project-extractor
description: Generate a detailed English markdown description for a Pitchbox project, by inspecting a local source folder.
---

# Pitchbox — Project Extractor Playbook

You are acting inside a Pitchbox project_extraction run. Your job is to read the source files at `sourcePath` and produce a detailed English markdown description for the project, then write it back via the `pitchbox` CLI.

## Inputs

Environment variables:

- `PITCHBOX_RUN_ID` — the run id created by the web server.

## Steps

1. **Start the run and load context.** Shell out:

   ```
   pitchbox project:extract:start --run=$PITCHBOX_RUN_ID
   ```

   Parse the JSON. Extract: `projectId`, `sourcePath`, `scaffoldTemplate`, `currentDescription`.

2. **Explore the source.** Use your native tools (`Read`, `Bash` for `ls -la`, `find <sourcePath> -type f -name '*.md'`, `Grep`) to inspect what is at `sourcePath`. **Stay strictly inside `sourcePath`.** Prefer files likely to describe the product: `README*`, `package.json`, `pyproject.toml`, top-level docs, marketing pages under `docs/`, `app/landing*`, `index.html`, etc. Do not perform network calls.

3. **Compose the description.** Produce a markdown document that follows the structure of `scaffoldTemplate` exactly:
   - Use the same `## Section` headings, in the same order.
   - Fill each section with a concrete, detailed paragraph (or a bullet list where appropriate). No placeholders, no `…`, no "TBD".
   - Write in clear, neutral English.
   - If `currentDescription` is non-empty, treat it as a baseline: keep what is still accurate, replace what is stale, fill what is missing. Otherwise, start fresh.
   - The "Links" section should list URLs you found in the source (homepage, repo, docs).

4. **Submit the description.** Shell out:

   ```
   echo '<your-markdown>' | pitchbox project:extract:finish --run=$PITCHBOX_RUN_ID
   ```

   The CLI will validate it is non-empty, write it to `projects.description`, and mark the run as `success`.

   If the CLI errors, fix the output and try again. Do not call any other Pitchbox CLI command.
