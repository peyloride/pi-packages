# url-state-sync Specification

## Purpose
TBD - created by archiving change shareable-deep-links. Update Purpose after archive.
## Requirements
### Requirement: URL SHALL capture search and filter state
The system SHALL support: capture search and filter state.

The application reads `sort`, `period`, `search`, and `p` (page) from the URL query string on load and applies them as the initial view state.

#### Scenario: Load with query parameters
- **WHEN** the page loads with `?sort=popular&period=daily&search=agent&p=2`
- **THEN** the dashboard applies popular sort, daily period, the search term "agent", and page 2 without any user interaction

#### Scenario: Load without query parameters
- **WHEN** the page loads with no query string
- **THEN** the dashboard uses its defaults (trending, weekly, no search, page 1)

### Requirement: URL SHALL update on state change
The system SHALL support: update on state change.

Every user state change (sort tab click, period toggle, search input, pagination) updates the URL query string to reflect the new state.

#### Scenario: Change sort tab
- **WHEN** the user clicks the "Popular" tab
- **THEN** the URL updates to `?sort=popular` (plus current period/search/page)

#### Scenario: Type in search
- **WHEN** the user types in the search box
- **THEN** the URL updates with the debounced search term and resets page to 1

#### Scenario: Change page
- **WHEN** the user clicks a pagination page
- **THEN** the URL updates to the new `p` value

#### Scenario: Invalid or missing params
- **WHEN** the URL contains an invalid `sort`, `period`, or non-numeric `p`/`limit`
- **THEN** the invalid value is ignored and the dashboard falls back to its default for that param without erroring

### Requirement: Back and forward navigation SHALL restore view state
The system SHALL support: restore view state.

The browser back/forward buttons restore the previously seen view state without a full page reload.

#### Scenario: Back after changing sort
- **WHEN** the user changes sort from Trending to Popular and presses browser Back
- **THEN** the dashboard restores the Trending view and the URL reflects it

### Requirement: Package detail SHALL be deep-linkable
The system SHALL support: be deep-linkable.

Clicking a package card opens a detail modal showing package metadata and download history, and the URL updates to `#/pkg/<name>`.

#### Scenario: Open package detail
- **WHEN** the user clicks a package card
- **THEN** a modal opens with the package's details (description, version, publisher, GitHub link, download history chart) and the URL hash is `#/pkg/<name>`

#### Scenario: Load page with package hash
- **WHEN** the page loads with URL hash `#/pkg/<name>`
- **THEN** the modal opens automatically for that package after the initial list loads

#### Scenario: Close modal
- **WHEN** the user closes the modal (X button, Escape key, or clicking the backdrop)
- **THEN** the modal closes, the hash is removed from the URL, and the list state is preserved

#### Scenario: Unknown package name in hash
- **WHEN** the URL hash references a package that doesn't exist in the database
- **THEN** the modal shows a friendly not-found state and the hash is cleared

### Requirement: Modal SHALL show full package data from the detail API
The system SHALL support: show full package data from the detail API.

The modal fetches `/api/packages/:name` and renders its contents: description, version, publisher, GitHub/npm links, keywords (as tags), 60-day download history chart, and weekly growth.

#### Scenario: Successful detail fetch
- **WHEN** the modal opens and the API returns package data
- **THEN** the modal renders the package metadata and a bar chart of daily downloads

#### Scenario: Detail fetch failure
- **WHEN** the detail API request fails (network error or HTTP 5xx)
- **THEN** the modal shows an error state with a retry button

### Requirement: Modal SHALL be accessible
The system SHALL support: be accessible.

The modal follows accessible dialog patterns: focus moves into the dialog on open, focus is trapped while open, Escape closes it, and focus returns to the triggering element on close.

#### Scenario: Keyboard operation
- **WHEN** the modal is open and the user presses Escape
- **THEN** the modal closes and focus returns to the previously focused element

#### Scenario: Focus management on open
- **WHEN** the modal opens
- **THEN** focus moves to the dialog container or its close button, and tabbing cycles within the modal

