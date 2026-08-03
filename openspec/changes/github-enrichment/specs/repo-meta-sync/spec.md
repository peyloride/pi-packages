## ADDED Requirements

### Requirement: The system SHALL store GitHub repo metadata
The system SHALL maintain a `repo_meta` table storing per-repo GitHub data (stars, forks, open issues, license, archived flag, pushed_at, fetched_at), keyed by normalized `owner/repo`.

#### Scenario: Repo metadata stored after fetch
- **WHEN** the sync fetches GitHub data for repo `octocat/Hello-World`
- **THEN** a `repo_meta` row exists with key `octocat/Hello-World` holding the returned stars, forks, open issues, license (or null), archived flag, pushed_at, and fetched_at

#### Scenario: Duplicate fetch upserts
- **WHEN** the same repo is fetched a second time
- **THEN** the existing row is updated (no duplicate rows) and fetched_at is refreshed

### Requirement: The system SHALL sync GitHub metadata on a budget
The system SHALL run a budgeted GitHub enrichment step during each sync: at most `GH_REPO_BUDGET` (default 60) repo fetches per sync run, choosing repos never fetched before first, then those not fetched longest ago. The step SHALL be skipped entirely when no GitHub token is configured IF the budget would exceed the unauth rate limit — OR run at budget 60 unauth; the exact policy SHALL follow design D2 (see design.md) and be documented in the code.

#### Scenario: First sync after enablement
- **WHEN** a sync runs with no `repo_meta` rows yet and budget 60
- **THEN** up to 60 distinct repos (never-fetched-first) are fetched and stored

#### Scenario: Steady state
- **WHEN** a sync runs after all repos have been fetched
- **THEN** the 60 repos with the oldest `fetched_at` are refreshed (round-robin aging)

#### Scenario: Rate limit respected
- **WHEN** the GitHub API returns 403 with a rate-limit message or 429
- **THEN** the sync stops fetching, logs a warning, and leaves partial results persisted; it does not retry in the same run

#### Scenario: Budget zero or disabled
- **WHEN** `GH_REPO_BUDGET` is 0 or the feature is disabled
- **THEN** no GitHub API calls are made and no error is raised

### Requirement: The system SHALL expose GitHub metadata via the API
`GET /api/packages` list rows and `GET /api/packages/:name` SHOULD each include a `github` field: `{stars, forks, open_issues, license, archived, pushed_at} | null` (null when no metadata exists for the repo).

#### Scenario: Metadata present
- **WHEN** a package has a `github_url` and a `repo_meta` row exists for it
- **THEN** the API response includes the `github` object with the stored values

#### Scenario: Metadata absent
- **WHEN** a package has no `github_url` or no `repo_meta` row
- **THEN** the API response includes `github: null` (never missing/undefined, never an error)

### Requirement: The detail modal SHALL render GitHub stats
The package detail modal SHALL render a GitHub stat strip when `github` metadata is present: stars, forks, open issues, license (if any), and an "archived" warning badge when `archived` is true.

#### Scenario: Modal with metadata
- **WHEN** the user opens a package whose API response includes non-null `github`
- **THEN** the modal shows star/fork/issue counts, license chip (or no chip when null), and the archived badge if archived

#### Scenario: Modal without metadata
- **WHEN** the user opens a package whose `github` is null
- **THEN** the modal renders normally with no GitHub strip and no error

### Requirement: Package cards SHALL optionally show star counts
The package card SHALL render a small star count next to the GitHub link when the package has `github.stars` and the card option `showStars` (default true) is enabled; otherwise it SHALL render the current card without the star count.

#### Scenario: Stars present
- **WHEN** a card's data includes `github.stars` > 0
- **THEN** the card shows the formatted star count beside the GitHub meta link

#### Scenario: Stars absent or disabled
- **WHEN** `github` is null or `showStars` is false
- **THEN** the card renders exactly as before (no star element)
