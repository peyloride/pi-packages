import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { recomputeEcosystemCache, getEcosystemCache } from './ecosystem';
import { recomputeGrowthCache } from './growth';
import { getDb } from './db';

// DB_PATH is ':memory:' in the test script, so writes never touch
// ./data/dashboard.db.

function dayKey(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 86400000).toISOString().split('T')[0];
}

/**
 * Insert a package + N days of downloads (default 14 days ending today).
 */
function seedPackage(
  db: ReturnType<typeof getDb>,
  name: string,
  opts: { publisher?: string; githubUrl?: string; downloadsPerDay?: number[] } = {},
) {
  const { publisher = 'testuser', githubUrl = `https://github.com/test/${name}`, downloadsPerDay = [] } = opts;
  db.prepare(`INSERT INTO packages (name, description, version, keywords, publisher, github_url, npm_url, first_seen, last_publish)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, `desc ${name}`, '1.0.0', '[]', publisher, githubUrl, `https://npmjs.com/package/${name}`, '2024-01-01', '2024-01-15');
  for (let i = 0; i < downloadsPerDay.length; i++) {
    db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)')
      .run(name, dayKey(i), downloadsPerDay[i]);
  }
}

describe('ecosystem.ts', () => {
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    db = getDb();
    db.prepare('DELETE FROM daily_downloads').run();
    db.prepare('DELETE FROM packages').run();
    db.prepare('DELETE FROM sync_meta').run();
  });

  afterEach(() => {
    db.prepare('DELETE FROM daily_downloads').run();
    db.prepare('DELETE FROM packages').run();
    db.prepare('DELETE FROM sync_meta').run();
  });

  describe('recomputeEcosystemCache (empty DB)', () => {
    it('returns the full shape with zero/empty values (never missing fields)', () => {
      const eco = recomputeEcosystemCache();
      assert.equal(eco.total_packages, 0);
      assert.equal(eco.active_packages_30d, 0);
      assert.equal(eco.downloads_series.length, 60);
      assert.ok(eco.downloads_series.every((d) => d.downloads === 0));
      assert.deepEqual(eco.top_publishers.by_packages, []);
      assert.deepEqual(eco.top_publishers.by_downloads, []);
      assert.deepEqual(eco.top_packages, []);
      assert.equal(eco.distribution.p50, null);
      assert.equal(eco.distribution.p90, null);
      assert.equal(eco.distribution.p99, null);
      assert.equal(eco.distribution.median_growth, null);
      assert.ok(eco.computed_at);
    });
  });

  describe('downloads_series', () => {
    it('covers exactly 60 days, oldest → newest, zero-filled for sparse days', () => {
      // Only 3 days of data (today, 30 days ago, 59 days ago); everything
      // else should be zero-filled and present.
      seedPackage(db, 'pkg-a', {
        downloadsPerDay: [100, 70, 5], // offsets 0, 1, 2
      });
      db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', dayKey(30), 42);
      db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', dayKey(59), 9);

      const eco = recomputeEcosystemCache();
      const series = eco.downloads_series;
      assert.equal(series.length, 60);
      assert.equal(series[0].date, dayKey(59));
      assert.equal(series[59].date, dayKey(0));

      const totals: Record<string, number> = {};
      for (const d of series) totals[d.date] = d.downloads;
      assert.equal(totals[dayKey(0)], 100);
      assert.equal(totals[dayKey(30)], 42);
      assert.equal(totals[dayKey(59)], 9);
      // A sparse middle day is present with 0.
      assert.equal(totals[dayKey(40)], 0);

      // Ascending order.
      for (let i = 1; i < series.length; i++) {
        assert.ok(series[i].date > series[i - 1].date, `series not ascending at ${i}`);
      }
    });
  });

  describe('top_packages', () => {
    it('ranks by 30-day downloads descending, ties broken by name asc', () => {
      seedPackage(db, 'pkg-hi', { downloadsPerDay: Array(5).fill(100) }); // 500
      seedPackage(db, 'pkg-lo', { downloadsPerDay: Array(5).fill(10) });  // 50
      seedPackage(db, 'pkg-tie-a', { downloadsPerDay: Array(2).fill(25) }); // 50
      seedPackage(db, 'pkg-tie-b', { downloadsPerDay: Array(2).fill(25) }); // 50

      recomputeGrowthCache();
      const eco = recomputeEcosystemCache();
      const top = eco.top_packages;
      assert.equal(top.length, 4);
      assert.equal(top[0].name, 'pkg-hi');
      assert.equal(top[0].downloads, 500);
      // The 50-download tie resolves by name ascending.
      assert.deepEqual(
        top.slice(1).map((p) => p.name),
        ['pkg-lo', 'pkg-tie-a', 'pkg-tie-b'],
      );
      assert.ok(top.every((p) => typeof p.growth === 'number' || p.growth === null));
    });

    it('caps at TOP_N (10) packages', () => {
      for (let i = 0; i < 12; i++) {
        seedPackage(db, `pkg-${String(i).padStart(2, '0')}`, { downloadsPerDay: Array(3).fill(10) });
      }
      const eco = recomputeEcosystemCache();
      assert.equal(eco.top_packages.length, 10);
    });
  });

  describe('distribution percentiles', () => {
    it('computes p50/p90/p99 from packages with 30-day downloads', () => {
      // 10 packages with totals 1..10 → p50=5, p90=9, p99=9 (offset floors).
      for (let i = 1; i <= 10; i++) {
        seedPackage(db, `pkg-${i}`, { downloadsPerDay: Array(i).fill(1) });
      }
      recomputeGrowthCache();
      const eco = recomputeEcosystemCache();
      assert.equal(eco.active_packages_30d, 10);
      const { p50, p90, p99 } = eco.distribution;
      assert.ok(typeof p50 === 'number' && p50 >= 0);
      assert.ok(typeof p90 === 'number');
      assert.ok(typeof p99 === 'number');
      assert.ok(p50! <= p90!, `expected p50<=p90, got ${p50} vs ${p90}`);
      assert.ok(p90! <= p99!, `expected p90<=p99, got ${p90} vs ${p99}`);
    });

    it('returns null percentiles when no package has downloads in 30 days', () => {
      seedPackage(db, 'pkg-zero', { downloadsPerDay: [] });
      const eco = recomputeEcosystemCache();
      assert.equal(eco.active_packages_30d, 0);
      assert.deepEqual(eco.distribution, { p50: null, p90: null, p99: null, median_growth: null });
    });

    it('computes median_growth as the median of non-null weekly_growth', () => {
      seedPackage(db, 'pkg-a', { downloadsPerDay: Array(7).fill(100) });
      seedPackage(db, 'pkg-b', { downloadsPerDay: Array(7).fill(100) });
      seedPackage(db, 'pkg-c', { downloadsPerDay: Array(7).fill(100) });
      // Set growth values: 10, 20, 30 (median 20); pkg-d has NULL.
      seedPackage(db, 'pkg-d', { downloadsPerDay: Array(7).fill(100) });
      db.prepare('UPDATE packages SET weekly_growth = 10 WHERE name = ?').run('pkg-a');
      db.prepare('UPDATE packages SET weekly_growth = 20 WHERE name = ?').run('pkg-b');
      db.prepare('UPDATE packages SET weekly_growth = 30 WHERE name = ?').run('pkg-c');
      db.prepare('UPDATE packages SET weekly_growth = NULL WHERE name = ?').run('pkg-d');

      recomputeGrowthCache(); // resets growth per active packages
      // NOTE: recomputeGrowthCache may overwrite our manual values; set them
      // AFTER it so the test owns the growth values.
      db.prepare('UPDATE packages SET weekly_growth = 10 WHERE name = ?').run('pkg-a');
      db.prepare('UPDATE packages SET weekly_growth = 20 WHERE name = ?').run('pkg-b');
      db.prepare('UPDATE packages SET weekly_growth = 30 WHERE name = ?').run('pkg-c');

      const eco = recomputeEcosystemCache();
      assert.equal(eco.distribution.median_growth, 20);
    });
  });

  describe('top_publishers', () => {
    it('ranks by package count and by 30-day downloads, with display-name resolution', () => {
      // 'GitHub Actions' with a github_url resolves to the repo owner.
      seedPackage(db, 'pkg-gh-1', { publisher: 'GitHub Actions', githubUrl: 'https://github.com/owner-a/repo-1' });
      seedPackage(db, 'pkg-gh-2', { publisher: 'GitHub Actions', githubUrl: 'https://github.com/owner-a/repo-2' });
      // Regular publisher with lots of downloads.
      seedPackage(db, 'pkg-regular', { publisher: 'heavy', downloadsPerDay: Array(10).fill(50) });

      recomputeGrowthCache();
      const eco = recomputeEcosystemCache();

      // By packages: owner-a (2) beats heavy (1).
      assert.equal(eco.top_publishers.by_packages[0].publisher, 'owner-a');
      assert.equal(eco.top_publishers.by_packages[0].packages, 2);
      assert.equal(eco.top_publishers.by_packages[0].downloads, 0); // gh pkgs have no downloads

      // By downloads: heavy (500) beats owner-a (0).
      assert.equal(eco.top_publishers.by_downloads[0].publisher, 'heavy');
      assert.equal(eco.top_publishers.by_downloads[0].downloads, 500);
      assert.ok(eco.top_publishers.by_downloads.some((p) => p.publisher === 'owner-a'));
    });

    it('caps both lists at 10 publishers', () => {
      for (let i = 0; i < 12; i++) {
        seedPackage(db, `pkg-${i}`, { publisher: `pub-${i}` });
      }
      const eco = recomputeEcosystemCache();
      assert.equal(eco.top_publishers.by_packages.length, 10);
      assert.equal(eco.top_publishers.by_downloads.length, 10);
    });

    it('handles null publisher groups under a (unknown) display name', () => {
      seedPackage(db, 'pkg-nullpub', { publisher: '', githubUrl: '' });
      db.prepare('UPDATE packages SET publisher = NULL WHERE name = ?').run('pkg-nullpub');
      const eco = recomputeEcosystemCache();
      assert.ok(eco.top_publishers.by_packages.some((p) => p.publisher === '(unknown)'));
    });
  });

  describe('cache persistence', () => {
    it('persists to sync_meta under ecosystem_cache and reads back the same object', () => {
      seedPackage(db, 'pkg-a', { downloadsPerDay: [10, 10] });
      const computed = recomputeEcosystemCache();
      const row = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get('ecosystem_cache') as { value: string } | undefined;
      assert.ok(row, 'expected ecosystem_cache row');
      assert.deepEqual(JSON.parse(row!.value), computed);
      assert.deepEqual(getEcosystemCache(), computed);
    });

    it('returns null before any recompute', () => {
      assert.equal(getEcosystemCache(), null);
    });

    it('returns null for invalid JSON in sync_meta', () => {
      db.prepare('INSERT INTO sync_meta (key, value) VALUES (?, ?)').run('ecosystem_cache', '{bad json');
      assert.equal(getEcosystemCache(), null);
    });
  });
});
