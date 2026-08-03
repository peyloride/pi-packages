import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { syncRepoMeta, isRepoMetaEnabled, repoMetaBudget } from './repoMeta';
import { normalizeGithubRepo } from './sync';
import { getDb } from './db';

// DB_PATH is ':memory:' for the test script, so getDb() gives an isolated
// in-memory DB per process. We wipe tables in beforeEach so each test starts
// clean, and seed packages with github_repo keys so the JOIN selects them.

function okResponse(body: any, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k] ?? null },
    json: async () => body,
  } as any;
}

function makeRepoPayload(over: Partial<any> = {}) {
  return {
    id: 1,
    name: 'repo',
    full_name: 'owner/repo',
    stargazers_count: 42,
    forks_count: 7,
    open_issues_count: 3,
    license: { spdx_id: 'MIT' },
    archived: false,
    pushed_at: '2026-01-15T00:00:00Z',
    ...over,
  };
}

function seedPackage(repo: string, name = `pkg-${repo.replace('/', '-')}`) {
  const db = getDb();
  db.prepare(`INSERT INTO packages (name, version, github_url, github_repo) VALUES (?, ?, ?, ?)`)
    .run(name, '1.0.0', `https://github.com/${repo}`, repo.toLowerCase());
}

function seedRepoMeta(repo: string, fetchedAtDaysAgo: number, stars: number | null = 1) {
  const db = getDb();
  const fetchedAt = new Date(Date.now() - fetchedAtDaysAgo * 86400000).toISOString();
  db.prepare(`INSERT INTO repo_meta (repo, stars, forks, open_issues, license, archived, pushed_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(repo, stars, 0, 0, null, 0, null, fetchedAt);
}

function setBudget(n: number) {
  (process.env as any).GH_REPO_BUDGET = String(n);
}

describe('repoMeta.ts', () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM repo_meta').run();
    db.prepare('DELETE FROM packages').run();
    setBudget(60); // default
  });

  afterEach(() => {
    delete (process.env as any).GH_REPO_BUDGET;
  });

  describe('normalizeGithubRepo', () => {
    it('parses a plain github.com URL to lowercased owner/repo', () => {
      assert.equal(normalizeGithubRepo('https://github.com/Org/Repo'), 'org/repo');
    });

    it('strips git+ prefix and .git suffix', () => {
      assert.equal(normalizeGithubRepo('git+https://github.com/owner/repo.git'), 'owner/repo');
    });

    it('returns null for non-github URLs and unparseable input', () => {
      assert.equal(normalizeGithubRepo('https://gitlab.com/owner/repo'), null);
      assert.equal(normalizeGithubRepo('https://github.com/onlyowner'), null);
      assert.equal(normalizeGithubRepo(null), null);
      assert.equal(normalizeGithubRepo(undefined), null);
    });
  });

  describe('syncRepoMeta', () => {
    it('is disabled when GH_REPO_BUDGET is 0 (no API calls, no error)', async () => {
      setBudget(0);
      seedPackage('owner/a');
      let calls = 0;
      const fetchFn: any = async () => { calls++; return okResponse(makeRepoPayload()); };
      const result = await syncRepoMeta(fetchFn);
      assert.equal(result.fetched, 0);
      assert.equal(result.stoppedForRateLimit, false);
      assert.equal(calls, 0);
    });

    it('fetches never-fetched repos first, up to the budget', async () => {
      const db = getDb();
      seedPackage('owner/a');
      seedPackage('owner/b');
      seedPackage('owner/c');
      seedRepoMeta('owner/b', 100); // already fetched 100d ago
      seedRepoMeta('owner/c', 200); // already fetched 200d ago
      // Never fetched: owner/a → should be picked first; then the OLDEST
      // fetched_at among fetched: owner/c (200d) beats owner/b (100d).
      setBudget(2);

      const seen: string[] = [];
      const fetchFn: any = async (url: string) => {
        seen.push(url);
        const repo = url.split('/repos/')[1] || '';
        return okResponse(makeRepoPayload({ full_name: repo }));
      };

      await syncRepoMeta(fetchFn);

      // owner/a never fetched → first; then oldest fetched_at (owner/c at 200d)
      assert.deepEqual(seen.map(u => u.split('/repos/')[1]), ['owner/a', 'owner/c']);
      const a = db.prepare('SELECT * FROM repo_meta WHERE repo = ?').get('owner/a') as any;
      assert.ok(a);
      assert.equal(a.stars, 42);
      assert.equal(a.forks, 7);
      assert.equal(a.open_issues, 3);
      assert.equal(a.license, 'MIT');
      assert.equal(a.archived, 0);
      assert.ok(a.fetched_at);
    });

    it('round-robins to the oldest fetched_at when all fetched (steady state)', async () => {
      const db = getDb();
      seedPackage('owner/x');
      seedPackage('owner/y');
      seedPackage('owner/z');
      seedRepoMeta('owner/x', 10);
      seedRepoMeta('owner/y', 20);
      seedRepoMeta('owner/z', 90);
      setBudget(1);

      const seen: string[] = [];
      const fetchFn: any = async (url: string) => {
        seen.push(url);
        return okResponse(makeRepoPayload());
      };

      await syncRepoMeta(fetchFn);
      // oldest fetched_at = owner/z (90 days)
      assert.deepEqual(seen.map(u => u.split('/repos/')[1]), ['owner/z']);
    });

    it('stores nulls + fetched_at on 404 and honors the retry cooldown', async () => {
      const db = getDb();
      seedPackage('gone/r');
      const fetchFn: any = async () => okResponse(null, 404);

      const r1 = await syncRepoMeta(fetchFn);
      assert.equal(r1.fetched, 1);
      const row = db.prepare('SELECT * FROM repo_meta WHERE repo = ?').get('gone/r') as any;
      assert.equal(row.stars, null);
      assert.ok(row.fetched_at);

      // Immediately after: cooldown active → not selected again
      fetchFn.mockClear?.();
      const r2 = await syncRepoMeta(fetchFn);
      assert.equal(r2.fetched, 0);

      // After cooldown (31 days): eligible again
      const db2 = getDb();
      db2.prepare('UPDATE repo_meta SET fetched_at = ? WHERE repo = ?')
        .run(new Date(Date.now() - 31 * 86400000).toISOString(), 'gone/r');
      const fetchFn3: any = async () => okResponse(makeRepoPayload());
      await syncRepoMeta(fetchFn3);
      const row3 = db2.prepare('SELECT * FROM repo_meta WHERE repo = ?').get('gone/r') as any;
      assert.equal(row3.stars, 42); // recovered after cooldown
    });

    it('stops on rate limit (429) and keeps partial results', async () => {
      const db = getDb();
      seedPackage('owner/a');
      seedPackage('owner/b');
      seedPackage('owner/c');
      setBudget(3);

      let calls = 0;
      const fetchFn: any = async () => {
        calls++;
        if (calls === 2) return okResponse(null, 429);
        return okResponse(makeRepoPayload());
      };

      const result = await syncRepoMeta(fetchFn);
      assert.equal(result.stoppedForRateLimit, true);
      assert.equal(result.fetched, 1);
      assert.equal(calls, 2); // stopped after the 429, did not continue to c
      const a = db.prepare('SELECT * FROM repo_meta WHERE repo = ?').get('owner/a') as any;
      assert.ok(a); // partial result persisted
      const c = db.prepare('SELECT * FROM repo_meta WHERE repo = ?').get('owner/c') as any;
      assert.equal(c, undefined); // never fetched
    });

    it('sends the Authorization Bearer header when GITHUB_TOKEN is set', async () => {
      seedPackage('owner/t');
      process.env.GITHUB_TOKEN = 'ghp_test123';
      let capturedInit: any;
      const fetchFn: any = async (_url: string, init: any) => {
        capturedInit = init;
        return okResponse(makeRepoPayload());
      };
      await syncRepoMeta(fetchFn);
      assert.ok(capturedInit);
      assert.equal(capturedInit.headers.Authorization, 'Bearer ghp_test123');
      delete process.env.GITHUB_TOKEN;
    });

    it('sends no Authorization header without a token', async () => {
      seedPackage('owner/n');
      delete process.env.GITHUB_TOKEN;
      let capturedInit: any;
      const fetchFn: any = async (_url: string, init: any) => {
        capturedInit = init;
        return okResponse(makeRepoPayload());
      };
      await syncRepoMeta(fetchFn);
      assert.equal(capturedInit.headers.Authorization, undefined);
    });

    it('continues past per-repo errors (5xx) and persists the successful ones', async () => {
      const db = getDb();
      seedPackage('owner/ok');
      seedPackage('owner/bad');
      setBudget(2);
      let calls = 0;
      const fetchFn: any = async () => {
        calls++;
        if (calls === 1) return okResponse(null, 500);
        return okResponse(makeRepoPayload());
      };
      const result = await syncRepoMeta(fetchFn);
      assert.equal(result.fetched, 1); // bad one skipped, good one persisted
      assert.equal(result.stoppedForRateLimit, false);
      const ok = db.prepare('SELECT * FROM repo_meta WHERE repo = ?').get('owner/ok') as any;
      assert.equal(ok?.stars, 42);
    });

    it('defends against malformed API JSON (degrades to nulls, no crash)', async () => {
      const db = getDb();
      seedPackage('weird/r');
      const fetchFn: any = async () => okResponse({ nope: true }); // not a repo payload
      await syncRepoMeta(fetchFn);
      const row = db.prepare('SELECT * FROM repo_meta WHERE repo = ?').get('weird/r') as any;
      assert.equal(row.stars, null);
      assert.equal(row.archived, 0);
      assert.ok(row.fetched_at);
    });

    it('reports the total tracked repo count', async () => {
      seedPackage('owner/a');
      seedPackage('owner/b');
      const fetchFn: any = async () => okResponse(makeRepoPayload());
      const r1 = await syncRepoMeta(fetchFn);
      assert.equal(r1.total, 2);
    });

    it('exposes budget helpers', () => {
      setBudget(7);
      assert.equal(isRepoMetaEnabled(), true);
      assert.equal(repoMetaBudget(), 7);
      setBudget(0);
      assert.equal(isRepoMetaEnabled(), false);
    });
  });
});
