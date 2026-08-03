## 1. CSS fix

- [x] 1.1 Add to `frontend/design-system/css/base.css` (or components.css if base is the wrong layer): `[hidden] { display: none !important; }` with a comment explaining why (hidden attribute vs component display rules).

## 2. Verification

- [x] 2.1 Confirm no JS/backend changes were made (only CSS).
- [x] 2.2 Run `nub run test` — existing suite green (279 passing).
- [x] 2.3 Run `nub run typecheck` — clean.
- [x] 2.4 Run `openspec validate fix-stats-view-hidden` — valid.
- [x] 2.5 Manual/visual: in a browser, package list shows no stats content; `#/stats` shows only stats; back/forward toggles correctly.
- [x] 2.6 Mark all task checkboxes complete in `tasks.md`.
