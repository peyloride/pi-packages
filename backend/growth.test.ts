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
      // Only this-week data (last 7 complete days = offsets 1-7), no
      // last-week data (offsets 8-14)
      for (let i = 1; i <= 7; i++) {
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
      // this_week (offsets 1-7) uses 100/day, last_week (offsets 8-14)
      // uses 50/day. Smoothed: ((700+10)*100/(350+10))-100 ≈ 97.2%.
      for (let i = 1; i <= 7; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, 100);
      }
      for (let i = 8; i <= 14; i++) {
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
      for (let i = 1; i <= 7; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, 50);
      }
      for (let i = 8; i <= 14; i++) {
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
      // Equal per-day rate across both 7-day complete windows. Smoothed
      // formula with equal sums is exactly 0 regardless of the prior k.
      for (let i = 1; i <= 14; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, 10);
      }
      recomputeGrowthCache();
      const row = db.prepare('SELECT weekly_growth FROM packages WHERE name = ?').get('pkg-a') as { weekly_growth: number };
      assert.ok(Math.abs(row.weekly_growth) < 1, `expected ~0 for stable package, got ${row.weekly_growth}`);
    });

    it('writes growth for all three periods (daily, weekly, monthly)', () => {
      const db = getDb();
      db.prepare('INSERT INTO packages (name, version) VALUES (?, ?)').run('pkg-a', '1.0.0');
      // 60 complete days of data (offsets 1-60) so the monthly period has a
      // prior-month baseline. Daily compares yesterday vs 2-days-ago; shape
      // the day-pair to grow (100 vs 50).
      for (let i = 1; i <= 60; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        const downloads = i <= 30 ? 100 : 50;
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, downloads);
      }
      // Yesterday (offset 1) holds 100, 2-days-ago (offset 2) holds 100 too
      // after the loop above — force a growing day-pair for the daily window.
      db.prepare('UPDATE daily_downloads SET downloads = 50 WHERE package_name = ? AND date = ?')
        .run('pkg-a', new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0]);
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
      for (let i = 1; i <= 14; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        db.prepare('INSERT INTO daily_downloads (package_name, date, downloads) VALUES (?, ?, ?)').run('pkg-a', d, i <= 7 ? 100 : 50);
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
      for (let i = 1; i <= 14; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        const a = i <= 7 ? 100 : 50;
        const b = i <= 7 ? 50 : 100;
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
