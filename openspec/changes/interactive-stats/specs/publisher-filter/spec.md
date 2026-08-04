## ADDED Requirements

### Requirement: The API SHALL filter packages by publisher
`GET /api/packages` SHALL accept a `publisher` query param matching packages whose resolved publisher display name equals the value (exact, case-insensitive match on the display name the list view shows, e.g. "artale" or a GitHub owner). It SHALL compose with `sort`, `period`, `search`, `limit`, `offset`, and `min_downloads`, and SHALL be reflected in `pagination.total`.

#### Scenario: Filter by publisher
- **WHEN** a client requests `/api/packages?publisher=artale`
- **THEN** the response contains only packages whose resolved publisher is "artale", and pagination.total equals that count

#### Scenario: Publisher with no packages
- **WHEN** a client requests `/api/packages?publisher=nonexistent-person`
- **THEN** the response is 200 with an empty packages array and pagination.total 0

#### Scenario: Compose with search + sort
- **WHEN** a client requests `/api/packages?publisher=artale&search=tool&sort=popular`
- **THEN** results are the intersection (publisher AND search), sorted by period downloads

### Requirement: The API SHALL filter packages by minimum 30-day downloads
`GET /api/packages` SHALL accept a `min_downloads` query param (non-negative integer) returning only packages with ≥ that many downloads in the last 30 days. It SHALL be reflected in `pagination.total` and compose with `publisher` / `sort` / `search` / `period` / pagination.

#### Scenario: p90 cohort
- **WHEN** a client requests `/api/packages?min_downloads=1234&sort=popular`
- **THEN** every returned package has ≥ 1234 downloads in the last 30 days

#### Scenario: Zero or absent
- **WHEN** `min_downloads` is absent or 0
- **THEN** no minimum filter is applied (all packages)

#### Scenario: Invalid value
- **WHEN** `min_downloads` is non-numeric or negative
- **THEN** it is ignored (treated as absent) and the response is 200

### Requirement: The URL SHALL encode the stats-driven filters
The frontend URL state SHALL include `publisher` and `min_downloads` so a filtered view from the stats page is shareable and survives refresh/back-forward.

#### Scenario: Publisher filter in URL
- **WHEN** the user clicks a publisher row in the stats view
- **THEN** the URL becomes `?sort=popular&publisher=<name>` (plus existing period/search/page), the list view loads, and the stats view is left

#### Scenario: Cohort filter in URL
- **WHEN** the user clicks a p90/p99/active stat card
- **THEN** the URL becomes `?sort=popular&min_downloads=<value>`, the list view loads with the filter applied

#### Scenario: Back from filtered list
- **WHEN** the user presses Back after entering a publisher filter
- **THEN** the previous view (stats or unfiltered list) is restored

### Requirement: Stats view rows SHALL be interactive
The stats view SHALL render clickable targets: top-package rows open the package detail modal; publisher rows navigate to the publisher-filtered list; stat cards (active 30d, p90, p99) navigate to the corresponding cohort-filtered list. Non-clickable entries (empty lists, null values) SHALL render as inert text, never a dead link. All affordances SHALL have visible hover/focus styles.

#### Scenario: Top package click
- **WHEN** the user clicks a top package row
- **THEN** the package detail modal opens for that package (deep-link hash), exactly as in the list view

#### Scenario: Publisher click
- **WHEN** the user clicks a publisher row
- **THEN** the app navigates to the package list filtered to that publisher, sorted popular

#### Scenario: Stat card click (p90)
- **WHEN** the user clicks the p90 downloads card and p90 is non-null
- **THEN** the app navigates to the package list with `min_downloads=<p90>`

#### Scenario: Null stat card
- **WHEN** a stat card's value is null (—)
- **THEN** the card renders as inert text and is not clickable
