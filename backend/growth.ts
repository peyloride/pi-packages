/**
 * Materialized per-package growth percentages.
 *
 * /api/packages is the hot endpoint, and ~33% of its cold-miss cost was the
 * growth_percent CASE expression (5+ SUM(CASE) aggregates over the
 * daily_downloads join). Since growth only changes when downloads change —
 * i.e. on sync — we compute it ONCE per sync for all three periods and store
 * it as columns on the packages table. The per-request query then reads the
 * column instead of recomputing.
 *
 * Formula mirrors backend/index.ts exactly (Bayesian smoothing with the same
 * prior k, NULL when no baseline) so a package's growth is identical whether
 * read from the column or computed live.
 */

import { getDb } from './db';

// Must match backend/index.ts. Duplicated rather than imported to avoid the
// module-init cycle (index.ts imports growth.ts at boot).
const GROWTH_SMOOTHING_PRIOR = 10;

/**
 * Recompute and persist per-package growth percentages for all three periods.
 * Called after every sync (incremental and full) from cron.ts. Also safe to
 * call at boot to populate the columns after the migration adds them.
 *
 * One CTE-based UPDATE per period; each computes growth for every package in
 * a single aggregation pass, then writes it back. ~5-15ms for 4500 packages.
 */
export function recomputeGrowthCache(): void {
  const db = getDb();
  const k = GROWTH_SMOOTHING_PRIOR;

  const periods: Array<{ column: string; days: number }> = [
    { column: 'daily_growth', days: 1 },
    { column: 'weekly_growth', days: 7 },
    { column: 'monthly_growth', days: 30 },
  ];

  for (const { column, days } of periods) {
    // Both windows span exactly `days` complete calendar dates, excluding
    // today (a partial day at sync time; including it skews current vs
    // previous whenever the day's count is still accumulating):
    //   current  = [now-days,   now-1]   (offsets 1..days)
    //   previous = [now-2*days, now-days-1] (offsets days+1..2*days)
    const curStart = `date('now', '-${days} days')`;
    const curEnd = `date('now')`;
    const prevStart = `date('now', '-${days * 2} days')`;
    const prevEnd = `date('now', '-${days} days')`;

    // CTE computes growth for every package in one aggregation pass, then a
    // single UPDATE...FROM writes it back. CASE keeps NULL for packages with
    // no baseline (prev = 0) — matches the live formula in index.ts.
    db.exec(`
      WITH growth AS (
        SELECT
          p.name,
          CASE
            WHEN COALESCE(SUM(CASE WHEN d.date >= ${prevStart} AND d.date < ${prevEnd} THEN d.downloads ELSE 0 END), 0) > 0
            THEN ((COALESCE(SUM(CASE WHEN d.date >= ${curStart} AND d.date < ${curEnd} THEN d.downloads ELSE 0 END), 0) + ${k}) * 100.0 /
                  (COALESCE(SUM(CASE WHEN d.date >= ${prevStart} AND d.date < ${prevEnd} THEN d.downloads ELSE 0 END), 0) + ${k})) - 100
            ELSE NULL
          END as value
        FROM packages p
        LEFT JOIN daily_downloads d ON p.name = d.package_name
        GROUP BY p.name
      )
      UPDATE packages SET ${column} = (SELECT value FROM growth WHERE growth.name = packages.name)
    `);
  }
}

/**
 * True if the materialized growth columns exist and are populated for at
 * least one package. Used at boot to decide whether to run
 * recomputeGrowthCache().
 */
export function growthCacheExists(): boolean {
  const db = getDb();
  // Check column presence via PRAGMA, not row values: a DB where every
  // package happens to have NULL growth (e.g. no baseline data yet — the
  // common state right after the first sync with a fresh registry) would
  // otherwise report "missing" and force a full recompute on every boot.
  const cols = db.prepare('PRAGMA table_info(packages)').all() as Array<{ name: string }>;
  const hasColumn = cols.some((c) => c.name === 'weekly_growth');
  if (!hasColumn) return false;
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM packages WHERE weekly_growth IS NOT NULL`,
  ).get() as { count: number };
  return row.count > 0;
}
