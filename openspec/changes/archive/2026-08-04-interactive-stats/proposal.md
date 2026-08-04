# Proposal: interactive-stats

## Why

The Stats view (`#/stats`) is informative but inert — every element is plain `<li>`/`<span>` text. Users can see "top publisher" or "top package" but can't click into them, so the view is a dead end. The rest of the dashboard already has rich interactions (package modal, search, filters); the stats view should feed into them rather than sit alongside them.

## What Changes

- **Publisher rows become links**: clicking a publisher navigates to the package list filtered to that publisher (`?publisher=<name>`, new backend support in `/api/packages`), sorted by 30-day downloads by default.
- **Top packages become links**: clicking a top-package row opens the existing package detail modal (deep-link `#/pkg/<name>`), consistent with the list view.
- **Distribution/stat cards become cohort filters**: clicking "Active packages (30d)", "p90", or "p99" navigates to the package list filtered to that cohort (e.g. packages with ≥ p90 downloads in the last 30 days), so a number like "p90 = 1,234" becomes "show me the packages at or above this traffic level".
- **Top publishers tables** keep both sort orders but rows are clickable (by_packages and by_downloads).
- **Null/empty entries are not clickable** (no `github`/no downloads → plain text, no dead link).
- Backend: `/api/packages` gains a `publisher` query param (exact match on resolved publisher display name) and a `min_downloads` query param (for p90/p99 cohorts). Both compose with existing `sort`/`period`/`search`/`limit`/`offset`.
- URL reflects the filter (`?sort=popular&publisher=artale` / `?min_downloads=1000`), so filtered views are shareable and back/forward works.

## Capabilities

### New Capabilities
- `publisher-filter`: `/api/packages` supports `publisher` (exact) and `min_downloads` query params; the list view applies them to the URL + fetch.

### Modified Capabilities
- `stats-view`: Stats view rows become interactive navigation targets (publisher → filtered list, top package → detail modal, stat cards → cohort-filtered list).

## Impact

- `backend/index.ts` (`/api/packages`: publisher + min_downloads params, SQL, count, response-cache key)
- `backend/index.test.ts` (param tests)
- `frontend/app.js` (`renderEcosystem` builds links; `applyStateFromUrl`/`loadPackages` read publisher + min_downloads; helper to jump from stats → list)
- `frontend/design-system/css/components.css` (link affordances: hover, chevron, focus states)
- `frontend/design-system/js/url-state.js` + tests (parse/build publisher + min_downloads)
- No changes to `/api/ecosystem` shape; existing tests stay green.
