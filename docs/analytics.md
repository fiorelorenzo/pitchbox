# Analytics

The Analytics page (`/analytics`) shows a per-campaign funnel of drafts as they progress through the four canonical states: **proposed** (`pending_review`), **approved**, **sent**, **replied**.

Data comes from `GET /api/analytics/funnel`, which accepts optional `campaign_id`, `from`, and `to` query params and returns `{ stages: [{ stage, count }] }`. Counts are computed with four `COUNT(*)` queries on the `drafts` table (joined on `runs` when filtering by campaign).

The page renders horizontal bars sized proportionally to the largest stage; each bar shows the absolute count and the conversion rate from the previous stage.
