/**
 * Materialized ecosystem aggregates for the /api/ecosystem endpoint.
 *
 * Follows the exact proven pattern from stats.ts: heavy aggregate queries run
 * ONCE per sync (from cron.ts, right after recomputeStatsCache), the result
 * is stored as a single JSON row in `sync_meta` under 'ecosystem_cache', and
 * /api/ecosystem reads that row — falling back to a live recompute on cold
 * start (no sync has ever run).
 *
 * Data sizes: daily_downloads holds 60 days × ~6,300 packages (~380k rows),
 * so per-request aggregation is the wrong call; materializing keeps every
 * request O(1) read of one JSON blob.
 */

import { getDb } from './db';
import { resolvePublisher } from './publisher';

const ECOSYSTEM_KEY = 'ecosystem_cache';

const SERIES_DAYS = 60;   // Must match the download retention window.
const TOP_N = 10;         // Top publishers / packages limit.

export interface EcosystemDay {
  date: string;
  downloads: number;
}

export interface EcosystemPublisherEntry {
  publisher: string;
  packages: number;
  downloads: number;
}

export interface EcosystemTopPackage {
  name: string;
  downloads: number;
  growth: number | null;
}

export interface EcosystemDistribution {
  p50: number | null;
  p90: number | null;
  p99: number | null;
  /** Median of non-null weekly_growth values across packages. */
  median_growth: number | null;
}

export interface EcosystemCache {
  total_packages: number;
  active_packages_30d: number;
  downloads_series: EcosystemDay[];
  top_publishers: {
    by_packages: EcosystemPublisherEntry[];
    by_downloads: EcosystemPublisherEntry[];
  };
  top_packages: EcosystemTopPackage[];
  distribution: EcosystemDistribution;
  computed_at: string;
}

/**
 * Format a Date as a local YYYY-MM-DD calendar date. Date-only arithmetic
 * is done in UTC to keep day boundaries unambiguous, consistent with how the
 * daily_downloads table stores dates.
 */
function toDateKey(d: Date): string {
  return d.toISOString().split('T')[0];
}

/**
 * Pick the 50th/90th/99th percentile of a ranked column using OFFSET picks
 * (design D2). Returns null when the ranked list is empty.
 *
 * `count` is the number of rows; k is the 0-based offset of the value at
 * percentile p: floor((count - 1) * p). For a single row every percentile
 * is that row; for monotone data p50 <= p90 <= p99 always holds.
 */
function percentileOffset(count: number, pct: number): number {
  if (count <= 1) return 0;
  return Math.floor((count - 1) * pct);
}

/**
 * Run the aggregate queries and persist the result to sync_meta.
 * Called after every sync (incremental and full) from cron.ts, beside
 * recomputeStatsCache() / recomputeGrowthCache().
 */
