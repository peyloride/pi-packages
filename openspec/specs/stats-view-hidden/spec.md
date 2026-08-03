# stats-view-hidden Specification

## Purpose
TBD - created by archiving change fix-stats-view-hidden. Update Purpose after archive.
## Requirements
### Requirement: The hidden attribute SHALL always hide elements
The CSS SHALL include a rule that makes the `hidden` attribute take precedence over any element's `display` value, so a component with `display: flex` (or any other non-none display) is still hidden when `hidden` is set.

#### Scenario: Stats view while on package list
- **WHEN** the user is on the package list (no `#/stats` hash) and `#stats-view` has the `hidden` attribute
- **THEN** the stats view is not visible anywhere on the page (no residual rendering below the list)

#### Scenario: Stats view when active
- **WHEN** the user navigates to `#/stats` and `hidden` is removed from `#stats-view`
- **THEN** the stats view is visible and the package list is hidden

#### Scenario: Other hidden elements
- **WHEN** any element with a `display`-setting class also carries the `hidden` attribute
- **THEN** it is hidden (the rule is global, not stats-specific)

### Requirement: No JS or API changes
The fix SHALL be purely CSS; the existing `hidden`-attribute toggling in `app.js` SHALL remain unchanged and the backend/API SHALL be untouched.

#### Scenario: JS behavior preserved
- **WHEN** the existing route toggle code runs (applyRouteVisibility, stats tab click, popstate)
- **THEN** it behaves as before (same attribute toggling), and the page now renders correctly

