# Proposal: freshness-badges

## Why

Package cards currently show raw stats but no visual signal about how *new* or *fresh* a package is. Users browsing the ecosystem need at-a-glance cues — a newly published package should stand out, and a package that hasn't been updated in months shouldn't look as lively as one updated today. The data (`first_seen`, `last_publish`) already exists; only the presentation is missing.

## What Changes

- **NEW badge** on cards for packages first seen within the last 14 days, derived from `first_seen` (computed in the frontend from existing API data — no backend change needed; the API already returns `first_seen`).
- **Stale indicator** on cards for packages whose `last_publish` is 30+ days old — a muted "stale" chip replacing/augmenting the plain "updated X ago" text.
- Badges are pure presentation in `package-card.js` + CSS; no new API fields, no backend changes.
- Badges are accessible: live as real text, not color-only signals.

## Capabilities

### New Capabilities
- `freshness-badges`: Visual new/stale indicators on package cards derived from existing `first_seen` / `last_publish` data.

## Impact

- `frontend/design-system/components/package-card.js` (badge rendering, new options `showNewBadge`, `staleThresholdDays`)
- `frontend/design-system/css/components.css` / `frontend/styles.css` (badge styles)
- Tests: extend/add pure-function tests for the freshness classification logic (new `freshness.js` helper) in the existing frontend test pattern
- No backend or API changes.
