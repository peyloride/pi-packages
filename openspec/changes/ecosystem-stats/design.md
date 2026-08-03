## Context

`backend/stats.ts` already establishes the materialization pattern: `recomputeStatsCache()` runs after each sync (from `cron.ts`), stores a JSON blob in `sync_meta`, `/api/stats` reads it and falls back to live recompute on cold start. `daily_downloads` holds 60 days × ~6,300 packages (~380k rows); the SQLite queries needed (daily sums, publisher joins, percentile window functions) are heavy enough that per-request computation is the wrong call — materializing mirrors the proven pattern. The frontend has pure SVG chart helpers in `design-system/js/utils.js` (`renderBars`) from the detail modal; a line/area variant belongs beside it. The frontend now also has URL routing (hash-based) from the deep-links change — a `#/stats` route fits the existing pattern.

## Goals / Non-Goals

**Goals:**
- One well-typed, well-tested `/api/ecosystem` endpoint + materialized cache, consistent with `/api/stats`.
- A polished Stats view reusing design-system chart helpers and components, deep-linkable via `#/stats`.
- Null-safe, empty-dataset-safe API shape.

**Non-Goals:**
- No per-package drill-down in the stats view (the list view does that).
- No historical >60-day series (retention is 60 days by design).
- No interactive chart library (pure SVG helpers only, consistent with the zero-dep frontend).

## Decisions

**D1: Materialized `ecosystem_cache` in sync_meta, same lifecycle as stats_cache.** `recomputeEcosystemCache()` runs beside `recomputeStatsCache()` in the same post-sync hook; `/api/ecosystem` reads it with the same cold-start fallback. Rationale: identical proven pattern; avoids a second cache invalidation story.

**D2: Percentiles computed in SQLite.** SQLite 3.38+ (Node 24 bundles ≥ 3.45) supports window functions: `PERCENTILE` doesn't exist, but `CUME_DIST`/`NTILE`-based queries are fragile; instead use `ORDER BY` + `LIMIT/OFFSET` with indexed reads or a `COUNT`-based rank formula (`ROUND(count * pct)` row pick). Given the 30-day window is a simple `WHERE date >= date('now','-30 days')` grouped by package, compute percentiles via a single subquery: `SELECT ... ORDER BY total LIMIT 1 OFFSET k`. Two queries (p50 once; p90/p99 from the same ranked CTE where feasible) are still sub-10ms on 380k rows. **Decision: ranked CTE + OFFSET picks**, tested for p50 ≤ p90 ≤ p99.

**D3: 60-day series with zero-fill.** Query daily sums grouped by date, then in JS fill missing days with 0 (SQLite has no generate_series in default builds — avoid `WITH RECURSIVE` where a JS loop over 60 days is clearer and testable). The series is always 60 entries, oldest → newest.

**D4: Publisher normalization.** Use the same `resolvePublisher` mapping as `/api/packages` ("GitHub Actions" → repo owner) so publisher rankings match what users see on cards. Compute the display name in JS while grouping; SQL groups by raw publisher, JS maps after (client-visible display name is stable per package row).

**D5: Frontend route.** Extend the hash-based routing from the deep-links change: `#/stats` shows the stats view (hides the package list), `#/pkg/<name>` keeps the modal, and no hash (or `#/packages`) shows the list. The nav gains a "Stats" tab alongside the sort filter group.

**D6: Chart helper.** Add `renderLineArea(container, points)` (and a pure `buildLinePath(points, width, height)` for tests) to `design-system/js/utils.js` or a new `chart.js`, keeping `renderBars` untouched. SVG polyline + optional filled area path; date labels sparse (e.g. every 10th day); x/y scales computed from data min/max.

**D7: View composition.** `app.js` keeps one `statsViewContainer` div (hidden by default); Stats tab toggles it vs the list. Loading/error/empty states reuse the design-system `LoadingState`/`ErrorState`/`EmptyState` components already imported.

**D8: Cache key + response caching.** `/api/ecosystem` uses the same `responseCache.key(['ecosystem'])` — keyed by syncVersion, so a sync that recomputes the materialized blob naturally invalidates the response cache (same as `/api/stats`).

## Risks / Trade-offs

- **Percentile edge semantics:** OFFSET-row picking approximates percentiles; exactness isn't critical for a dashboard, and p50 ≤ p90 ≤ p99 holds for any monotone pick with rounding — tested.
- **Publisher display-name mapping in JS** means `by_packages` counts could double-count if two raw publishers map to the same owner; acceptable (dedupe by display name in JS, documented).
- **60-day zero-fill loop** is O(60) per request — negligible.
- **Chart alignment:** the area chart needs a min-in-source scale anchor (baseline 0 for download counts, which are non-negative); documented in `buildLinePath`.
