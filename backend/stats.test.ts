import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recomputeStatsCache, getStatsCache } from './stats';
import { getDb } from './db';

describe('stats.ts', () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM daily_downloads').run();
    db.prepare('DELETE FROM packages').run();
    db.prepare('DELETE FROM sync_meta').run();
  });

  describe('recomputeStatsCache', () => {
    it('returns zero stats on an empty DB', () => {
      const stats = recomputeStatsCache();
      assert.equal(stats.total_packages, 0);
      assert.equal(stats.total_weekly_downloads, 0);
      assert.equal(stats.total_monthly_downloads, 0);
      assert.equal(stats.average_growth, 0);
      assert.ok(stats.computed_at);
    });

    it('counts total_packages from the packages table', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-b', '1.0.0');
      const stats = recomputeStatsCache();
      assert.equal(stats.total_packages, 2);
    });

    it('sums weekly and monthly downloads (last 7 / 30 days)', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      const today = new Date().toISOString().split('T')[0];
      db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', today, 100);
      const stats = recomputeStatsCache();
      assert.equal(stats.total_weekly_downloads, 100);
      assert.equal(stats.total_monthly_downloads, 100);
    });

    it('excludes downloads older than 30 days from the monthly total', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      const today = new Date().toISOString().split('T')[0];
      const oldDate = new Date(Date.now() - 40 * 86400000).toISOString().split('T')[0];
      db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', today, 50);
      db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', oldDate, 1000);
      const stats = recomputeStatsCache();
      assert.equal(stats.total_weekly_downloads, 50);
      assert.equal(stats.total_monthly_downloads, 50);
    });

    it('excludes downloads older than 7 days from the weekly total', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      const recent = new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0];
      const old = new Date(Date.now() - 20 * 86400000).toISOString().split('T')[0];
      db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', recent, 30);
      db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', old, 400);
      const stats = recomputeStatsCache();
      assert.equal(stats.total_weekly_downloads, 30);
      assert.equal(stats.total_monthly_downloads, 430);
    });

    it('computes a positive Bayesian-smoothed average_growth when packages are growing', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      // this_week=700 (100/day×7), last_week=350 (50/day×7)
      // smoothed growth = (710/450)*100 - 100 ≈ 57.78
      for (let i = 0; i < 7; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, 100);
      }
      for (let i = 7; i < 14; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, 50);
      }
      const stats = recomputeStatsCache();
      assert.ok(stats.average_growth > 0, `expected positive growth, got ${stats.average_growth}`);
    });

    it('computes a negative average_growth when packages are declining', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      // this_week=350, last_week=700 → declining
      for (let i = 0; i < 7; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, 50);
      }
      for (let i = 7; i < 14; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, 100);
      }
      const stats = recomputeStatsCache();
      assert.ok(stats.average_growth < 0, `expected negative growth, got ${stats.average_growth}`);
    });

    it('returns average_growth=0 when no packages have baseline data', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      // Only this-week data, no last-week baseline → AVG ignores the NULL
      for (let i = 0; i < 7; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, 100);
      }
      const stats = recomputeStatsCache();
      assert.equal(stats.average_growth, 0);
    });

    it('persists the result to sync_meta', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      const result = recomputeStatsCache();
      const row = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get('stats_cache') as { value: string } | undefined;
      assert.ok(row);
      assert.deepEqual(JSON.parse(row!.value), result);
    });
  });

  describe('getStatsCache', () => {
    it('returns null when no cache exists', () => {
      assert.equal(getStatsCache(), null);
    });

    it('returns the cached stats after recomputeStatsCache runs', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      const computed = recomputeStatsCache();
      const cached = getStatsCache();
      assert.deepEqual(cached, computed);
    });

    it('returns null for invalid JSON in sync_meta', () => {
      const db = getDb();
      db.prepare('INSERT INTO sync_meta (key, value) VALUES (?, ?)').run('stats_cache', '{invalid json');
      assert.equal(getStatsCache(), null);
    });

    it('reflects updated values when recomputeStatsCache runs again', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      const first = recomputeStatsCache();
      assert.equal(first.total_packages, 1);
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-b', '1.0.0');
      const second = recomputeStatsCache();
      assert.equal(second.total_packages, 2);
      // computed_at is ISO millisecond-precision; both calls may land in the
      // same ms, so only assert the totals changed (not the timestamp).
    });
  });
});
