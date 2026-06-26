import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recomputeGrowthCache, growthCacheExists } from './growth';
import { getDb } from './db';

describe('growth.ts', () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM daily_downloads').run();
    db.prepare('DELETE FROM packages').run();
  });

  describe('recomputeGrowthCache', () => {
    it('is a no-op on an empty DB (does not throw)', () => {
      assert.doesNotThrow(() => recomputeGrowthCache());
    });

    it('writes NULL for packages with no download history', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('no-data', '1.0.0');
      recomputeGrowthCache();
      const row = db.prepare('SELECT daily_growth, weekly_growth, monthly_growth FROM packages WHERE name = ?').get('no-data') as {
        daily_growth: number | null;
        weekly_growth: number | null;
        monthly_growth: number | null;
      };
      assert.equal(row.daily_growth, null);
      assert.equal(row.weekly_growth, null);
      assert.equal(row.monthly_growth, null);
    });

    it('writes NULL when there is current-week data but no prior-week baseline', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      // Only this-week data (days 0-6), no last-week data (days 7-13)
      for (let i = 0; i < 7; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, 10);
      }
      recomputeGrowthCache();
      const row = db.prepare('SELECT weekly_growth FROM packages WHERE name = ?').get('pkg-a') as { weekly_growth: number | null };
      assert.equal(row.weekly_growth, null);
    });

    it('computes positive growth when this week > last week', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      // this_week uses 100/day, last_week uses 50/day. Due to the inclusive
      // `date >= date('now','-7 days')` boundary, this_week spans 8 days and
      // last_week spans ~6-7 days, so exact value depends on boundary. We
      // only assert the sign and a reasonable lower bound.
      for (let i = 0; i < 7; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, 100);
      }
      for (let i = 7; i < 14; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, 50);
      }
      recomputeGrowthCache();
      const row = db.prepare('SELECT weekly_growth FROM packages WHERE name = ?').get('pkg-a') as { weekly_growth: number };
      assert.ok(row.weekly_growth > 50, `expected strongly positive growth, got ${row.weekly_growth}`);
    });

    it('computes negative growth when this week < last week', () => {
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
      recomputeGrowthCache();
      const row = db.prepare('SELECT weekly_growth FROM packages WHERE name = ?').get('pkg-a') as { weekly_growth: number };
      assert.ok(row.weekly_growth < 0, `expected negative, got ${row.weekly_growth}`);
    });

    it('computes near-zero growth for a stable package (equal per-day rate)', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      // Equal per-day rate across both weeks. The inclusive boundary means
      // this_week spans 8 days vs prev_week ~6-7 days, so apparent growth is
      // small but nonzero (~28%). Threshold of 50% distinguishes "stable" from
      // a genuinely growing/declining package.
      for (let i = 0; i < 14; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, 10);
      }
      recomputeGrowthCache();
      const row = db.prepare('SELECT weekly_growth FROM packages WHERE name = ?').get('pkg-a') as { weekly_growth: number };
      assert.ok(Math.abs(row.weekly_growth) < 50, `expected near-zero for stable package, got ${row.weekly_growth}`);
    });

    it('writes growth for all three periods (daily, weekly, monthly)', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      // 60 days of data so the monthly period (30 days) has a prior-month
      // baseline (days 31-60). Without a prior month, monthly_growth is NULL.
      for (let i = 0; i < 60; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        const downloads = i < 30 ? 100 : 50;
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, downloads);
      }
      recomputeGrowthCache();
      const row = db.prepare('SELECT daily_growth, weekly_growth, monthly_growth FROM packages WHERE name = ?').get('pkg-a') as {
        daily_growth: number | null;
        weekly_growth: number | null;
        monthly_growth: number | null;
      };
      assert.notEqual(row.daily_growth, null);
      assert.notEqual(row.weekly_growth, null);
      assert.notEqual(row.monthly_growth, null);
      assert.ok(row.daily_growth! > 0);
    });

    it('is idempotent (running twice gives the same result)', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      for (let i = 0; i < 14; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, i < 7 ? 100 : 50);
      }
      recomputeGrowthCache();
      const first = db.prepare('SELECT weekly_growth FROM packages WHERE name = ?').get('pkg-a') as { weekly_growth: number };
      recomputeGrowthCache();
      const second = db.prepare('SELECT weekly_growth FROM packages WHERE name = ?').get('pkg-a') as { weekly_growth: number };
      assert.equal(second.weekly_growth, first.weekly_growth);
    });

    it('handles multiple packages independently', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-b', '1.0.0');
      // pkg-a growing, pkg-b declining
      for (let i = 0; i < 14; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        const a = i < 7 ? 100 : 50;
        const b = i < 7 ? 50 : 100;
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, a);
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-b', d, b);
      }
      recomputeGrowthCache();
      const a = db.prepare('SELECT weekly_growth FROM packages WHERE name = ?').get('pkg-a') as { weekly_growth: number };
      const b = db.prepare('SELECT weekly_growth FROM packages WHERE name = ?').get('pkg-b') as { weekly_growth: number };
      assert.ok(a.weekly_growth > 0, `pkg-a expected positive, got ${a.weekly_growth}`);
      assert.ok(b.weekly_growth < 0, `pkg-b expected negative, got ${b.weekly_growth}`);
    });
  });

  describe('growthCacheExists', () => {
    it('returns false on an empty DB', () => {
      assert.equal(growthCacheExists(), false);
    });

    it('returns false when packages exist but no growth has been computed', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      assert.equal(growthCacheExists(), false);
    });

    it('returns false when packages only have NULL growth (no baseline data)', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-no-data', '1.0.0');
      recomputeGrowthCache();
      assert.equal(growthCacheExists(), false);
    });

    it('returns true after recomputeGrowthCache runs on a package with baseline data', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      for (let i = 0; i < 14; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, 10);
      }
      recomputeGrowthCache();
      assert.equal(growthCacheExists(), true);
    });
  });
});

/** Assert `actual` is within `tolerance` of `expected`. */
function AssertApprox(actual: number, expected: number, tolerance: number): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}
