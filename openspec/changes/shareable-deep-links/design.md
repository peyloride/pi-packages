## Context

The dashboard is a dependency-free vanilla JS SPA (no router, no build step). Current state lives only in module-level variables in `frontend/app.js` (`currentSort`, `currentPeriod`, `currentSearch`, `currentOffset`). The backend already exposes `GET /api/packages/:name` returning full package metadata plus 60-day `download_history`; the frontend never calls it today.

## Goals / Non-Goals

**Goals:**
- Every view state is encoded in the URL (query params for list state, hash for the package modal) so refresh and sharing preserve the view.
- Minimal, dependency-free implementation consistent with the existing design-system style.
- Back/forward button support via `popstate`.

**Non-Goals:**
- No router library, no server-side rendering, no URL rewrites on the server.
- No new backend endpoints (the detail endpoint already exists).
- No history entries for transient typing (search keystrokes use replaceState).

## Decisions

**D1: Query params for list state, hash for detail.** List state (`sort`, `period`, `search`, `p`) belongs in the query string because it is shareable and server-agnostic; the package detail modal uses `#/pkg/<name>` because it's a secondary view layered on top of the list and the hash doesn't participate in query semantics. Alternative considered: a full client-side router (`/packages?…`, `/pkg/name`) — rejected as overkill; the SPA has two views.

**D2: `pushState` only for explicit actions, `replaceState` for typing.** Sort tab clicks and package opens push a history entry (back button feels natural); search input and period toggles replace the current entry to avoid history spam. Alternative: push everything — creates an unusably long back stack while typing.

**D3: Popstate re-renders from URL.** One `parseUrl()` function reads the URL into state; `applyState()` renders. `popstate` calls both, so back/forward just re-parses the URL. Debounced search writes the URL via `history.replaceState` and also calls `applyState()`.

**D4: Modal as a design-system component.** New `frontend/design-system/components/package-detail-modal.js` following the existing component pattern (exported factory returning a DOM node, like `PackageCard`). It owns its own fetch, chart rendering (inline SVG `<rect>` bars — no chart library), and focus management. `app.js` owns URL hash sync.

**D5: Chart is a pure SVG bar renderer.** A small pure function `renderBars(container, data)` (in `design-system/js/utils.js` or a new `chart.js`) takes `{date, downloads}` pairs and emits SVG bars with a max-scale — testable as a pure function, matching the existing `utils.test.js` pattern.

**D6: Modal opened from card click without hijacking links.** The card name/GitHub links keep their real `href`s. A dedicated click handler on the card (or the name link only, excluding external links) intercepts the default only for the detail trigger, so modifier-clicks and external links behave normally.

## Risks / Trade-offs

- **Hash deep links on refresh:** on load, `#/pkg/<name>` triggers a modal fetch; if the list query also restores, both run concurrently — the modal renders above the list, so this is fine; ordering is handled by opening the modal after the first list render.
- **History entries for sort changes** accumulate (each tab click = one entry); acceptable, this is standard SPA behavior.
- **No URL for modal + list simultaneously beyond hash + query** — works, but a native back from the modal to "previous modal" (navigating package-to-package) creates a stack; we intentionally do NOT push a new entry when the modal changes package while already open (replaceState).
- **XSS:** modal renders npm-sourced metadata — must reuse the existing `escapeHtml`/`sanitizeHref` helpers from the design system (already covered by tests).
