import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchPiPackages,
  fetchDownloadsBatched,
  upsertPackage,
  upsertDownloads,
  diffPackages,
  runSync,
} from './sync';
import { getDb } from './db';

// -----------------------------------------------------------------------------
// Fetch stub — replaces Bun's `mock()` for global fetch with a small manual
// implementation that mirrors the bits of the API these tests rely on:
//   - mockResolvedValueOnce(value) queues the next response
//   - mockClear() resets both the call log and the queue
//   - mock.calls[i][0] is the URL of the i-th fetch invocation
// When the queue is empty, fetch resolves to a default "empty" npm response.
// -----------------------------------------------------------------------------
interface FetchStub {
  (url: string, init?: any): Promise<any>;
  mockClear: () => void;
  mockResolvedValueOnce: (value: any) => FetchStub;
  mock: { calls: any[][] };
}

function makeFetchStub(): FetchStub {
  const calls: any[][] = [];
  const queue: any[] = [];
  const fn = ((url: string, init?: any) => {
    calls.push([url, init]);
    const value = queue.length > 0 ? queue.shift() : { ok: true, json: async () => ({ objects: [], total: 0 }) };
    return Promise.resolve(value);
  }) as FetchStub;
  fn.mockClear = () => { calls.length = 0; queue.length = 0; };
  fn.mockResolvedValueOnce = (value: any) => { queue.push(value); return fn; };
  (fn as any).mock = { calls };
  Object.defineProperty(fn, 'mock', { value: { calls }, writable: false });
  return fn;
}

const originalFetch = globalThis.fetch as unknown as FetchStub;
const mockFetch = makeFetchStub();

before(() => {
  // Replace global fetch before any sync.ts code runs.
  globalThis.fetch = mockFetch as any;
});

after(() => {
  globalThis.fetch = originalFetch as any;
});

