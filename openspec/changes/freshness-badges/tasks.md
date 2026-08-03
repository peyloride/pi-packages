## 1. Freshness helper

- [ ] 1.1 Create `frontend/design-system/js/freshness.js` exporting `getFreshness(now, firstSeen, lastPublish)` → `{isNew, isStale, updatedLabel}` and `formatStaleLabel(lastPublish, timeAgoFn)`.
  - `isNew`: `firstSeen` present and within 14 days of `now` (inclusive; future timestamps → new).
  - `isStale`: `lastPublish` present and older than 30 days from `now` (inclusive; future timestamps → not stale).
  - `updatedLabel`: relative label via injected `timeAgo` (so the helper stays pure/DOM-free).
- [ ] 1.2 Add `frontend/design-system/js/freshness.test.js` covering: new within 14d, not new at 60d, boundary at exactly 14d (inclusive), stale at 45d, not stale at 2d, boundary at exactly 30d (inclusive), missing first_seen / last_publish → false + no error, future timestamps → new / not stale, and exported default constants `NEW_DAYS = 14`, `STALE_DAYS = 30`.

## 2. Card integration

- [ ] 2.1 In `package-card.js`, import `getFreshness` and render a `<span class="badge badge-new">NEW</span>` in `.package-title` when `isNew` (the label is a static trusted string — no escaping issue, but keep the innerHTML pattern consistent).
- [ ] 2.2 When `isStale`, replace the plain `updated-at` meta item with a muted chip: `<span class="meta-item updated-at stale">${label}</span>` where label is like "updated 45d ago" (reuse existing `timeAgo`).
- [ ] 2.3 Add options `showNewBadge` (default true) and `staleThresholdDays` (default 30) to the component options, and keep behavior identical when disabled.
- [ ] 2.4 Ensure missing `first_seen`/`last_publish` render cleanly (no badge, no stale chip, no error).

## 3. Styles

- [ ] 3.1 Add `.badge-new` styles to `frontend/design-system/css/components.css` (accent pill, small, bold, with accessible contrast).
- [ ] 3.2 Add `.updated-at.stale` styles (muted/desaturated, distinct from the normal updated label).
- [ ] 3.3 Verify dark theme tokens are used (check `tokens.css` for the accent color variable).

## 4. Verification

- [ ] 4.1 Run `nub run typecheck` — passes.
- [ ] 4.2 Run `nub run test` — all pass (including new freshness tests).
- [ ] 4.3 Run `openspec validate freshness-badges` — valid.
- [ ] 4.4 Mark all task checkboxes complete in `tasks.md`.
