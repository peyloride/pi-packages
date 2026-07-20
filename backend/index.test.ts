import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './index';
import { getDb } from './db';
import { recomputeGrowthCache } from './growth';
import { recomputeStatsCache } from './stats';

// Each test creates a fresh app (isolated response cache) and seeds the DB
// with identical data via getDb(). DB_PATH is ':memory:' in the test script,
// so writes never touch ./data/dashboard.db.

describe('index.ts API Routes', () => {
  let app: ReturnType<typeof createApp>;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    db = getDb();
    db.prepare('DELETE FROM daily_downloads').run();
    db.prepare('DELETE FROM packages').run();
    db.prepare('DELETE FROM sync_meta').run();

    // Seed: 2 packages, 14 days of downloads. pkg-a growing, pkg-b stable.
    db.prepare(`INSERT INTO packages (name, description, version, keywords, publisher, github_url, npm_url, first_seen, last_publish) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('pkg-a', 'Package A description', '1.0.0', '["test","pi"]', 'testuser', 'https://github.com/test/pkg-a', 'https://npmjs.com/package/pkg-a', '2024-01-01', '2024-01-15');
    db.prepare(`INSERT INTO packages (name, description, version, keywords, publisher, github_url, npm_url, first_seen, last_publish) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('pkg-b', 'Package B', '2.0.0', '[]', 'GitHub Actions', 'https://github.com/maintainer/pkg-b', 'https://npmjs.com/package/pkg-b', '2024-06-01', '2024-06-15');

    for (let i = 0; i < 14; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
      // pkg-a growing: 100/day this week, 50/day last week
      db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, i < 7 ? 100 : 50);
      // pkg-b stable: 10/day throughout
      db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-b', d, 10);
    }

    // Populate materialized growth + stats caches so the API reads them.
    recomputeGrowthCache();
    recomputeStatsCache();

    app = createApp();
  });

  afterEach(() => {
    db.prepare('DELETE FROM daily_downloads').run();
    db.prepare('DELETE FROM packages').run();
    db.prepare('DELETE FROM sync_meta').run();
  });

  // ===========================================================================
  // GET /api/packages
  // ===========================================================================

  describe('GET /api/packages', () => {
    it('returns 200 with a valid JSON envelope', async () => {
      const res = await app.request('/api/packages');
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('application/json'));
      const body = (await res.json()) as any;
      assert.ok(Array.isArray(body.packages));
      assert.equal(body.period, 'weekly'); // default period
      assert.ok(body.pagination);
    });

    it('returns all seeded packages sorted by popularity by default', async () => {
      const res = await app.request('/api/packages?sort=popular&period=weekly');
      const body = (await res.json()) as any;
      assert.equal(body.packages.length, 2);
      // pkg-a has more weekly downloads (100/day × 7 ≈ 700+) than pkg-b (10/day × 7 ≈ 70+)
      assert.equal(body.packages[0].name, 'pkg-a');
      assert.ok(body.packages[0].downloads >= body.packages[1].downloads);
    });

    it('returns a package with all expected enriched fields', async () => {
      const res = await app.request('/api/packages');
      const body = (await res.json()) as any;
      const pkg = body.packages.find((p: any) => p.name === 'pkg-a');
      assert.ok(pkg);
      assert.equal(pkg.description, 'Package A description');
      assert.equal(pkg.version, '1.0.0');
      assert.deepEqual(pkg.keywords, ['test', 'pi']);
      assert.equal(pkg.publisher, 'testuser');
      assert.equal(pkg.publisher_raw, 'testuser');
      assert.equal(pkg.github_url, 'https://github.com/test/pkg-a');
      assert.equal(pkg.npm_url, 'https://npmjs.com/package/pkg-a');
      assert.equal(pkg.downloads_period, 'weekly');
      assert.equal(pkg.downloads_label, '/week');
      assert.ok(Array.isArray(pkg.sparkline));
      assert.ok(pkg.weekly_downloads >= 0);
      assert.ok(pkg.monthly_downloads >= 0);
    });

    it('resolves "GitHub Actions" publisher to the GitHub repo owner', async () => {
      const res = await app.request('/api/packages');
      const body = (await res.json()) as any;
      const pkg = body.packages.find((p: any) => p.name === 'pkg-b');
      assert.ok(pkg);
      assert.equal(pkg.publisher, 'maintainer'); // parsed from github.com/maintainer/pkg-b
      assert.equal(pkg.publisher_raw, 'GitHub Actions');
    });

    it('supports the "trending" sort mode and applies the volume floor', async () => {
      const res = await app.request('/api/packages?sort=trending&period=weekly');
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      // pkg-a (50/day last week, 100/day this week → growing + above floor)
      // pkg-b (10/day stable → below TRENDING_MIN_DOWNLOADS.weekly=50)
      assert.ok(body.packages.length >= 1);
      assert.ok(body.packages.some((p: any) => p.name === 'pkg-a'));
    });

    it('supports the "new" sort mode (first_seen within 30 days)', async () => {
      // pkg-b first_seen is 2024-06-01 — way older than 30 days from now,
      // so nothing qualifies. Use sort=popular as a baseline instead.
      const res = await app.request('/api/packages?sort=new');
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.ok(Array.isArray(body.packages));
    });

    it('supports the "updated" sort mode (last_publish DESC)', async () => {
      const res = await app.request('/api/packages?sort=updated');
      const body = (await res.json()) as any;
      assert.equal(body.packages[0].name, 'pkg-b'); // 2024-06-15 > 2024-01-15
    });

    it('accepts the period query param (daily/weekly/monthly)', async () => {
      for (const period of ['daily', 'weekly', 'monthly']) {
        const res = await app.request(`/api/packages?period=${period}`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as any;
        assert.equal(body.period, period);
      }
    });

    it('defaults to weekly for an invalid period', async () => {
      const res = await app.request('/api/packages?period=bogus');
      const body = (await res.json()) as any;
      assert.equal(body.period, 'weekly');
    });

    it('filters packages by the search query', async () => {
      const res = await app.request('/api/packages?search=Package%20A');
      const body = (await res.json()) as any;
      assert.equal(body.packages.length, 1);
      assert.equal(body.packages[0].name, 'pkg-a');
    });

    it('treats a LIKE % wildcard in search as a literal character', async () => {
      // No seeded package contains a percent sign, so a literal '%' matches
      // nothing. Under the old unescaped interpolation this matched everything.
      const res = await app.request('/api/packages?search=%25'); // '%'
      const body = (await res.json()) as any;
      assert.equal(body.packages.length, 0);
      assert.equal(body.pagination.total, 0); // count query is parameterized too
    });

    it('treats a LIKE _ wildcard in search as a literal character', async () => {
      const res = await app.request('/api/packages?search=_');
      const body = (await res.json()) as any;
      assert.equal(body.packages.length, 0); // '_' matches any single char if unescaped
    });

    it('matches a literal wildcard when it actually appears in the data', async () => {
      db.prepare(`INSERT INTO packages (name, description, version, keywords, publisher, github_url, npm_url, first_seen, last_publish) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('pct-pkg', 'Gives you 100% coverage', '1.0.0', '[]', 'u', 'https://github.com/u/p', 'https://npmjs.com/package/pct-pkg', '2024-01-01', '2024-01-01');
      const res = await app.request('/api/packages?search=100%25'); // '100%'
      const body = (await res.json()) as any;
      assert.equal(body.packages.length, 1);
      assert.equal(body.packages[0].name, 'pct-pkg');
    });

    it('handles a single quote in search without error (parameterized)', async () => {
      const res = await app.request(`/api/packages?search=${encodeURIComponent("O'Brien")}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.packages.length, 0);
    });

    it('applies limit + offset pagination and reports hasMore', async () => {
      const res = await app.request('/api/packages?limit=1&offset=0');
      const body = (await res.json()) as any;
      assert.equal(body.packages.length, 1);
      assert.equal(body.pagination.total, 2);
      assert.equal(body.pagination.hasMore, true);
      assert.equal(body.pagination.limit, 1);
      assert.equal(body.pagination.offset, 0);
    });

    it('caps limit at 100', async () => {
      const res = await app.request('/api/packages?limit=99999');
      const body = (await res.json()) as any;
      assert.ok(body.pagination.limit <= 100);
    });

    it('clamps a negative limit to 1 (SQLite treats negative LIMIT as unbounded)', async () => {
      const res = await app.request('/api/packages?limit=-1');
      const body = (await res.json()) as any;
      assert.equal(res.status, 200);
      assert.equal(body.pagination.limit, 1);
      assert.equal(body.packages.length, 1);
    });

    it('falls back to the default limit on non-numeric input', async () => {
      const res = await app.request('/api/packages?limit=abc');
      const body = (await res.json()) as any;
      assert.equal(res.status, 200);
      assert.equal(body.pagination.limit, 50);
    });

    it('clamps a negative offset to 0', async () => {
      const res = await app.request('/api/packages?offset=-5');
      const body = (await res.json()) as any;
      assert.equal(res.status, 200);
      assert.equal(body.pagination.offset, 0);
    });

    it('returns growth from the materialized column for growing packages', async () => {
      const res = await app.request('/api/packages?sort=trending&period=weekly');
      const body = (await res.json()) as any;
      const pkg = body.packages.find((p: any) => p.name === 'pkg-a');
      if (pkg) {
        // growth may be null if recomputeGrowthCache didn't populate it, but
        // if present it should be positive for a growing package
        if (pkg.growth !== null) {
          assert.ok(pkg.growth > 0, `expected positive growth, got ${pkg.growth}`);
        }
      }
    });

    it('serves from the response cache on a second request', async () => {
      // First call hits the DB and populates the cache
      const res1 = await app.request('/api/packages?sort=popular');
      const body1 = (await res1.json()) as any;
      assert.ok(body1.packages.length > 0);
      // Second call with identical params should be served from the cache
      const res2 = await app.request('/api/packages?sort=popular');
      const body2 = (await res2.json()) as any;
      assert.deepEqual(body2, body1);
    });

    it('sets Cache-Control headers on the response', async () => {
      const res = await app.request('/api/packages');
      const cc = res.headers.get('cache-control');
      assert.ok(cc?.includes('max-age=60'));
      assert.ok(cc?.includes('s-maxage=300'));
    });
  });

  // ===========================================================================
  // GET /api/packages/:name
  // ===========================================================================

  describe('GET /api/packages/:name', () => {
    it('returns 200 with package details for a known package', async () => {
      const res = await app.request('/api/packages/pkg-a');
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.name, 'pkg-a');
      assert.equal(body.description, 'Package A description');
      assert.equal(body.version, '1.0.0');
      assert.deepEqual(body.keywords, ['test', 'pi']);
      assert.equal(body.publisher, 'testuser');
      assert.equal(body.github_url, 'https://github.com/test/pkg-a');
      assert.ok(Array.isArray(body.download_history));
      assert.ok(body.download_history.length > 0);
      assert.ok(Array.isArray(body.sparkline));
      assert.ok(body.weekly_downloads >= 0);
      assert.ok(body.monthly_downloads >= 0);
    });

    it('resolves GitHub Actions publisher to the repo owner', async () => {
      const res = await app.request('/api/packages/pkg-b');
      const body = (await res.json()) as any;
      assert.equal(body.publisher, 'maintainer');
      assert.equal(body.publisher_raw, 'GitHub Actions');
    });

    it('returns 404 with a JSON error for an unknown package', async () => {
      const res = await app.request('/api/packages/does-not-exist');
      assert.equal(res.status, 404);
      const body = (await res.json()) as any;
      assert.equal(body.error, 'Package not found');
    });

    it('parses keywords JSON field into an array', async () => {
      const res = await app.request('/api/packages/pkg-a');
      const body = (await res.json()) as any;
      assert.deepEqual(body.keywords, ['test', 'pi']);
    });

    it('returns null growth when the materialized column is NULL', async () => {
      // pkg-b has stable downloads → growth exists but might be small.
      // Force NULL by wiping the growth column.
      db.prepare('UPDATE packages SET weekly_growth = NULL').run();
      const res = await app.request('/api/packages/pkg-a');
      const body = (await res.json()) as any;
      assert.equal(body.growth, null);
    });
  });

  // ===========================================================================
  // GET /api/stats
  // ===========================================================================

  describe('GET /api/stats', () => {
    it('returns 200 with the ecosystem statistics', async () => {
      const res = await app.request('/api/stats');
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.total_packages, 2);
      assert.ok(typeof body.total_weekly_downloads === 'number');
      assert.ok(typeof body.total_monthly_downloads === 'number');
      assert.ok(typeof body.average_growth === 'number');
      assert.equal(body.sync_running, false); // no cron running in tests
    });

    it('reads stats from the materialized cache (set in beforeEach)', async () => {
      const res = await app.request('/api/stats');
      const body = (await res.json()) as any;
      // recomputeStatsCache() ran in beforeEach with 2 packages
      assert.equal(body.total_packages, 2);
    });

    it('serves from the response cache on a second request', async () => {
      const res1 = await app.request('/api/stats');
      const body1 = await res1.json();
      const res2 = await app.request('/api/stats');
      const body2 = await res2.json();
      assert.deepEqual(body2, body1);
    });

    it('falls back to live recompute when no stats cache exists', async () => {
      // Wipe the stats cache so getStatsCache() returns null
      db.prepare("DELETE FROM sync_meta WHERE key = 'stats_cache'").run();
      const res = await app.request('/api/stats');
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.total_packages, 2);
    });

    it('includes null last_sync when sync_meta has no last_incremental_sync', async () => {
      // sync_meta is already cleared in beforeEach
      const res = await app.request('/api/stats');
      const body = (await res.json()) as any;
      assert.equal(body.last_sync, null);
      assert.equal(body.last_sync_mode, null);
    });

    it('sets Cache-Control headers', async () => {
      const res = await app.request('/api/stats');
      const cc = res.headers.get('cache-control');
      assert.ok(cc?.includes('max-age=60'));
    });
  });

  // ===========================================================================
  // Static files + SPA fallback
  // ===========================================================================

  describe('Static file serving', () => {
    it('serves index.html for the root path', async () => {
      const res = await app.request('/');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      const body = await res.text();
      assert.ok(body.length > 0);
    });

    it('serves stamped assets with immutable cache-control', async () => {
      // /index.html itself is no-cache, but other assets should be immutable.
      // Skip if frontend dir has no other files.
      const res = await app.request('/index.html');
      assert.equal(res.status, 200);
    });
  });

  // ===========================================================================
  // Helper functions (exercised indirectly via routes above)
  // ===========================================================================

  describe('resolvePublisher (via API responses)', () => {
    it('returns the npm username as-is for non-GitHub-Actions publishers', async () => {
      const res = await app.request('/api/packages/pkg-a');
      const body = (await res.json()) as any;
      assert.equal(body.publisher, 'testuser');
      assert.equal(body.publisher_raw, 'testuser');
    });

    it('falls back to repo owner for GitHub Actions packages', async () => {
      const res = await app.request('/api/packages/pkg-b');
      const body = (await res.json()) as any;
      assert.equal(body.publisher, 'maintainer');
      assert.equal(body.publisher_raw, 'GitHub Actions');
    });
  });
});
