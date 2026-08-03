# freshness-badges Specification

## Purpose
TBD - created by archiving change freshness-badges. Update Purpose after archive.
## Requirements
### Requirement: New packages SHALL show a NEW badge
The system SHALL mark packages whose `first_seen` is within 14 days of the current date with a visible prominent "NEW" badge on their card.

#### Scenario: Recently first-seen package
- **WHEN** a package has `first_seen` 5 days ago
- **THEN** its card displays a visible "NEW" badge

#### Scenario: Older package
- **WHEN** a package has `first_seen` 60 days ago
- **THEN** its card does NOT display a NEW badge

#### Scenario: Missing first_seen
- **WHEN** a package has no `first_seen` value
- **THEN** its card does NOT display a NEW badge and renders without error

### Requirement: Stale packages SHALL show a stale indicator
The system SHALL render a muted "stale" indicator on cards whose `last_publish` is older than 30 days, replacing the neutral "updated X ago" presentation with an explicit "not updated recently" cue.

#### Scenario: Package not updated for 45 days
- **WHEN** a package has `last_publish` 45 days ago
- **THEN** its card shows a stale indicator (e.g. muted chip with "updated 45d ago" or "stale")

#### Scenario: Recently updated package
- **WHEN** a package has `last_publish` 2 days ago
- **THEN** its card shows the normal updated label without a stale indicator

#### Scenario: Missing last_publish
- **WHEN** a package has no `last_publish` value
- **THEN** its card shows no stale indicator and renders without error

### Requirement: Freshness classification SHALL be pure and testable
The new/stale classification logic SHALL live in a pure helper (e.g. `getFreshness(now, firstSeen, lastPublish)` returning `{isNew, isStale, updatedLabel}`) that takes explicit timestamps so it is deterministic and unit-testable.

#### Scenario: Boundary at 14 days
- **WHEN** `first_seen` is exactly 14 days before `now`
- **THEN** the package is classified as new (inclusive boundary) OR the boundary is documented and consistent

#### Scenario: Boundary at 30 days
- **WHEN** `last_publish` is exactly 30 days before `now`
- **THEN** the package is classified as stale (inclusive boundary) OR the boundary is documented and consistent

#### Scenario: Future timestamps
- **WHEN** `first_seen` or `last_publish` is in the future relative to `now`
- **THEN** the classification treats it as brand new / not stale without throwing

### Requirement: Badges SHALL be accessible
Badges MUST be text-based (not color-only) and readable by assistive technology.

#### Scenario: Screen reader
- **WHEN** a NEW badge is rendered on a card
- **THEN** its text content ("NEW") is present in the accessibility tree

#### Scenario: No color-only signal
- **WHEN** a card shows a stale indicator
- **THEN** the indicator conveys its meaning via text (e.g. "updated 3 months ago") in addition to any color styling

