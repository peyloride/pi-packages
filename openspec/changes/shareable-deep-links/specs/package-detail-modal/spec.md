## ADDED Requirements

### Requirement: Package detail SHALL be a deep-linkable modal
The system SHALL support: be a deep-linkable modal.

A package card opens a detail modal and the URL hash becomes `#/pkg/<name>`.

#### Scenario: Open on card click
- **WHEN** the user clicks a package card's name (or a dedicated details trigger)
- **THEN** a modal opens for that package and the URL hash updates to `#/pkg/<name>`

#### Scenario: Open on page load
- **WHEN** the dashboard loads with hash `#/pkg/<name>`
- **THEN** the modal opens automatically for that package after the initial list has loaded

#### Scenario: Close modal
- **WHEN** the user closes the modal (X button, Escape, or backdrop click)
- **THEN** the modal closes, the hash is removed, and the underlying list state is preserved

#### Scenario: Unknown package hash
- **WHEN** the URL hash references a package the API reports as not found (404)
- **THEN** the modal shows a not-found state and the hash is cleared

### Requirement: Modal SHALL render package detail
The system SHALL support: render package detail.

The modal fetches `GET /api/packages/:name` and renders the returned package metadata and 60-day download history.

#### Scenario: Successful load
- **WHEN** the detail API returns data
- **THEN** the modal shows the package name, version, description, publisher, GitHub/npm links, keywords as tags, weekly growth, and a bar chart of the download history

#### Scenario: Failed load
- **WHEN** the detail API call fails (network error or non-404 HTTP error)
- **THEN** the modal shows an error state with a retry action

#### Scenario: Copy install command
- **WHEN** the user clicks the copy button in the modal
- **THEN** the `npm:`-prefixed install command for the package is copied to the clipboard and the button gives visual confirmation

### Requirement: Modal SHALL be keyboard accessible
The system SHALL support: be keyboard accessible.

The modal follows standard dialog accessibility: focus moves into it on open and is contained while open; Escape closes it; focus returns to the opener on close.

#### Scenario: Escape closes
- **WHEN** the modal is open and Escape is pressed
- **THEN** the modal closes and focus returns to the element that opened it

#### Scenario: Focus containment
- **WHEN** the modal is open and the user presses Tab repeatedly
- **THEN** focus cycles within the modal and never leaves it until closed
