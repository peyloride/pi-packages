# Proposal: shareable-deep-links

## Why

Search and filter state is purely client-side — refreshing the page or sharing a URL loses the current view entirely. The dashboard should produce stable, bookmarked URLs for any package list or package detail view.

## What Changes

- **URL-driven state**: `sort`, `period`, `search`, and page (`p`) are read from URL query params on load and written back on every state change (tabs, period toggle, search input, pagination).
- **Deep-link to package detail**: clicking a package card opens the detail modal and pushes `#/pkg/<name>` so the modal view is shareable and survives refresh.
- **Browser history support**: back/forward navigation restores the previous view state via `popstate`.
- **No router library**: pure `URLSearchParams` + `history.replaceState`/`pushState`, staying dependency-free like the current frontend.
- URL updates are silent (replaceState) for transient changes like typing; pushState only on explicit actions (sort tab, package selection).

## Capabilities

### New Capabilities
- `url-state-sync`: Reading view state from the URL on load and writing it back on every change; back/forward support.
- `package-detail-modal`: Opening a package detail modal from a card click, backed by the existing `/api/packages/:name` endpoint, shared via `#/pkg/<name>`.

## Impact

- Frontend: `frontend/app.js`, `frontend/design-system/components/package-card.js` (card click → modal), new modal component under `frontend/design-system/components/`, new styles in `frontend/styles.css` or `design-system/css/`.
- Tests: frontend component tests (existing pattern in `frontend/design-system/js/utils.test.js`); URL parse/build helpers tested as pure functions.
- No backend changes; `/api/packages/:name` already exists and returns 60-day download history.
