// =============================================================================
// GitHub repo metadata enrichment (budgeted, best-effort)
//
// Fetches per-repo GitHub metadata (stars, forks, open issues, license,
// archived, pushed_at) into the `repo_meta` table, keyed by normalized
// lowercased `owner/repo` (see sync.ts normalizeGithubRepo, design D1).
//
// RATE LIMITING (design D2):
//   - Unauthenticated GitHub API allows 60 core requests/hour per IP.
//   - Each sync run processes at most GH_REPO_BUDGET (default 60) repos:
//       * repos never fetched before (fetched_at IS NULL) first, then
//       * repos with the oldest fetched_at (round-robin aging).
//   - With GITHUB_TOKEN set (5,000 req/hr) the same per-run budget applies
//     for predictability; without a token the budget is 60 (<= the unauth
//     limit) and we log a one-line note.
//   - On 403 (rate-limit body) or 429 the step stops immediately and leaves
//     partial results persisted — no retry within the same run.
//   - A 404 stores nulls + fetched_at so the repo is not retried every sync;
//     it becomes eligible again after REPO_RETRY_AFTER_DAYS (30) days.
//
// This module is only imported lazily from sync.ts during a sync run, so a
// defect here can never break the server boot path.
// =============================================================================

import { getDb } from './db';

const GH_API = 'https://api.github.com/repos';
const DEFAULT_REPO_BUDGET = 60;
const REPO_RETRY_AFTER_DAYS = 30;
// After a 404 (repo gone/renamed), don't re-try it for 30 days; renamed repos
// self-heal when the package's github_url updates on the next npm metadata
// refresh (design D4).

// NOTE: GH_REPO_BUDGET / GITHUB_TOKEN are read from process.env at CALL time
// (not module load) so the sync picks up env changes and tests can toggle
// them per-case.

