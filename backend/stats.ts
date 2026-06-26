/**
 * Materialized ecosystem statistics.
 *
 * /api/stats runs three expensive aggregate queries over `daily_downloads`
 * (weekly sum, monthly sum, and an average-growth subquery that groups by
 * package_name). At ~40ms each cold, they are the slowest endpoint.
 *
 * Since the underlying data only changes when a sync completes (every ~4h),
 * we compute these aggregates ONCE per sync — right after a sync finishes —
 * and store them as a single JSON row in `sync_meta`. /api/stats then reads
 * that one row instead of re-running the aggregates. The live, cheap fields
 * (sync_running, next_sync) are still computed per request.
 */

import { getDb } from './db';

export interface StatsCache {
  total_packages: number;
  total_weekly_downloads: number;
  total_monthly_downloads: number;
  average_growth: number;
  computed_at: string;
}

const STATS_KEY = 'stats_cache';

/**
 * Run the aggregate queries and persist the result to sync_meta.
 * Called after every sync (incremental and full) from cron.ts.
 */
export function recomputeStatsCache(): StatsCache {
  const db = getDb();

  const totalPackages = (db.prepare('SELECT COUNT(*) as count FROM packages').get() as { count: number }).count;

  const weekly = (db.prepare(`
    SELECT SUM(downloads) as total FROM daily_downloads WHERE date >= date('now', '-7 days')
  `).get() as { total: number | null }).total || 0;

  const monthly = (db.prepare(`
    SELECT SUM(downloads) as total FROM daily_downloads WHERE date >= date('now', '-30 days')
  `).get() as { total: number | null }).total || 0;

  const avgGrowth = (db.prepare(`
    SELECT AVG(growth) as avg
    FROM (
      SELECT
        (this_week - last_week) * 100.0 / NULLIF(last_week, 0) as growth
      FROM (
        SELECT
          SUM(CASE WHEN date >= date('now', '-7 days') THEN downloads ELSE 0 END) as this_week,
          SUM(CASE WHEN date >= date('now', '-14 days') AND date < date('now', '-7 days') THEN downloads ELSE 0 END) as last_week
        FROM daily_downloads
        GROUP BY package_name
      )
      WHERE last_week > 0
    )
  `).get() as { avg: number | null }).avg;

  const stats: StatsCache = {
    total_packages: totalPackages,
    total_weekly_downloads: weekly,
    total_monthly_downloads: monthly,
    average_growth: avgGrowth ? Math.round(avgGrowth * 10) / 10 : 0,
    computed_at: new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO sync_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(STATS_KEY, JSON.stringify(stats));

  return stats;
}

/**
 * Read the materialized stats. Returns null if no sync has ever run (cold
 * start) — the caller should fall back to `recomputeStatsCache()` in that case.
 */
export function getStatsCache(): StatsCache | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(STATS_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as StatsCache;
  } catch {
    return null;
  }
}
