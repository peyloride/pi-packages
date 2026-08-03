# ecosystem-api Specification

## Purpose
TBD - created by archiving change ecosystem-stats. Update Purpose after archive.
## Requirements
### Requirement: The system SHALL expose an ecosystem aggregation endpoint
`GET /api/ecosystem` SHALL return aggregate ecosystem metrics computed from the packages and daily_downloads tables, with this shape:
`{ total_packages, active_packages_30d, downloads_series: [{date, downloads}], top_publishers: {by_packages: [...], by_downloads: [...]}, top_packages: [...], distribution: {p50, p90, p99, median_growth} }`.

#### Scenario: Healthy dataset
- **WHEN** the database has package and download data
- **THEN** the endpoint returns the full shape with non-empty series (dates ascending, covering the last 60 days), two top-publisher lists, a top-packages list, and distribution percentiles

#### Scenario: Empty dataset
- **WHEN** the database has no packages or no downloads
- **THEN** the endpoint returns the same shape with empty/zero values (never missing fields, never an error)

### Requirement: Ecosystem series SHALL cover 60 days
The `downloads_series` SHALL contain one entry per calendar day for the last 60 days (inclusive of today), each with total downloads across all packages for that day; days with no downloads SHALL be present with `downloads: 0`.

#### Scenario: Daily aggregation
- **WHEN** downloads exist across multiple days
- **THEN** each series entry sums all packages for that date, and the series is ordered oldest → newest

#### Scenario: Sparse days
- **WHEN** a day has no download records at all
- **THEN** that day still appears in the series with downloads 0

### Requirement: Top publishers SHALL be ranked two ways
`top_publishers.by_packages` SHALL list up to 10 publishers by distinct package count (descending); `top_publishers.by_downloads` SHALL list up to 10 publishers by total downloads across their packages in the last 30 days (descending). Each entry SHALL include `{publisher, packages, downloads}`.

#### Scenario: Publisher by package count
- **WHEN** publishers have differing package counts
- **THEN** by_packages lists them descending by package count (ties broken deterministically)

#### Scenario: Publisher by downloads
- **WHEN** publishers have differing 30-day download totals
- **THEN** by_downloads lists them descending by downloads, with package counts included

### Requirement: Top packages SHALL rank by 30-day downloads
`top_packages` SHALL list up to 10 packages by total downloads over the last 30 days (descending); each entry SHALL include `{name, downloads, growth}` (growth = materialized weekly growth, may be null).

#### Scenario: Ranking
- **WHEN** packages have differing 30-day totals
- **THEN** top_packages lists the highest-downloading packages first with name, downloads, and growth

#### Scenario: Ties
- **WHEN** two packages have identical download totals
- **THEN** the ordering is deterministic (e.g. name asc) across requests

### Requirement: Distribution SHALL include percentiles
`distribution` SHALL include `p50`, `p90`, `p99` — the 50th/90th/99th percentile of 30-day downloads across packages that have at least one download in the last 30 days — plus `median_growth` (median of non-null weekly growth values across packages). All SHALL be null-safe (null when no data).

#### Scenario: Percentiles computed
- **WHEN** at least one package has downloads in the last 30 days
- **THEN** p50 ≤ p90 ≤ p99 (subject to integer rounding) and all are ≥ 0

#### Scenario: No data
- **WHEN** no package has downloads in the last 30 days
- **THEN** p50/p90/p99 and median_growth are null

### Requirement: Ecosystem stats SHALL be materialized at sync time
The endpoint SHALL read from a sync-materialized cache (`ecosystem_cache` in sync_meta), recomputed after each sync (incremental and full), with a cold-start fallback to live recompute.

#### Scenario: After sync
- **WHEN** a sync completes
- **THEN** the ecosystem cache is recomputed and subsequent /api/ecosystem requests return it

#### Scenario: Cold start (no sync yet)
- **WHEN** the server boots with an empty sync_meta
- **THEN** the first /api/ecosystem request computes the values live and returns them (cached afterward)

### Requirement: The frontend SHALL render a Stats view
The dashboard SHALL provide a Stats view (reachable via a nav tab and deep-linkable via `#/stats`) rendering: 60-day ecosystem trend chart, top publishers (both rankings), top packages, and distribution cards (p50/p90/p99, active packages, median growth).

#### Scenario: Navigate to Stats
- **WHEN** the user clicks the Stats tab (or loads `#/stats`)
- **THEN** the view shows the trend chart, publisher rankings, top packages, and distribution cards, with loading and error states

#### Scenario: Trend chart renders
- **WHEN** the downloads_series data loads
- **THEN** the chart renders the 60-day series as an SVG area/line using the existing pure chart helpers, with date labels and readable scaling

#### Scenario: Empty ecosystem data
- **WHEN** the API returns an empty shape (no packages)
- **THEN** the view renders an empty state (no chart, no lists) with a friendly message

#### Scenario: API failure
- **WHEN** the /api/ecosystem request fails
- **THEN** the view shows an error state with a retry action