function repoBudget(): number {
  const raw = Number(process.env.GH_REPO_BUDGET ?? DEFAULT_REPO_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function githubToken(): string {
  return process.env.GITHUB_TOKEN ?? '';
}

export interface RepoMetaSyncResult {
  /** Number of repos actually fetched this run (0 when disabled). */
  fetched: number;
  /** Total distinct repos tracked in repo_meta. */
  total: number;
  /** True when the step stopped early due to a GitHub rate limit (403/429). */
  stoppedForRateLimit: boolean;
}

export function isRepoMetaEnabled(): boolean {
  return repoBudget() > 0;
}

export function repoMetaBudget(): number {
  return repoBudget();
}

/**
 * Parse a GitHub API repo response into the subset we store. All fields are
 * defensive: a removed/renamed field degrades to null, never a crash.
 */
function parseRepoPayload(body: any): {
  stars: number | null;
  forks: number | null;
  openIssues: number | null;
  license: string | null;
  archived: boolean;
  pushedAt: string | null;
} {
  return {
    stars: Number.isFinite(Number(body?.stargazers_count)) ? Number(body.stargazers_count) : null,
    forks: Number.isFinite(Number(body?.forks_count)) ? Number(body.forks_count) : null,
    openIssues: Number.isFinite(Number(body?.open_issues_count)) ? Number(body.open_issues_count) : null,
    license: body?.license?.spdx_id ? String(body.license.spdx_id) : null,
    archived: body?.archived === true,
    pushedAt: typeof body?.pushed_at === 'string' ? body.pushed_at : null,
  };
}

/**
 * Select the repos to fetch this run:
 *   - up to `budget` repos
 *   - NEVER-FETCHED FIRST: packages with a github_repo but no repo_meta row
 *     (rm.repo IS NULL) come first — these are repos npm sync discovered
 *     since the last enrichment run
 *   - then repos with the oldest fetched_at (round-robin aging)
 *   - repos that 404ed recently (stars IS NULL, fetched_at within
 *     REPO_RETRY_AFTER_DAYS) are skipped until the cooldown passes
 *   - only repos that still have a matching package row (packages.github_repo)
 */
function selectReposToFetch(db: ReturnType<typeof getDb>, budget: number): string[] {
  const rows = db.prepare(`
    SELECT p.github_repo AS repo
    FROM packages p
    LEFT JOIN repo_meta rm ON rm.repo = p.github_repo
    WHERE p.github_repo IS NOT NULL
      AND (
        rm.repo IS NULL
        OR (rm.stars IS NULL AND rm.fetched_at < datetime('now', '-${REPO_RETRY_AFTER_DAYS} days'))
        OR rm.stars IS NOT NULL
      )
    ORDER BY
      CASE WHEN rm.repo IS NULL THEN 0 ELSE 1 END,
      rm.fetched_at ASC,
      p.name ASC
    LIMIT ?
  `).all(budget) as Array<{ repo: string }>;
  return rows.map(r => r.repo);
}

/**
 * Fetch metadata for a single repo. Returns false when the step should stop
 * (rate limit).
 */
async function fetchOneRepo(
  repo: string,
  fetchFn: typeof fetch,
): Promise<{ ok: true; data: any } | { ok: false; stop: boolean; reason: string }> {
  const url = `${GH_API}/${repo}`;
  const token = githubToken();
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'pi-extension-dashboard',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetchFn(url, { headers });
  } catch (err) {
    return { ok: false, stop: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (res.status === 404) {
    return { ok: false, stop: false, reason: '404' };
  }
  if (res.status === 403 || res.status === 429) {
    // Rate limited (or abuse). Stop the whole step; don't hammer.
    return { ok: false, stop: true, reason: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    return { ok: false, stop: false, reason: `HTTP ${res.status}` };
  }

  let body: any;
  try {
    body = await res.json();
  } catch (err) {
    return { ok: false, stop: false, reason: 'malformed JSON' };
  }
  return { ok: true, data: body };
}

function upsertRepoMeta(
  db: ReturnType<typeof getDb>,
  repo: string,
  fields: {
    stars: number | null;
    forks: number | null;
    openIssues: number | null;
    license: string | null;
    archived: boolean;
    pushedAt: string | null;
  },
  fetchedAt: string,
): void {
  db.prepare(`
    INSERT INTO repo_meta (repo, stars, forks, open_issues, license, archived, pushed_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo) DO UPDATE SET
      stars = excluded.stars,
      forks = excluded.forks,
      open_issues = excluded.open_issues,
      license = excluded.license,
      archived = excluded.archived,
      pushed_at = excluded.pushed_at,
      fetched_at = excluded.fetched_at
  `).run(
    repo,
    fields.stars,
    fields.forks,
    fields.openIssues,
    fields.license,
    fields.archived ? 1 : 0,
    fields.pushedAt,
    fetchedAt,
  );
}

/**
 * Budgeted GitHub repo metadata sync. Best-effort by design: this is called
 * from sync.ts behind a try/catch and must never fail the npm sync.
 *
 * @param fetchFn - Injectable fetch for tests (defaults to global fetch).
 * @returns Summary of what happened.
 */
export async function syncRepoMeta(
  fetchFn: typeof fetch = fetch,
): Promise<RepoMetaSyncResult> {
  const db = getDb();
  const budget = repoBudget();

  if (budget <= 0) {
    return { fetched: 0, total: countTrackedRepos(db), stoppedForRateLimit: false };
  }

  const total = countTrackedRepos(db);
  if (!githubToken()) {
    console.log(`[Sync] GitHub repo meta: no GITHUB_TOKEN — unauth rate limit (60/hr), budget=${budget}`);
  }

  const repos = selectReposToFetch(db, budget);
  if (repos.length === 0) {
    return { fetched: 0, total, stoppedForRateLimit: false };
  }

  let fetched = 0;
  let stoppedForRateLimit = false;
  const nowIso = new Date().toISOString();

  for (const repo of repos) {
    const result = await fetchOneRepo(repo, fetchFn);
    if (result.ok) {
      const fields = parseRepoPayload(result.data);
      upsertRepoMeta(db, repo, fields, nowIso);
      fetched++;
    } else if (result.stop) {
      stoppedForRateLimit = true;
      console.warn(`[Sync] GitHub repo meta: ${result.reason} — stopping this run (rate limit), ${fetched}/${repos.length} done`);
      break;
    } else if (result.reason === '404') {
      // Repo gone/renamed: store nulls + fetched_at so it's not re-tried
      // every sync, but becomes eligible again after the cooldown (D4).
      upsertRepoMeta(db, repo, { stars: null, forks: null, openIssues: null, license: null, archived: false, pushedAt: null }, nowIso);
      fetched++;
    } else {
      console.warn(`[Sync] GitHub repo meta: skipping ${repo} (${result.reason})`);
    }
  }

  return { fetched, total: countTrackedRepos(db), stoppedForRateLimit };
}

function countTrackedRepos(db: ReturnType<typeof getDb>): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM repo_meta').get() as { c: number };
  return row.c;
}
