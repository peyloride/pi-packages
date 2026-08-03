## 1. Backend: ecosystem cache

- [ ] 1.1 Add `recomputeEcosystemCache()` + `getEcosystemCache()` to `backend/stats.ts` (or new `backend/ecosystem.ts` importing getDb):
  - `downloads_series`: daily sums over last 60 days, zero-filled in JS (oldest → newest, exactly 60 entries)
  - `top_publishers.by_packages`: top 10 raw publishers by package count, mapped to display names (reuse the resolvePublisher logic — extract to a shared helper if needed), entry `{publisher, packages, downloads}` (downloads = 30-day total)
  - `top_publishers.by_downloads`: top 10 by 30-day downloads across their packages
  - `top_packages`: top 10 by 30-day downloads, `{name, downloads, growth}` (growth from materialized weekly_growth)
  - `distribution`: p50/p90/p99 of 30-day per-package downloads (ranked CTE + OFFSET pick), `median_growth` (median of non-null weekly_growth), `active_packages_30d`
  - persist to `sync_meta` key `ecosystem_cache`; return the object (cold-start fallback)
- [ ] 1.2 Call `recomputeEcosystemCache()` from the same post-sync hook in `cron.ts` where `recomputeStatsCache()` is called (incremental + full).

## 2. Backend: endpoint

- [ ] 2.1 Add `GET /api/ecosystem` in `backend/index.ts`: response-cache keyed `['ecosystem']` (syncVersion-based), read `getEcosystemCache()` → cold-start recompute fallback; same error handling + cache-control as `/api/stats`.
- [ ] 2.2 Ensure the response shape is exactly per spec (never missing fields, null-safe).

## 3. Backend: tests

- [ ] 3.1 `backend/stats.test.ts` (or new): seed in-memory DB with packages + daily_downloads (incl. a sparse day), assert series length 60 + zero-fill, top publishers both orders, top packages order + tie determinism, percentile null-safety (empty → null), p50 ≤ p90 ≤ p99 when data present, cache persistence + recompute-on-demand.
- [ ] 3.2 `backend/index.test.ts`: `/api/ecosystem` smoke (200, shape, syncVersion response-cache behavior, empty DB → 200 with empty shape).

## 4. Frontend: chart helper

- [ ] 4.1 Add `buildLinePath(points, width, height, pad)` pure function + `renderLineArea(container, points, opts)` to `design-system/js/utils.js` (or `chart.js`): SVG polyline + optional area fill, baseline 0, sparse date labels (every ~10th day), min/max scaling.
- [ ] 4.2 Add `chart.test.js` (or extend existing): path geometry invariants (starts at x=0 baseline, monotonic y, width/height respected), undefined/empty input → empty path, one-point series handles gracefully.

## 5. Frontend: Stats view

- [ ] 5.1 `index.html`: add a "Stats" nav button (in the sort filter group or a new group), container div `#stats-view` (hidden by default).
- [ ] 5.2 `app.js`: extend hash routing — `#/stats` shows stats view + hides list; `#/pkg/<name>` unchanged; no hash shows list. Stats tab click → `location.hash = '#/stats'`. On `#/stats` load, fetch `/api/ecosystem` and render: trend chart (renderLineArea with downloads_series), top publishers (two lists with toggle or side-by-side), top packages, distribution cards.
- [ ] 5.3 Reuse `LoadingState`/`ErrorState`/`EmptyState`; error → retry button; empty shape → friendly empty state.
- [ ] 5.4 All values escaped (formatNumber for numbers; publisher/name via escapeHtml — they're npm/GitHub-sourced).

## 6. Styles

- [ ] 6.1 `components.css`: `.stats-view`, `.stats-grid`, `.stat-card`, `.stats-chart`, `.publisher-list`, `.top-list` styles consistent with tokens.

## 7. Verification

- [ ] 7.1 `openspec validate ecosystem-stats` — valid.
- [ ] 7.2 `nub run typecheck` — passes.
- [ ] 7.3 `nub run test` — all pass (existing 251 + new).
- [ ] 7.4 Mark all task checkboxes complete in `tasks.md`.
