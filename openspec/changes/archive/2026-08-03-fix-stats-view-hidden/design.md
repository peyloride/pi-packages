## Decisions

**D1: Global `[hidden] { display: none !important; }` in `base.css`.** The design-system has a `base.css` for global resets/utilities — a single universal rule is the correct home (not scoped to `.stats-view`, since the bug is generic: any future component with `display: flex` + `hidden` would hit it). `!important` is required because the *component class specificity* (`display: flex`) would otherwise win over the attribute selector `[hidden]` when both apply; the attribute is the intended source of truth for visibility.

**D2: No JS change.** `app.js` already toggles `hidden` correctly; the fix is purely declarative. Keeping the diff to one CSS line minimizes risk to the just-shipped routing.

## Risks / Trade-offs

- **`!important` is a hammer** but scoped to exactly the `[hidden]` attribute — the correct, standard pattern (same as Bootstrap/`iron-overlay` behavior). Any future rule that *intends* to force visibility (e.g. `display: block !important` on an element with `hidden`) would still lose — acceptable, and deliberate.
- **No automated test** (frontend tests are JS pure-function tests; there's no CSS assertion harness). Mitigated by manual verification of all three scenarios + keeping the change to one rule.
