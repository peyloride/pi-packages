# Proposal: fix-stats-view-hidden

## Why

The Stats view (`#/stats`) renders but appears **below the package list** instead of replacing it. Root cause: `#stats-view` has `display: flex` in CSS, which overrides the `hidden` attribute's implicit `display: none`. The `hidden` attribute only works when no CSS rule sets `display` on the element. The dashboard toggles `hidden` correctly in `app.js` (`applyRouteVisibility()`), but CSS wins the specificity battle, so the stats section is always visible at the end of the page.

## What Changes

- Add a global CSS rule `[hidden] { display: none !important; }` so the `hidden` attribute always wins over any `display` value set by component classes.
- Add it to the design-system CSS (base layer) so it applies everywhere (list, stats view, pagination, modal, future components).
- No JS changes: the existing `hidden`-attribute toggling in `app.js` (route toggle between list and `#/stats`) is correct and becomes effective once CSS stops overriding it.

## Capabilities

### Modified Capabilities
- (none — no spec-level behavior change beyond fixing the rendering bug; the ecosystem-api spec already requires `#/stats` to show the stats view and hide the list. This change makes the existing spec requirement actually hold.)

## Impact

- `frontend/design-system/css/base.css` (or `components.css`): one rule `[hidden] { display: none !important; }`
- No JS, no backend, no API changes.
- Existing tests unaffected; no new behavior to test beyond a CSS presence assertion (frontend tests are JS-only — rely on manual/visual verification + existing suite staying green).
