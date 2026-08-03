# Proposal: ecosystem-stats

## Why

The dashboard shows individual packages well but has no macro view of the pi ecosystem. Users (and the dashboard owner) can't answer "is the ecosystem growing?", "who publishes the most?", or "what does the download distribution look like?" — questions the 60 days of `daily_downloads` + 6,300 packages can already answer.

## What Changes

- **New `/api/ecosystem` endpoint** returning aggregated, sync-cached (like `/api/stats`):
  - `downloads_series`: daily total downloads for the last 60 days (`[{date, downloads}]`)
  - `top_publishers`: top 10 publishers by package count AND by 30-day downloads (two lists: `by_packages`, `by_downloads`)
  - `top_packages`: top 10 packages by 30-day downloads (name, downloads, growth)
  - `distribution`: total packages, packages with downloads in last 30d, percentiles (p50/p90/p99) of 30-day downloads per package, median growth
- **Frontend "Stats" view**: a second route (`#/stats` or tabs) rendering:
  - Ecosystem trend line/area chart (60-day daily downloads, SVG, reusing the pure chart helpers from the detail modal)
  - Top publishers table/cards (two sort orders) + top packages list
  - Distribution summary cards (p50/p90/p99, packages with activity, etc.)
  - Same design language (design-system components, no libs)
- Cache via the existing materialized `sync_meta` pattern (`ecosystem_cache` key) recomputed at sync time; response-cached with the sync-version key like the other API endpoints.

## Capabilities

### New Capabilities
- `ecosystem-api`: The `/api/ecosystem` endpoint returning aggregated ecosystem metrics, materialized at sync time.
- `stats-view`: A frontend Stats page/route rendering the ecosystem trend, top publishers, top packages, and distribution stats.

## Impact

- `backend/stats.ts` (add `recomputeEcosystemCache()` + `getEcosystemCache()`, same pattern as stats_cache)
- `backend/cron.ts` (call ecosystem recompute after syncs — same place stats_cache is recomputed)
- `backend/index.ts` (new `/api/ecosystem` route, response-cached, sync-version keyed)
- `frontend/app.js` (route to stats view, fetch + render)
- `frontend/index.html` (nav tab for Stats)
- `frontend/design-system/js/chart.js` (reuse/extend the pure SVG chart helpers — line/area + bars)
- `frontend/design-system/css/components.css` (stats page styles)
- Tests: backend stats/endpoint tests, frontend chart/rendering tests