export function recomputeEcosystemCache(): EcosystemCache {
  const db = getDb();

  const totalPackages = (db.prepare('SELECT COUNT(*) as c FROM packages').get() as { c: number }).c;

  const active30 = (db.prepare(`
    SELECT COUNT(DISTINCT package_name) as c
    FROM daily_downloads
    WHERE date >= date('now', '-30 days') AND downloads > 0
  `).get() as { c: number }).c;

  // 1) Downloads series: daily sums for the last SERIES_DAYS days. Days with
  // no records appear with downloads: 0 (zero-fill in JS, design D3).
  const seriesRows = db.prepare(`
    SELECT date, SUM(downloads) as total
    FROM daily_downloads
    WHERE date >= date('now', '-${SERIES_DAYS} days')
    GROUP BY date
  `).all() as Array<{ date: string; total: number | null }>;

  const totalsByDate = new Map(seriesRows.map((r) => [r.date, r.total || 0]));
  const downloadsSeries: EcosystemDay[] = [];
  for (let i = SERIES_DAYS - 1; i >= 0; i--) {
    const d = toDateKey(new Date(Date.now() - i * 24 * 60 * 60 * 1000));
    downloadsSeries.push({ date: d, downloads: totalsByDate.get(d) || 0 });
  }

  // 2) Top packages by 30-day downloads (with materialized weekly growth).
  const topPackages = db.prepare(`
    SELECT p.name, COALESCE(SUM(d.downloads), 0) as downloads, p.weekly_growth as growth
    FROM packages p
    LEFT JOIN daily_downloads d
      ON d.package_name = p.name AND d.date >= date('now', '-30 days')
    GROUP BY p.name, p.weekly_growth
    ORDER BY downloads DESC, p.name ASC
    LIMIT ?
  `).all(TOP_N).map((r: any) => ({
    name: r.name as string,
    downloads: r.downloads as number,
    growth: r.growth === null || r.growth === undefined ? null : Math.round(r.growth * 10) / 10,
  }));

  // 3) Per-package 30-day totals (only packages with at least one download in
  // the window) for percentile picks.
  const perPackageRows = db.prepare(`
    SELECT d.package_name as name, SUM(d.downloads) as total
    FROM daily_downloads d
    WHERE d.date >= date('now', '-30 days')
    GROUP BY d.package_name
  `).all() as Array<{ name: string; total: number }>;

  const activeTotals = perPackageRows
    .map((r) => r.total)
    .filter((v): v is number => typeof v === 'number' && v > 0)
    .sort((a, b) => a - b);

  const distribution: EcosystemDistribution = {
    p50: null,
    p90: null,
    p99: null,
    median_growth: null,
  };

  if (activeTotals.length > 0) {
    distribution.p50 = activeTotals[percentileOffset(activeTotals.length, 0.5)];
    distribution.p90 = activeTotals[percentileOffset(activeTotals.length, 0.9)];
    distribution.p99 = activeTotals[percentileOffset(activeTotals.length, 0.99)];
  }

  // Median of non-null weekly_growth across packages.
  const growthRow = db.prepare(`
    SELECT weekly_growth as g FROM packages WHERE weekly_growth IS NOT NULL
  `).all() as Array<{ g: number }>;
  const growths = growthRow.map((r) => r.g).sort((a, b) => a - b);
  if (growths.length > 0) {
    const mid = Math.floor(growths.length / 2);
    distribution.median_growth = growths.length % 2 === 1
      ? growths[mid]
      : (growths[mid - 1] + growths[mid]) / 2;
  }

  // 4) Top publishers. SQL groups by the RAW publisher field; JS then maps
  // each group through resolvePublisher (design D4) so the display names
  // match what /api/packages shows on cards. We slice after mapping so the
  // limit applies to display publishers.
  const publisherGroups = db.prepare(`
    SELECT p.publisher as publisher, p.github_url as github_url,
           COUNT(DISTINCT p.name) as packages,
           COALESCE(SUM(CASE WHEN d.date >= date('now', '-30 days') THEN d.downloads ELSE 0 END), 0) as downloads
    FROM packages p
    LEFT JOIN daily_downloads d ON d.package_name = p.name
    GROUP BY p.publisher, p.github_url
  `).all() as Array<{ publisher: string | null; github_url: string | null; packages: number; downloads: number }>;

  // Aggregation by DISPLAY publisher (after resolvePublisher). Two raw
  // publishers mapping to the same display name (e.g. 'GitHub Actions' and a
  // repo-owner override) merge here deliberately, so counts stay consistent
  // with the card view.
  const displayGroups = new Map<string, { packages: number; downloads: number }>();
  for (const g of publisherGroups) {
    const { publisher } = resolvePublisher(g.publisher, g.github_url);
    const key = publisher ?? '(unknown)';
    const cur = displayGroups.get(key) || { packages: 0, downloads: 0 };
    cur.packages += g.packages;
    cur.downloads += g.downloads;
    displayGroups.set(key, cur);
  }

  const byPackages = [...displayGroups.entries()]
    .map(([publisher, v]) => ({ publisher, packages: v.packages, downloads: v.downloads }))
    .sort((a, b) => b.packages - a.packages || b.downloads - a.downloads || a.publisher.localeCompare(b.publisher))
    .slice(0, TOP_N);

  const byDownloads = [...displayGroups.entries()]
    .map(([publisher, v]) => ({ publisher, packages: v.packages, downloads: v.downloads }))
    .sort((a, b) => b.downloads - a.downloads || b.packages - a.packages || a.publisher.localeCompare(b.publisher))
    .slice(0, TOP_N);

  const ecosystem: EcosystemCache = {
    total_packages: totalPackages,
    active_packages_30d: active30,
    downloads_series: downloadsSeries,
    top_publishers: { by_packages: byPackages, by_downloads: byDownloads },
    top_packages: topPackages,
    distribution,
    computed_at: new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO sync_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(ECOSYSTEM_KEY, JSON.stringify(ecosystem));

  return ecosystem;
}

/**
 * Read the materialized ecosystem stats. Returns null if no sync has ever
 * run (cold start) — the caller should fall back to recomputeEcosystemCache().
 */
export function getEcosystemCache(): EcosystemCache | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(ECOSYSTEM_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as EcosystemCache;
  } catch {
    return null;
  }
}
