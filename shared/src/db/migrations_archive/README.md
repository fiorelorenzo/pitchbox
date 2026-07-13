# Archived migrations (pre-baseline)

Original per-migration files `0000`-`0049` and their (broken) drizzle meta
snapshots, from before the migration history was squashed into a single baseline
on 2026-07-13.

Why: `drizzle-kit generate` had been unusable repo-wide since ~migration `0004`
(the meta snapshot chain was corrupt: physical snapshots frozen at `0003`, with
`0001`-`0003` byte-identical, while the journal listed `0000`-`0049`). Every
migration since had to be hand-authored. To restore a working `generate`, the
schema was squashed into `../migrations/0000_baseline.sql` (a faithful `pg_dump`
of the live schema, so a fresh deploy reproduces it exactly: historical
constraint names, all indexes, the `runs_kind_target_chk` CHECK). A fresh
drizzle snapshot/journal was generated from `schema.ts`, and every database's
`drizzle.__drizzle_migrations` tracking table was reset to a single row marking
the baseline as already applied (metadata only, no schema change).

Kept for historical reference only. drizzle does NOT read this directory (it only
reads `../migrations/`). Do not add new migrations here.