describe('sync.ts', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  describe('fetchPiPackages', () => {
    it('should fetch packages from npm registry', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          total: 1,
          objects: [{
            package: {
              name: 'test-pkg',
              version: '1.0.0',
              description: 'Test package',
              links: { npm: 'https://npmjs.com/test-pkg' }
            },
            updated: '2024-01-01'
          }]
        })
      });

      const packages = await fetchPiPackages();
      assert.equal(packages.length, 1);
      assert.equal(packages[0].package.name, 'test-pkg');
    });

    it('should handle fetch errors without retries on 4xx', async () => {
      // 403 doesn't trigger retries
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: { get: () => null },
      });

      await assert.rejects(() => fetchPiPackages(), /npm search failed/);
    });

    it('should construct correct npm search URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({ total: 0, objects: [] })
      });

      await fetchPiPackages();

      assert.ok(mockFetch.mock.calls.length > 0);
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      assert.ok(calledUrl.includes('text=keywords:pi-package'), `expected url to contain 'text=keywords:pi-package', got: ${calledUrl}`);
    });

    it('should handle pagination with multiple pages', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          total: 500,
          objects: Array(250).fill(null).map((_, i) => ({
            package: { name: `pkg-${i}`, version: '1.0.0', links: { npm: `https://npmjs.com/pkg-${i}` } },
            updated: '2024-01-01'
          }))
        })
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          total: 500,
          objects: Array(250).fill(null).map((_, i) => ({
            package: { name: `pkg2-${i}`, version: '1.0.0', links: { npm: `https://npmjs.com/pkg2-${i}` } },
            updated: '2024-01-01'
          }))
        })
      });

      const packages = await fetchPiPackages();
      assert.equal(packages.length, 500);
    });
  });

  describe('fetchDownloadsBatched', () => {
    it('should fetch downloads for multiple packages', async () => {
      const day1 = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const day2 = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          'pkg1': {
            downloads: [{ day: day1, downloads: 50 }, { day: day2, downloads: 50 }],
            package: 'pkg1',
            start: day2,
            end: day1
          },
          'pkg2': {
            downloads: [{ day: day1, downloads: 100 }, { day: day2, downloads: 100 }],
            package: 'pkg2',
            start: day2,
            end: day1
          }
        })
      });

      const downloads = await fetchDownloadsBatched(['pkg1', 'pkg2']);

      assert.equal(downloads.size, 2);
    });

    it('should handle empty package list', async () => {
      const downloads = await fetchDownloadsBatched([]);
      assert.equal(downloads.size, 0);
    });

    it('should handle failed fetch gracefully', async () => {
      // 403 doesn't trigger retries
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: { get: () => null },
      });

      const downloads = await fetchDownloadsBatched(['pkg1']);
      assert.equal(downloads.size, 0);
    });
  });

  describe('upsertPackage', () => {
    it('should insert package into database', () => {
      const pkgResult = {
        package: {
          name: 'test-pkg',
          version: '1.0.0',
          description: 'Test package',
          keywords: ['test', 'pi'],
          publisher: { username: 'testuser' },
          links: {
            npm: 'https://npmjs.com/test-pkg',
            repository: 'https://github.com/test/test-pkg'
          },
          date: '2024-01-01'
        },
        updated: '2024-01-15'
      };

      upsertPackage(pkgResult);

      const db = getDb();
      const pkg = db.prepare('SELECT * FROM packages WHERE name = ?').get('test-pkg');

      assert.ok(pkg);
      assert.equal((pkg as { version: string }).version, '1.0.0');
      assert.equal((pkg as { description: string }).description, 'Test package');
    });

    it('should clean GitHub URL (remove git+ prefix and .git suffix)', () => {
      const pkgResult = {
        package: {
          name: 'test-pkg2',
          version: '1.0.0',
          links: {
            repository: 'git+https://github.com/test/repo.git'
          }
        }
      };

      upsertPackage(pkgResult);

      const db = getDb();
      const pkg = db.prepare('SELECT github_url FROM packages WHERE name = ?').get('test-pkg2') as { github_url: string };

      assert.equal(pkg.github_url, 'https://github.com/test/repo');
    });

    it('should set publisher_display to the raw username for non-Actions publishers', () => {
      upsertPackage({
        package: {
          name: 'display-pkg',
          version: '1.0.0',
          publisher: { username: 'artale' },
          links: {
            npm: 'https://npmjs.com/display-pkg',
            repository: 'https://github.com/artale/display-pkg'
          }
        }
      });

      const db = getDb();
      const pkg = db.prepare('SELECT publisher, publisher_display FROM packages WHERE name = ?').get('display-pkg') as { publisher: string; publisher_display: string };

      assert.equal(pkg.publisher, 'artale');
      assert.equal(pkg.publisher_display, 'artale');
    });

    it('should resolve publisher_display to the GitHub owner for “GitHub Actions” publishers', () => {
      upsertPackage({
        package: {
          name: 'actions-pkg',
          version: '1.0.0',
          publisher: { username: 'GitHub Actions' },
          links: {
            npm: 'https://npmjs.com/actions-pkg',
            repository: 'https://github.com/MattDevy/pi-extensions'
          }
        }
      });

      const db = getDb();
      const pkg = db.prepare('SELECT publisher, publisher_display FROM packages WHERE name = ?').get('actions-pkg') as { publisher: string; publisher_display: string };

      assert.equal(pkg.publisher, 'GitHub Actions');
      assert.equal(pkg.publisher_display, 'MattDevy');
    });

    it('should store null publisher_display when no publisher and no repo', () => {
      upsertPackage({
        package: {
          name: 'anon-pkg',
          version: '1.0.0',
          links: { npm: 'https://npmjs.com/anon-pkg' }
        }
      });

      const db = getDb();
      const pkg = db.prepare('SELECT publisher, publisher_display, github_url FROM packages WHERE name = ?').get('anon-pkg') as { publisher: string | null; publisher_display: string | null; github_url: string | null };

      assert.equal(pkg.publisher, null);
      assert.equal(pkg.github_url, null);
      assert.equal(pkg.publisher_display, null);
    });
  });

  describe('upsertDownloads', () => {
    it('should insert download data with daily map', () => {
      upsertPackage({
        package: {
          name: 'test-pkg3',
          version: '1.0.0',
          links: { npm: 'https://npmjs.com/test-pkg3' }
        }
      });

      const today = new Date().toISOString().split('T')[0];
      const daily = new Map<string, number>();
      daily.set(today, 42);
      daily.set(new Date(Date.now() - 86400000).toISOString().split('T')[0], 10);

      upsertDownloads('test-pkg3', {
        daily,
        weekly: 52,
        monthly: 52,
        lastWeek: 10
      });

      const db = getDb();
      const downloads = db.prepare('SELECT * FROM daily_downloads WHERE package_name = ?').all('test-pkg3');

      assert.equal(downloads.length, 2);
    });

    it('should update existing download data by replacing', () => {
      upsertPackage({
        package: {
          name: 'test-pkg4',
          version: '1.0.0',
          links: { npm: 'https://npmjs.com/test-pkg4' }
        }
      });

      const today = new Date().toISOString().split('T')[0];

      // First insert
      upsertDownloads('test-pkg4', {
        daily: new Map([[today, 100]]),
        weekly: 100,
        monthly: 100,
        lastWeek: 0
      });

      // Replace with new values
      upsertDownloads('test-pkg4', {
        daily: new Map([[today, 200]]),
        weekly: 200,
        monthly: 200,
        lastWeek: 0
      });

      const db = getDb();
      const row = db.prepare('SELECT downloads FROM daily_downloads WHERE package_name = ? AND date = ?').get('test-pkg4', today) as { downloads: number };

      assert.equal(row.downloads, 200);
    });
  });

  describe('diffPackages', () => {
    it('should identify new, updated, and unchanged packages', () => {
      // Pre-populate DB with existing packages
      upsertPackage({
        package: { name: 'existing-pkg', version: '1.0.0', links: { npm: 'https://npmjs.com/existing-pkg' } },
        updated: '2024-01-01T00:00:00.000Z',
      });

      upsertPackage({
        package: { name: 'unchanged-pkg', version: '2.0.0', links: { npm: 'https://npmjs.com/unchanged-pkg' } },
        updated: '2024-06-01T00:00:00.000Z',
      });

      const fetchedPackages = [
        // New — not in DB
        { package: { name: 'brand-new-pkg', version: '0.1.0', links: { npm: 'https://npmjs.com/brand-new-pkg' } }, updated: '2024-07-01T00:00:00.000Z' },
        // Updated — version changed
        { package: { name: 'existing-pkg', version: '2.0.0', links: { npm: 'https://npmjs.com/existing-pkg' } }, updated: '2024-07-01T00:00:00.000Z' },
        // Unchanged
        { package: { name: 'unchanged-pkg', version: '2.0.0', links: { npm: 'https://npmjs.com/unchanged-pkg' } }, updated: '2024-06-01T00:00:00.000Z' },
      ];

      const diff = diffPackages(fetchedPackages);
      assert.equal(diff.newPackages.length, 1);
      assert.equal(diff.newPackages[0].package.name, 'brand-new-pkg');
      assert.equal(diff.updatedPackages.length, 1);
      assert.equal(diff.updatedPackages[0].package.name, 'existing-pkg');
      assert.equal(diff.unchangedPackages.length, 1);
      assert.equal(diff.unchangedPackages[0].package.name, 'unchanged-pkg');
    });
  });

  describe('runSync', () => {
    it('should be a function that can be called', () => {
      assert.equal(typeof runSync, 'function');
    });
  });

  describe('edge cases', () => {
    it('should handle packages with null description', () => {
      upsertPackage({
        package: {
          name: 'no-desc-pkg',
          version: '1.0.0',
          links: { npm: 'https://npmjs.com/no-desc-pkg' }
        }
      });

      const db = getDb();
      const pkg = db.prepare('SELECT * FROM packages WHERE name = ?').get('no-desc-pkg');

      assert.ok(pkg);
      assert.equal((pkg as { description: string | null }).description, null);
    });

    it('should handle packages with no keywords', () => {
      upsertPackage({
        package: {
          name: 'no-keywords-pkg',
          version: '1.0.0',
          description: 'Test',
          links: { npm: 'https://npmjs.com/no-keywords-pkg' }
        }
      });

      const db = getDb();
      const pkg = db.prepare('SELECT keywords FROM packages WHERE name = ?').get('no-keywords-pkg') as { keywords: string | null };

      assert.equal(pkg.keywords, null);
    });

    it('should handle packages with no publisher', () => {
      upsertPackage({
        package: {
          name: 'no-publisher-pkg',
          version: '1.0.0',
          description: 'Test',
          links: { npm: 'https://npmjs.com/no-publisher-pkg' }
        }
      });

      const db = getDb();
      const pkg = db.prepare('SELECT publisher FROM packages WHERE name = ?').get('no-publisher-pkg') as { publisher: string | null };

      assert.equal(pkg.publisher, null);
    });

    it('should handle packages with no repository link', () => {
      upsertPackage({
        package: {
          name: 'no-repo-pkg',
          version: '1.0.0',
          description: 'Test',
          links: { npm: 'https://npmjs.com/no-repo-pkg' }
        }
      });

      const db = getDb();
      const pkg = db.prepare('SELECT github_url FROM packages WHERE name = ?').get('no-repo-pkg') as { github_url: string | null };

      assert.equal(pkg.github_url, null);
    });
  });

  // ===========================================================================
  // Sync entry points — runIncrementalSync, runFullSync, runSync routing
  // ===========================================================================

  describe('runIncrementalSync', () => {
    let db: ReturnType<typeof getDb>;

    beforeEach(() => {
      db = getDb();
      db.prepare('DELETE FROM daily_downloads').run();
      db.prepare('DELETE FROM packages').run();
      db.prepare('DELETE FROM sync_meta').run();
      mockFetch.mockClear();
    });

    it('fetches packages, persists metadata + downloads, and returns an incremental SyncResult', async () => {
      const { runIncrementalSync } = await import('./sync');

      // 1st fetch: npm search API → 1 package
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          total: 1,
          objects: [{
            package: {
              name: 'sync-pkg',
              version: '1.0.0',
              description: 'A synced package',
              keywords: ['pi'],
              publisher: { username: 'testuser' },
              links: { npm: 'https://npmjs.com/sync-pkg', repository: 'https://github.com/test/sync-pkg' },
              date: '2024-01-01',
            },
            updated: '2024-01-15',
          }],
        }),
      });
      // 2nd fetch: bulk downloads API → 30 days of traffic
      const days = Array.from({ length: 30 }, (_, i) => ({
        day: new Date(Date.now() - i * 86400000).toISOString().split('T')[0],
        downloads: 100,
      }));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          'sync-pkg': { downloads: days, package: 'sync-pkg', start: days[29].day, end: days[0].day },
        }),
      });

      const result = await runIncrementalSync();

      assert.equal(result.mode, 'incremental');
      assert.equal(result.packages, 1);
      assert.equal(result.newPackages, 1);
      assert.equal(result.updatedPackages, 0);
      assert.ok(result.downloadsUpdated >= 1, `expected downloads persisted, got ${result.downloadsUpdated}`);

      // Package metadata persisted
      const pkg = db.prepare('SELECT name, description, version FROM packages WHERE name = ?').get('sync-pkg') as any;
      assert.ok(pkg);
      assert.equal(pkg.description, 'A synced package');
      assert.equal(pkg.version, '1.0.0');

      // Download rows persisted
      const dlCount = (db.prepare('SELECT COUNT(*) as c FROM daily_downloads WHERE package_name = ?').get('sync-pkg') as { c: number }).c;
      assert.ok(dlCount > 0, `expected download rows, got ${dlCount}`);

      // sync_meta timestamp recorded
      const meta = db.prepare("SELECT value FROM sync_meta WHERE key = 'last_incremental_sync'").get() as { value: string } | undefined;
      assert.ok(meta?.value);
    });

    it('records no new packages when the DB already matches npm', async () => {
      const { runIncrementalSync, upsertPackage } = await import('./sync');

      // Pre-populate the DB with the same package npm will return
      upsertPackage({
        package: { name: 'sync-pkg', version: '1.0.0', links: { npm: 'https://npmjs.com/sync-pkg' } },
        updated: '2024-01-15',
      });
      // Record a prior sync so delta logic has a baseline
      db.prepare("INSERT INTO sync_meta (key, value) VALUES ('last_incremental_sync', ?)").run(new Date(Date.now() - 86400000).toISOString());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          total: 1,
          objects: [{
            package: { name: 'sync-pkg', version: '1.0.0', links: { npm: 'https://npmjs.com/sync-pkg' } },
            updated: '2024-01-15',
          }],
        }),
      });
      // Unchanged packages still get a delta-range fetch (unless up-to-date).
      // day-after-last-sync → today is 1 day, so 1 fetch for downloads.
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          'sync-pkg': { downloads: [{ day: yesterday, downloads: 50 }, { day: today, downloads: 60 }], package: 'sync-pkg', start: yesterday, end: today },
        }),
      });

      const result = await runIncrementalSync();
      assert.equal(result.newPackages, 0);
      assert.equal(result.updatedPackages, 0);
      assert.equal(result.mode, 'incremental');
    });

    it('detects version changes as updates, not new packages', async () => {
      const { runIncrementalSync, upsertPackage } = await import('./sync');

      // DB has v1.0.0
      upsertPackage({
        package: { name: 'sync-pkg', version: '1.0.0', links: { npm: 'https://npmjs.com/sync-pkg' } },
        updated: '2024-01-15',
      });

      // npm returns v2.0.0
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          total: 1,
          objects: [{
            package: { name: 'sync-pkg', version: '2.0.0', links: { npm: 'https://npmjs.com/sync-pkg' } },
            updated: '2024-02-01',
          }],
        }),
      });
      const days = Array.from({ length: 30 }, (_, i) => ({
        day: new Date(Date.now() - i * 86400000).toISOString().split('T')[0],
        downloads: 10,
      }));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          'sync-pkg': { downloads: days, package: 'sync-pkg', start: days[29].day, end: days[0].day },
        }),
      });

      const result = await runIncrementalSync();
      assert.equal(result.newPackages, 0);
      assert.equal(result.updatedPackages, 1);
    });

    it('retains 60 days of download history (prunes only rows older than the window)', async () => {
      const { runIncrementalSync, upsertPackage } = await import('./sync');

      // An unchanged package with history both inside (45d) and outside (70d)
      // the 60-day retention window. Under the old 30-day retention the 45-day
      // row was pruned, which is exactly what starved monthly_growth.
      upsertPackage({
        package: { name: 'retain-pkg', version: '1.0.0', links: { npm: 'https://npmjs.com/retain-pkg' } },
        updated: '2024-01-15',
      });
      const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString().split('T')[0];
      const insert = db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)');
      insert.run('retain-pkg', day(1), 100);   // recent — always kept
      insert.run('retain-pkg', day(45), 100);  // kept under 60-day retention (pruned under old 30-day)
      insert.run('retain-pkg', day(70), 100);  // older than retention — always pruned

      // Record a prior sync (1 day ago) so the run is incremental and the
      // unchanged package counts as up-to-date (no downloads fetch needed) —
      // the retention prune still runs at the end of the write transaction.
      db.prepare("INSERT INTO sync_meta (key, value) VALUES ('last_incremental_sync', ?)").run(new Date(Date.now() - 86400000).toISOString());

      // npm search returns the same version → package is "unchanged".
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          total: 1,
          objects: [{ package: { name: 'retain-pkg', version: '1.0.0', links: { npm: 'https://npmjs.com/retain-pkg' } }, updated: '2024-01-15' }],
        }),
      });

      const result = await runIncrementalSync();
      assert.equal(result.mode, 'incremental');

      const dates = (db.prepare('SELECT date FROM daily_downloads WHERE package_name = ? ORDER BY date').all('retain-pkg') as Array<{ date: string }>).map(r => r.date);
      assert.ok(dates.includes(day(1)), 'recent row kept');
      assert.ok(dates.includes(day(45)), '45-day-old row kept (60-day retention)');
      assert.ok(!dates.includes(day(70)), '70-day-old row pruned (outside retention)');
    });
  });

  describe('runFullSync', () => {
    let db: ReturnType<typeof getDb>;

    beforeEach(() => {
      db = getDb();
      db.prepare('DELETE FROM daily_downloads').run();
      db.prepare('DELETE FROM packages').run();
      db.prepare('DELETE FROM sync_meta').run();
      mockFetch.mockClear();
    });

    it('fetches and persists ALL packages with full download history', async () => {
      const { runFullSync } = await import('./sync');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          total: 2,
          objects: [
            { package: { name: 'pkg-a', version: '1.0.0', links: { npm: 'https://npmjs.com/pkg-a' } }, updated: '2024-01-01' },
            { package: { name: 'pkg-b', version: '2.0.0', links: { npm: 'https://npmjs.com/pkg-b' } }, updated: '2024-01-02' },
          ],
        }),
      });
      const days = Array.from({ length: 30 }, (_, i) => ({
        day: new Date(Date.now() - i * 86400000).toISOString().split('T')[0],
        downloads: 50,
      }));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          'pkg-a': { downloads: days, package: 'pkg-a', start: days[29].day, end: days[0].day },
          'pkg-b': { downloads: days, package: 'pkg-b', start: days[29].day, end: days[0].day },
        }),
      });

      const result = await runFullSync();
      assert.equal(result.mode, 'full');
      assert.equal(result.packages, 2);
      assert.ok(result.downloadsUpdated >= 1);

      const count = (db.prepare('SELECT COUNT(*) as c FROM packages').get() as { c: number }).c;
      assert.equal(count, 2);
    });

    it('skips persisting packages with zero traffic', async () => {
      const { runFullSync } = await import('./sync');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          total: 1,
          objects: [{ package: { name: 'dead-pkg', version: '1.0.0', links: { npm: 'https://npmjs.com/dead-pkg' } }, updated: '2024-01-01' }],
        }),
      });
      const days = Array.from({ length: 30 }, (_, i) => ({
        day: new Date(Date.now() - i * 86400000).toISOString().split('T')[0],
        downloads: 0,
      }));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          'dead-pkg': { downloads: days, package: 'dead-pkg', start: days[29].day, end: days[0].day },
        }),
      });

      const result = await runFullSync();
      assert.equal(result.packages, 1);
      // Package metadata IS persisted (it just has no download rows)
      const pkg = db.prepare('SELECT name FROM packages WHERE name = ?').get('dead-pkg');
      assert.ok(pkg);
    });
  });

  describe('runSync routing', () => {
    let db: ReturnType<typeof getDb>;

    beforeEach(() => {
      db = getDb();
      db.prepare('DELETE FROM daily_downloads').run();
      db.prepare('DELETE FROM packages').run();
      db.prepare('DELETE FROM sync_meta').run();
      mockFetch.mockClear();
    });

    function queueTwoPackagesFetches() {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          total: 1,
          objects: [{ package: { name: 'routed-pkg', version: '1.0.0', links: { npm: 'https://npmjs.com/routed-pkg' } }, updated: '2024-01-01' }],
        }),
      });
      const days = Array.from({ length: 30 }, (_, i) => ({
        day: new Date(Date.now() - i * 86400000).toISOString().split('T')[0],
        downloads: 100,
      }));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          'routed-pkg': { downloads: days, package: 'routed-pkg', start: days[29].day, end: days[0].day },
        }),
      });
    }

    it('routes to runFullSync when --full is in process.argv', async () => {
      const { runSync } = await import('./sync');
      const hadFullFlag = process.argv.includes('--full');
      process.argv.push('--full');
      try {
        queueTwoPackagesFetches();
        const result = await runSync();
        assert.equal(result.mode, 'full');
      } finally {
        if (!hadFullFlag) {
          const idx = process.argv.lastIndexOf('--full');
          if (idx >= 0) process.argv.splice(idx, 1);
        }
      }
    });

    it('routes to runFullSync when no previous sync exists', async () => {
      const { runSync } = await import('./sync');
      // sync_meta is empty (beforeEach cleared it) → no last_incremental_sync
      queueTwoPackagesFetches();
      const result = await runSync();
      assert.equal(result.mode, 'full');
    });

    it('routes to runIncrementalSync when a previous sync exists', async () => {
      const { runSync } = await import('./sync');
      db.prepare("INSERT INTO sync_meta (key, value) VALUES ('last_incremental_sync', ?)")
        .run(new Date(Date.now() - 3600000).toISOString()); // 1h ago
      queueTwoPackagesFetches();
      const result = await runSync();
      assert.equal(result.mode, 'incremental');
    });
  });

  describe('npmFetch retry behaviour', () => {
    beforeEach(() => {
      mockFetch.mockClear();
    });

    it('retries on 429 and returns the successful response', async () => {
      const { fetchPiPackages } = await import('./sync');

      // First call: 429 → triggers retry. Second call: 200 with empty results.
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: { get: () => null },
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({ total: 0, objects: [] }),
      });

      const packages = await fetchPiPackages();
      assert.equal(packages.length, 0);
      assert.equal(mockFetch.mock.calls.length, 2, 'expected one retry after 429');
    });

    it('retries on 5xx and returns the successful response', async () => {
      const { fetchPiPackages } = await import('./sync');

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: { get: () => null },
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({ total: 0, objects: [] }),
      });

      const packages = await fetchPiPackages();
      assert.equal(packages.length, 0);
      assert.equal(mockFetch.mock.calls.length, 2, 'expected one retry after 503');
    });

    it('honours Retry-After header on 429', async () => {
      const { fetchPiPackages } = await import('./sync');

      // Retry-After: 0 → delay = max(0, RETRY_BASE_DELAY) = RETRY_BASE_DELAY
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: { get: (h: string) => h === 'Retry-After' ? '0' : null },
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({ total: 0, objects: [] }),
      });

      const t0 = Date.now();
      await fetchPiPackages();
      const elapsed = Date.now() - t0;
      // Should have slept at least RETRY_BASE_DELAY (~2s) before the retry
      assert.ok(elapsed >= 1500, `expected backoff delay, elapsed=${elapsed}ms`);
    });
  });
});
