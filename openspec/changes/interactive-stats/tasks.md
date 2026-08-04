## 1. Backend: publisher_display column

- [x] 1.1 Add `publisher_display TEXT` to `packages` via `addColumnIfMissing` in `backend/db.ts` (with index optionally).
- [x] 1.2 In `backend/sync.ts` `upsertPackage`, populate `publisher_display` using the shared `resolvePublisher` from `backend/publisher.ts` (already extracted; import and use — no copy).
- [x] 1.3 Existing backend tests still pass; add a sync.test case asserting `publisher_display` is set (esp. "GitHub Actions" → GitHub owner).

## 2. Backend: /api/packages params

- [x] 2.1 `publisher`: read `c.req.query('publisher')`; when non-empty, add `AND p.publisher_display = ? COLLATE NOCASE` to the where clause (both main + count queries); bind the param in order before LIMIT/OFFSET.
- [x] 2.2 `min_downloads`: parse `max(0, parseInt || 0)`; when > 0, add `HAVING COALESCE(SUM(CASE WHEN d.date >= date('now','-30 days') THEN d.downloads ELSE 0 END),0) >= ?` to both main + count queries (mirror the trending-floor pattern; ensure it binds correctly when combined with trending's own HAVING).
- [x] 2.3 Extend the response-cache key with `publisher` + `min_downloads`.
- [x] 2.4 Tests in `backend/index.test.ts`: publisher exact + case-insensitive + no-match → empty; min_downloads filter + count total; compose publisher+search+sort; invalid min_downloads ignored; keys/cache vary by param.

## 3. Frontend: URL state

- [x] 3.1 `frontend/design-system/js/url-state.js`: `parseUrlState` returns `{publisher?, min_downloads?}` (sanitized: publisher non-empty string; min_downloads non-negative int or undefined); `buildUrlState` includes them. Update `url-state.test.js` (round-trip, invalid → dropped).

## 4. Frontend: stats rows interactive

- [x] 4.1 `renderEcosystem` in `app.js`: top-package rows become clickable (click → `openDetail(pkg.name)`), with `.clickable` + keyboard (Enter) + aria-label.
- [x] 4.2 Publisher rows (both tables) become clickable → `navigateToList({ publisher })` (pushState `?sort=popular&publisher=…`, clear hash, `loadPackages()`); empty/inert rows stay plain.
- [x] 4.3 Stat cards: p90/p99/active-30d cards (non-null values) become clickable → `navigateToList({ min_downloads: <value> })` (p90/p99 use the card's value; active uses p50? — decision: active-30d → `min_downloads=1` to mean "has any downloads in 30d"); null cards inert.
- [x] 4.4 Add "clear filter" chip in the list view when publisher/min_downloads active (click → clear + reload); ensure it doesn't disturb search behavior.

## 5. Frontend: loadPackages wiring

- [x] 5.1 `loadPackages()` includes `publisher`/`min_downloads` params from module state; `applyStateFromUrl` sets them; popstate restores them.

## 6. Styles

- [x] 6.1 `components.css`: `.clickable` (hover underline/chevron, focus-visible outline), `.filter-chip` styles, aria/pressed states.

## 7. Verification

- [x] 7.1 `openspec validate interactive-stats` — valid.
- [x] 7.2 `nub run typecheck` — passes.
- [x] 7.3 `nub run test` — all pass (existing 279 + new).
- [x] 7.4 Mark all task checkboxes complete in `tasks.md`.
