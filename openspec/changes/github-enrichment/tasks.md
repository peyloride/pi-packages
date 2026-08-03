## 1. Schema

- [ ] 1.1 In `backend/db.ts`, add `repo_meta` table:
  `repo TEXT PRIMARY KEY, stars INTEGER, forks INTEGER, open_issues INTEGER, license TEXT, archived INTEGER (0/1), pushed_at TEXT, fetched_at TEXT`.
- [ ] 1.2 Add `github_repo TEXT` column to `packages` (via `addColumnIfMissing` pattern), populated at sync time in `upsertPackage` from `github_url` normalization (owner/repo lowercased; null when no github_url or unparseable).

## 2. Sync enrichment

- [ ] 2.1 Add `syncRepoMeta(budget)` in `backend/sync.ts` (or new `backend/repoMeta.ts`): select up to `budget` repos — `fetched_at IS NULL` first, then oldest `fetched_at` — from `repo_meta` that have a matching `packages.github_repo`; for each, `GET https://api.github.com/repos/{owner}/{repo}` with `Authorization: Bearer <token>` when `GITHUB_TOKEN` set; upsert `repo_meta`; on 404 store nulls + fetched_at (re-try after 30d); on 403/429 rate-limit → log + stop the step; other errors → log + continue. Injectable `fetchFn` param for tests (match existing sync.ts test pattern).
- [ ] 2.2 Constants: `GH_REPO_BUDGET = Number(process.env.GH_REPO_BUDGET ?? 60)`, `GITHUB_TOKEN`, `REPO_RETRY_AFTER_DAYS = 30`, cooldown logic in the SELECT (`fetched_at IS NULL OR fetched_at < now - retry`).
- [ ] 2.3 Wire `syncRepoMeta` into the incremental sync after download refresh; must not block/fail the sync (wrap in try/catch, log failures). Add env doc comments.

## 3. API exposure

- [ ] 3.1 `backend/index.ts` `/api/packages`: LEFT JOIN `repo_meta r ON r.repo = p.github_repo`; map to `github: {stars, forks, open_issues, license, archived: !!archived, pushed_at} | null` (null when `p.github_repo` null). Keep the response-cache key unchanged (data changes only on sync — repo_meta changes on sync too, and syncVersion bumps it).
- [ ] 3.2 `backend/index.ts` `/api/packages/:name`: same JOIN; always include `github` field (object|null).

## 4. Frontend

- [ ] 4.1 `package-detail-modal.js`: `renderGithubStrip(container, github)` — stars/forks/issues (formatNumber), license chip, archived warning badge; call when `data.github` non-null; escape all values.
- [ ] 4.2 `package-card.js`: option `showStars` (default true); render `☆ <formatNumber(stars)>` next to the GitHub meta link when `data.github?.stars > 0`.
- [ ] 4.3 `components.css`: styles for `.github-strip`, `.gh-stat`, `.license-chip`, `.archived-badge`, `.card-stars`.

## 5. Tests

- [ ] 5.1 `backend/sync.test.ts` (or new repoMeta test): mocked fetch — budget respected, never-fetched-first, oldest-first round-robin, 404 → nulls + cooldown, 429 stop, token header sent when configured, injectable fetchFn usage.
- [ ] 5.2 `backend/index.test.ts`: `/api/packages` and `/api/packages/:name` include `github` (object when repo_meta row exists, null otherwise); detail always has the field.
- [ ] 5.3 Frontend: purity tests for a `github-strip` helper if extracted; card star rendering test via existing DOM-free patterns where feasible.
- [ ] 5.4 Update README (env vars `GITHUB_TOKEN`, `GH_REPO_BUDGET`).

## 6. Verification

- [ ] 6.1 `openspec validate github-enrichment` — valid.
- [ ] 6.2 `nub run typecheck` — passes.
- [ ] 6.3 `nub run test` — all pass (existing + new).
- [ ] 6.4 Mark all task checkboxes complete in `tasks.md`.
