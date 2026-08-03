## Context

Cards are rendered by `PackageCard` in `frontend/design-system/components/package-card.js` from data already returned by `/api/packages` (`first_seen`, `last_publish` are both present). The card already prints `timeAgo(data.last_publish)` as an "updated X ago" meta item and escapes all npm-sourced strings. No backend change is needed — freshness is a presentation concern derived client-side.

## Goals / Non-Goals

**Goals:**
- At-a-glance new/stale signals on cards with zero API changes.
- Deterministic, unit-testable classification.
- Accessible, non-color-only indicators.

**Non-Goals:**
- No new backend fields or endpoints.
- No changes to sort/rank logic (the "new" sort stays date-based, unchanged).
- No experimental "hot" flame indicators (deferred; not this change).

## Decisions

**D1: Client-side classification from existing fields.** `first_seen` and `last_publish` are already in the API payload, so `getFreshness(now, firstSeen, lastPublish)` computes `isNew` (≤14 days) and `isStale` (>30 days) in the frontend. Alternative (backend-computed `is_new` field) rejected: adds a schema/API round-trip for presentation-only data; the data is already shipped.

**D2: Inclusivity of boundaries.** 14 days → NEW (a package seen exactly 14 days ago is still "new this fortnight"); 30 days → stale (exactly 30 days is "a month", still notably old). Both boundaries documented in the helper.

**D3: Future timestamps are defensive.** A `first_seen` in the future (clock skew, bad data) classifies as new; a future `last_publish` is never stale. No exceptions thrown.

**D4: Badge placement.** NEW badge appended to the `.package-title` line (next to the name/version); stale indicator replaces the plain "updated X ago" meta item with a muted chip labeled "updated 45d ago" (keeps the relative time, adds the cue). Both are real text nodes, satisfying accessibility.

**D5: Pure helper module.** New `frontend/design-system/js/freshness.js` exporting `getFreshness` and `formatStaleLabel` (reuses `timeAgo` for the relative part). Tested in `freshness.test.js` mirroring the existing `utils.test.js` pattern — no DOM needed.

## Risks / Trade-offs

- **Clock dependency:** client machine's clock defines "now"; server sync offsets are negligible for 14/30-day windows. Acceptable.
- **Cards already call `timeAgo`** — the stale chip reuses it, so no duplicate logic drift.
- **Adding a badge changes card HTML** — existing card tests (if any assert exact innerHTML) may need updating; the escapeHtml contract must be preserved for the badge label (static string, but keep consistent).
