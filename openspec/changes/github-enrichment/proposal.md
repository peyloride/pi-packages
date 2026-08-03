# Proposal: github-enrichment

## Why

The dashboard tracks 6,300+ pi packages, most carrying a `github_url`, but cards and the detail modal show zero GitHub signals — no stars, issues, license, or archived state. A package with 5k stars is presented identically to a 1-star repo. GitHub metadata adds a strong quality/trust signal and makes the detail modal (#1) genuinely useful for evaluating a package.

## What Changes

- **New `repo_meta` table** keyed by normalized repo (owner/repo parsed from `github_url`): `stars`, `forks`, `open_issues`, `license`, `archived`, `pushed_at`, `fetched_at`.
- **Sync-time enrichment** via GitHub REST API (`GET /repos/{owner}/{repo}`), respecting the **unauth rate limit (60 req/hr)**. A **budgeted incremental refresh**: on each sync, refresh at most `GH_REPO_BUDGET` (default 60) repos per run, picking:
  1. repos never fetched yet, then
  2. repos with the oldest `fetched_at`.
  This churns the whole corpus over time without tripping the limit, and is a no-op without a token (or uses `GITHUB_TOKEN` when set for 5k/hr — optional).
- **API exposure**: `/api/packages/:name` and `/api/packages` list rows gain `github: {stars, forks, open_issues, license, archived, pushed_at} | null` (joined from `repo_meta`, null when absent).
- **Frontend**: detail modal shows a GitHub stat strip (★ stars, ⑂ forks, ⚠ issues, license chip, archived warning); package cards optionally show stars when present.
- Graceful degradation: no token, rate-limited, or missing repo → `null` metadata, UI unchanged.

## Capabilities

### New Capabilities
- `repo-meta-sync`: Budgeted incremental GitHub repo metadata sync into a `repo_meta` table.
- `github-meta-api`: GitHub metadata exposed via the existing package API endpoints.
- (frontend rendering lives with the existing package-detail-modal + package-card changes; listed in design but spec'd under the modal/card requirements where applicable)

## Impact

- `backend/db.ts` (schema: `repo_meta` table + migration via the existing `addColumnIfMissing`-style pattern)
- `backend/sync.ts` (new `syncRepoMeta()` step invoked from the sync orchestrator, budgeted)
- `backend/index.ts` (`/api/packages` + `/api/packages/:name` include `github` object via LEFT JOIN)
- `backend/sync.test.ts`, `backend/index.test.ts` (new tests; mock fetch — existing pattern)
- Frontend: `package-detail-modal.js` (GitHub stat strip), `package-card.js` (optional star count), `components.css` (styles)
- Optional env: `GITHUB_TOKEN` (raises budget to 5000/hr, else 60/hr unauth)
