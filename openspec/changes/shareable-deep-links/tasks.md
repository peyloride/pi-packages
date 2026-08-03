## 1. URL state helpers

- [ ] 1.1 Add pure functions in `frontend/design-system/js/url-state.js`: `parseUrlState(searchParams|location)` → `{sort, period, search, page}` with validation/defaults, and `buildUrlState(state)` → query string. Invalid values fall back to defaults (`sort` in trending/popular/new/updated, `period` in daily/weekly/monthly, non-numeric `p` → 1).
- [ ] 1.2 Add `frontend/design-system/js/url-state.test.js` covering: valid round-trip, missing params → defaults, invalid sort/period/page → defaults, page clamp to ≥ 1.

## 2. Wire URL state into app.js

- [ ] 2.1 On DOMContentLoaded, initialize state from `parseUrlState(location.search)` instead of hardcoded defaults.
- [ ] 2.2 Update sort tab click, period toggle, search input (debounced), and pagination handlers to write the URL via `history.replaceState` (search typing) or `history.pushState` (sort/period/page explicit clicks... see D2: push only sort + page; period and search replace).

## 3. Back/forward support

- [ ] 3.1 Add a `popstate` listener that re-parses `location.search` + `location.hash`, updates module state, re-renders the list, and opens/closes the modal accordingly.

## 4. Package detail modal component

- [ ] 4.1 Create `frontend/design-system/components/package-detail-modal.js` exporting `openPackageDetailModal({name, onClose})` (or a class) that: fetches `/api/packages/:name`, renders metadata (name, version, description, publisher, GitHub/npm links via `sanitizeHref`, keywords tags, growth chip, copy-install button), 60-day bar chart via `renderBars`, loading state, error state with retry, and not-found state (404 → clear hash).
- [ ] 4.2 Add `renderBars` (pure SVG bar chart) to `design-system/js/utils.js` (or `chart.js`) with per-day tooltip `title` and max-scale.
- [ ] 4.3 Implement accessibility: on open, focus the dialog; trap Tab; Escape closes; backdrop click and X close; on close, restore focus to triggering element.
- [ ] 4.4 Add tests: `package-detail-modal.test.js` for renderBars pure function + modal state machine (needs DOM; use existing frontend test pattern — jsdom if available, else pure-function tests for chart/utilities and manual verification for focus).
- [ ] 4.5 Ensure all npm-sourced strings rendered in the modal go through `escapeHtml`; links through `sanitizeHref` (reuse existing helpers).

## 5. Wire modal into card clicks + hash

- [ ] 5.1 In `app.js`, add click delegation on the package list: card name (detail trigger) → `openPackageDetailModal` + `location.hash = '#/pkg/<name>'` via pushState.
- [ ] 5.2 Handle `#/pkg/<name>` on load: after initial list render, if hash matches, open the modal for that package.
- [ ] 5.3 On modal close: clear the hash (replaceState) without disturbing query params.
- [ ] 5.4 Unknown package (404) → modal shows not-found, hash cleared.

## 6. Styling + integration verification

- [ ] 6.1 Add modal styles to `frontend/styles.css` (or design-system css/components.css): overlay backdrop, centered dialog, responsive max-height scroll, chart sizing, focus-visible outlines.
- [ ] 6.2 Run `nub run typecheck`, `nub run test`, `openspec validate --change shareable-deep-links` — all green.
- [ ] 6.3 Manual smoke test: sort/period/search/page round-trip via URL; refresh preserves view; back/forward works; modal opens from card + from hash; Escape closes and clears hash; 404 hash shows not-found.
