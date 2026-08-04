## Context

The stats view renders from `/api/ecosystem` (materialized at sync) into plain `<li>`/`<span>` nodes (`publisherTable()`, `statCard()`, top-list in `app.js`). `/api/packages` currently supports `sort|period|search|limit|offset`; search is a LIKE on name+description. The list view already deep-links to the package modal (`#/pkg/<name>`) and URL-syncs list state — so the stats view needs only to *hand off* to those existing mechanisms. The one new backend capability: filtering `/api/packages` by exact publisher and by a 30-day download floor.

## Goals / Non-Goals

**Goals:**
- Every stats element with a meaningful target is clickable and leads somewhere useful.
- Filtered views are shareable/back-forwardable via the URL (consistent with the existing URL-state system).
- Backend filter composes with all existing params.

**Non-Goals:**
- No new `/api/ecosystem` fields (materialized shape stays; p90 etc. remain numbers).
- No click-to-expand or in-stats filtering UI (keep the stats page a dashboard; drilling happens in the list).
- No changes to the package modal.

## Decisions

**D1: `publisher` filter matches the *resolved display name*, exact + case-insensitive.** The list shows `resolvePublisher` output ("artale", GitHub owner for "GitHub Actions" publishers). To make "what you see is what you filter", the SQL compares against the same resolution. Implementation: because resolution happens in JS per-row today, the API computes it via the same rule — but for SQL filtering we need the raw stored `publisher` + `github_url`. Two options considered: (a) filter in SQL on `publisher = ?` raw, then post-resolve — misses "GitHub Actions" → owner matches; (b) add a materialized `publisher_display` column populated at sync (same resolve rule) and filter on it. **Decision: (b)** — a `publisher_display` TEXT column on `packages`, set in `upsertPackage` via the shared `resolvePublisher` (extracted to `backend/publisher.ts`, already exists from the ecosystem work), indexed. SQL: `publisher_display = ? COLLATE NOCASE`. Deterministic, fast, indexable, and exactly matches card display. (Schema migration via existing `addColumnIfMissing`.)

**D2: `min_downloads` = 30-day window floor.** `min_downloads=X` → `HAVING/WHERE SUM(CASE WHEN date >= date('now','-30 days') THEN downloads ELSE 0 END) >= X`. Applied consistently to the main query AND the count query (like the trending floor). The stats p90/p99 already use the same 30-day definition, so cohorts are exact. Absent/0/non-numeric → no filter. Clamp: `max(0, parseInt || 0)`.

**D3: Response-cache key** gains `publisher` + `min_downloads` components (mirroring how search/limit/offset are keyed), so cached responses invalidate correctly on sync version AND distinguish filter variants.

**D4: Frontend hand-off from stats → list.** Stats rows become `<a href="#list-route">`-style or button elements with click handlers that: set `location` (for publisher/min_downloads, `history.pushState` with `?sort=popular&publisher=…` and NO hash → list route), then call the same `loadPackages()`. Top-package rows call the existing `openDetail(name)` (same as list view). Popstate already handles Back.

**D5: URL state extension.** `url-state.js` `parseUrlState`/`buildUrlState` gain `publisher` (validated string, whitelist charset — keep it URL-safe; sanitize for meta usage) and `min_downloads` (non-negative int or absent). `applyStateFromUrl` wires them into `loadPackages` params. When a publisher/min_downloads filter is active, show a small "clear filter" chip in the list view (otherwise users have no obvious way back — Back works but a chip is clearer), and the stats tab remains reachable.

**D6: Clickable affordances.** Rows get `role="link"`/`tabindex=0` + `aria-label` when interactive; CSS hover/underline/chevron via `.clickable` class in components.css. Inert rows (null/empty) stay plain `<span>`/`<li>` with no handler. Keyboard: Enter opens (matching native link behavior).

## Risks / Trade-offs

- **`publisher_display` column adds a sync-time write** and one migration — small; the resolve rule is already centralized in `backend/publisher.ts` (used by index.ts + ecosystem.ts), so no divergence risk.
- **Exact-match publisher filter** (vs substring) is intentional (cohords/names are exact in the data); a search box still covers fuzzy discovery.
- **p90 cohort via min_downloads** uses the *rounded* p90 value shown on the card — a package at exactly p90 is included (≥ semantics), matching user expectation.
- **Back button after stats→list** may land on the stats view again (no hash) — that's the existing route behavior; the "clear filter" chip gives an explicit exit.
