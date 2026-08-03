# security-headers Specification

## Purpose
TBD - created by archiving change security-headers. Update Purpose after archive.
## Requirements
### Requirement: HTML responses SHALL include a strict Content-Security-Policy
The system SHALL serve a CSP header on HTML responses that blocks inline scripts and external script/style origins, while allowing the app's own assets, Google Fonts CSS, and the known inline style attribute.

#### Scenario: Dashboard HTML carries CSP
- **WHEN** a client requests `/`
- **THEN** the response includes `Content-Security-Policy` containing `script-src 'self'`, `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`, `font-src 'self' https://fonts.gstatic.com`, `default-src 'self'`, `img-src 'self' data:`, `connect-src 'self'`, `base-uri 'self'`, `form-action 'self'`, and `frame-ancestors 'none'`

#### Scenario: Inline script is blocked
- **WHEN** a browser loads the dashboard with a CSP enabled
- **THEN** any inline `<script>` or `on*` attribute that appears in HTML (e.g. from a rendering bug) is blocked by the policy, not executed

#### Scenario: Fonts and styles still load
- **WHEN** a browser loads the dashboard
- **THEN** Google Fonts (from fonts.googleapis.com / fonts.gstatic.com) and the app's own CSS and JS load without CSP violations

### Requirement: All responses SHALL include nosniff
The system SHALL serve `X-Content-Type-Options: nosniff` on every response so browsers refuse to MIME-sniff a mislabeled body.

#### Scenario: API response
- **WHEN** a client requests `/api/packages`
- **THEN** the response includes `X-Content-Type-Options: nosniff`

#### Scenario: Static asset response
- **WHEN** a client requests `/styles.css`
- **THEN** the response includes `X-Content-Type-Options: nosniff`

### Requirement: All responses SHALL include a referrer policy
The system SHALL serve `Referrer-Policy: strict-origin-when-cross-origin` on all responses.

#### Scenario: Detail page response
- **WHEN** a client requests `/api/packages/pi-dgoal`
- **THEN** the response includes `Referrer-Policy: strict-origin-when-cross-origin`

### Requirement: HTML responses SHALL include X-Frame-Options
The system SHALL serve `X-Frame-Options: DENY` on HTML responses as a legacy framing guard.

#### Scenario: Dashboard HTML
- **WHEN** a client requests `/index.html`
- **THEN** the response includes `X-Frame-Options: DENY`

### Requirement: Header middleware SHALL be unit-tested
The security header behavior SHALL be covered by backend tests asserting the exact header values on representative route responses (HTML, static asset, API JSON, SPA fallback).

#### Scenario: Header presence across routes
- **WHEN** tests request `/`, `/styles.css`, `/api/stats`, and an unknown SPA route
- **THEN** each response carries the security headers appropriate to its type (CSP/XFO on HTML; nosniff/referrer on all), and no test asserts conflicting values

