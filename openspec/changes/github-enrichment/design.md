## Context

`packages.github_url` is already normalized (git+ prefix stripped, .git suffix removed) for ~4.9k/6.3k packages in `sync.ts::upsertPackage`. The sync runs hourly via cron in Docker (Coolify) and the full sync daily at 03:00 UTC. The GitHub REST API unauth core rate limit is 60 req/hr per IP; with a `GITHUB_TOKEN` it's 5,000/hr. `fetch` is available in Node 24; `sync.test.ts` mocks fetch via injected `fetchFn` (existing pattern).

## Goals / Non-Goals

**Goals:**
- Persistent `repo_meta` table + budgeted incremental enrichment that respects the 60/hr unauth limit.
- GitHub metadata on `/api/packages` and `/api/packages/:name`, null-safe.
- Detail modal GitHub strip + optional card stars, all with graceful degradation.

**Non-Goals:**
- No GitHub OAuth/app tokens, no webhooks, no per-day forced full refresh.
- No dependents/repo-language/topics enrichment (future work; the `/repos/{owner}/{repo}` response already includes some, but only the spec'd fields are stored).
- No client-side GitHub API calls (privacy + rate limits stay server-side).

## Decisions

**D1: Normalized repo key = `owner/repo` lowercased.** Parse `github_url` to owner + repo (strip `https://github.com/`, trailing `/`, `.git`); store the key lowercased in `repo_meta.repo`. `github.com/Org/Repo` and `github.com/org/repo` collapse to one row. Alternative (full URL) rejected: URL-encoding and case variants break joins.

**D2: Budget policy.** `GH_REPO_BUDGET` (default 60). Each sync run processes up to budget repos: first all repos with `fetched_at IS NULL`, then oldest `fetched_at`. When `GITHUB_TOKEN` is set, batch is effectively unlimited (5000/hr « 60*24h runs) but still capped at the same per-run budget for predictability. Without a token, budget defaults to 60 (≤ the 60/hr unauth limit) and the step logs a one-line note that it's unauth-limited. Policy is a constant + comment, documented.

**D3: Sync step placement.** `syncRepoMeta(limit)` runs inside the incremental sync AFTER download refresh (downloads are the critical freshness path; GitHub enrichment is best-effort and must never block or fail the sync). Errors are caught per-repo: one bad repo (404, renamed) → log + continue; the whole step only stops on rate-limit (403/429 with rate-limit signal) — per spec.

**D4: Repo 404/renamed handling.** A 404 marks the repo as "not found" — store `stars: null` + `fetched_at` so it's not re-tried every sync but re-checked after a long cooldown (e.g. re-try after 30 days). Rationale: renamed repos self-heal when the GitHub URL updates at the next package metadata refresh, so we don't need redirect chasing.

**D5: API join.** `/api/packages` list SQL gets a LEFT JOIN `repo_meta` on `owner/repo` derived from `p.github_url` (SQLite can't easily parse URLs in SQL, so compute the key in JS per row OR maintain a `github_repo` column; simplest: compute in JS by joining the row's `github_url` — but that's N parses; instead, backfill a `github_repo` column on `packages` during sync and join on it). Decision: **store `repo` key at sync time on `packages.github_repo`** (new column, populated in `upsertPackage`), so SQL is a plain equality join. Detail endpoint joins the same way.

**D6: Null contract.** Every response row includes `github` (object or null). List endpoint: `github` only on rows that have it; detail: always present as object|null; missing → null (never undefined), documented in tests.

**D7: Frontend.** Modal: new `renderGithubStrip(container, github)` called when `data.github` non-null; stars/forks/issues via `formatNumber`, license chip via safe string, archived badge. Card: `showStars` option (default true); star count `☆ N` next to the GitHub link. Both escape all values (github data is GitHub-sourced = untrusted).

**D8: Env config.** `GITHUB_TOKEN` optional; `GH_REPO_BUDGET` optional int env (default 60). No schema change to `sync_meta`; repo_meta is its own table.

## Risks / Trade-offs

- **Unauth limit is shared per-IP** — if the VPS shares an IP with other GitHub API users (it doesn't; single-tenant Coolify VPS), budget could 429. We stop on 429, never hammer.
- **repo_meta grows stale for low-traffic repos** — 60/hr * 24 = 1,440 repos/day refresh at steady state; ~4.9k repos ≈ 3.4 days full cycle. Freshness lag acceptable for stars/issues.
- **GitHub API shape drift** — fields are defensive (`Number.isFinite` guards, null fallsbacks), so a removed field degrades to null, never a crash.
- **Card star adds a network-free DOM change** — pure presentational; existing card tests must stay green (star element is additive).
