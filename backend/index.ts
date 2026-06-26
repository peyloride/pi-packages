import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { etag } from 'hono/etag';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { getDb, closeDb } from './db';
import { startCron, triggerSync, isSyncRunning, getNextRunTime, getLastSyncResult, getSyncVersion } from './cron';
import { computeAssetVersion, buildAssetCache } from './assets';
import { compress } from './compress';

const app = new Hono();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Start cron scheduler
startCron();

// CORS for local development
app.use('/*', cors());

// Response compression (brotli > gzip > deflate). Registered before etag so
// compression runs OUTSIDE etag: etag computes its validator on the raw body
// (and may short-circuit to 304), and we only encode the bytes that ship.
app.use('/*', compress());

// ETag for API responses: lets browsers/CDNs revalidate with If-None-Match
// and get a free 304 (no body) when the payload is unchanged.
app.use('/api/*', etag());

// Cache-Control guidance for API JSON. Data changes only on sync (every ~4h),
// so browsers can reuse for 60s (matches server cache TTL) and shared/CDN
// caches for 300s. ETag still allows revalidation after expiry.
const API_CACHE_CONTROL = 'public, max-age=60, s-maxage=300';

// -----------------------------------------------------------------------------
// In-memory response cache for expensive GET endpoints.
//
// The underlying data only changes when a sync completes (every ~4h), so we
// cache JSON responses keyed by the sync version + full query string. A sync
// completion bumps syncVersion (see cron.ts), so stale entries miss instantly
// — no stale window. The TTL is a safety net + bound on cache size.
// -----------------------------------------------------------------------------
const CACHE_TTL_MS = 60_000; // 60s safety net
const responseCache = new Map<string, { body: string; status: number; storedAt: number }>();

/**
 * Build a cache key that incorporates the current sync data version.
 * If the version changed (sync completed), the key differs and the old entry
 * is simply not hit (it expires by TTL or gets evicted on insertion below).
 */
function cacheKey(parts: string[]): string {
  return `${getSyncVersion()}:${parts.join('|')}`;
}

function cacheGet(key: string): { body: string; status: number } | null {
  const hit = responseCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.storedAt > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return { body: hit.body, status: hit.status };
}

function cacheSet(key: string, body: string, status: number): void {
  // Bound cache size to avoid unbounded growth under a varied query string
  // (e.g. search params, pagination offsets).
  if (responseCache.size > 512) {
    // Evict the oldest entry (Map preserves insertion order)
    const oldest = responseCache.keys().next().value;
    if (oldest) responseCache.delete(oldest);
  }
  responseCache.set(key, { body, status, storedAt: Date.now() });
}

// Valid values for the period query param
const VALID_PERIODS = ['daily', 'weekly', 'monthly'] as const;
type Period = typeof VALID_PERIODS[number];

const PERIOD_DAYS: Record<Period, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
};

function parsePeriod(raw: string | null): Period {
  if (raw && (VALID_PERIODS as readonly string[]).includes(raw)) return raw as Period;
  return 'weekly';
}

/**
 * Resolve a display name for the publisher field.
 *
 * npm records the trusted-publisher OIDC user as `"GitHub Actions"` for
 * packages published keyless from a GitHub Actions workflow. That's not a
 * human author, so fall back to the GitHub repo owner parsed from
 * `github_url` (e.g. `https://github.com/MattDevy/pi-extensions` -> `MattDevy`).
 *
 * Returns the chosen display name, or the raw publisher as a fallback.
 * The raw npm username is preserved separately as `publisher_raw`.
 */
function resolvePublisher(publisher: string | null, githubUrl: string | null): { publisher: string | null; publisher_raw: string | null } {
  const raw = publisher;
  if (publisher && publisher !== 'GitHub Actions') {
    return { publisher, publisher_raw: raw };
  }
  if (githubUrl) {
    const cleaned = githubUrl.replace(/^git\+/, '').replace(/\.git$/, '');
    const m = cleaned.match(/github\.com\/([^/]+)/i);
    if (m && m[1] && m[1].toLowerCase() !== 'github') {
      return { publisher: m[1], publisher_raw: raw };
    }
  }
  return { publisher: publisher || null, publisher_raw: raw };
}

// =============================================================================
// API Routes
// =============================================================================

/**
 * GET /api/packages - List packages with sorting, period filter, and pagination
 * Query params:
 *   - sort: popular | trending | new | updated (default: popular)
 *   - period: daily | weekly | monthly (default: weekly) — controls download stats
 *   - search: filter by name/description
 *   - limit: number of results (default: 50)
 *   - offset: pagination offset (default: 0)
 */
app.get('/api/packages', async (c) => {
  try {
    const sort = c.req.query('sort') || 'popular';
    const period = parsePeriod(c.req.query('period'));
    const search = c.req.query('search') || '';
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    // Response cache: skip the DB entirely on a hit. Data only changes between
    // syncs, so the cache key (which includes syncVersion) stays stable across
    // a sync cycle.
    const key = cacheKey(['packages', sort, period, search, String(limit), String(offset)]);
    const cached = cacheGet(key);
    if (cached) {
      return new Response(cached.body, {
        status: cached.status,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': API_CACHE_CONTROL,
        },
      });
    }

    const db = getDb();
    const periodDays = PERIOD_DAYS[period];
    const periodLabel = period === 'daily' ? 'day' : period === 'weekly' ? 'week' : 'month';

    // Build search condition
    const searchCondition = search
      ? `AND (p.name LIKE '%${search.replace(/'/g, "''")}%' OR p.description LIKE '%${search.replace(/'/g, "''")}%')`
      : '';

    // Build sort order and extra filter
    let orderBy = '';
    let extraFilter = '';

    switch (sort) {
      case 'trending':
        orderBy = `ORDER BY growth_percent DESC NULLS LAST`;
        break;
      case 'new':
        extraFilter = `AND date(p.first_seen) >= date('now', '-30 days')`;
        orderBy = `ORDER BY p.first_seen DESC`;
        break;
      case 'updated':
        orderBy = `ORDER BY p.last_publish DESC NULLS LAST`;
        break;
      case 'popular':
      default:
        orderBy = `ORDER BY period_downloads DESC NULLS LAST`;
        break;
    }

    // Build WHERE clause
    const wherePart = `1=1 ${searchCondition} ${extraFilter}`;

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM packages p WHERE ${wherePart}`;
    const countResult = db.prepare(countQuery).get() as { total: number };

    // Previous period for growth calculation
    const prevPeriodStart = `date('now', '-${periodDays * 2} days')`;
    const prevPeriodEnd = `date('now', '-${periodDays} days')`;

    // Get packages with download stats for the selected period
    const query = `
      SELECT
        p.name,
        p.description,
        p.version,
        p.keywords,
        p.publisher,
        p.github_url,
        p.npm_url,
        p.first_seen,
        p.last_publish,
        COALESCE(SUM(CASE WHEN d.date >= date('now', '-${periodDays} days') THEN d.downloads ELSE 0 END), 0) as period_downloads,
        COALESCE(SUM(CASE WHEN d.date >= date('now', '-7 days') THEN d.downloads ELSE 0 END), 0) as weekly_downloads,
        COALESCE(SUM(CASE WHEN d.date >= date('now', '-30 days') THEN d.downloads ELSE 0 END), 0) as monthly_downloads,
        CASE
          WHEN COALESCE(SUM(CASE WHEN d.date >= ${prevPeriodStart} AND d.date < ${prevPeriodEnd} THEN d.downloads ELSE 0 END), 0) > 0
          THEN (COALESCE(SUM(CASE WHEN d.date >= date('now', '-${periodDays} days') THEN d.downloads ELSE 0 END), 0) - COALESCE(SUM(CASE WHEN d.date >= ${prevPeriodStart} AND d.date < ${prevPeriodEnd} THEN d.downloads ELSE 0 END), 0)) * 100.0 / COALESCE(SUM(CASE WHEN d.date >= ${prevPeriodStart} AND d.date < ${prevPeriodEnd} THEN d.downloads ELSE 0 END), 0)
          ELSE CASE WHEN COALESCE(SUM(CASE WHEN d.date >= date('now', '-${periodDays} days') THEN d.downloads ELSE 0 END), 0) > 0 THEN 100 ELSE NULL END
        END as growth_percent
      FROM packages p
      LEFT JOIN daily_downloads d ON p.name = d.package_name
      WHERE ${wherePart}
      GROUP BY p.name
      ${orderBy}
      LIMIT ? OFFSET ?
    `;

    const packages = db.prepare(query).all(limit, offset) as any[];

    // Batch-fetch sparkline data for all packages in ONE query (was N+1 — a
    // separate `WHERE package_name = ?` per package). 7-day window, capped at
    // 7 data points, grouped by package name.
    const sparklineDays = Math.min(periodDays, 7);
    const sparklineMap = new Map<string, number[]>();
    if (packages.length > 0) {
      const names = packages.map(p => p.name);
      const placeholders = names.map(() => '?').join(',');
      const sparklineRows = db.prepare(
        `SELECT package_name, downloads FROM daily_downloads
         WHERE date >= date('now', '-${sparklineDays} days')
         AND package_name IN (${placeholders})
         ORDER BY package_name, date ASC`,
      ).all(...names) as Array<{ package_name: string; downloads: number }>;
      for (const row of sparklineRows) {
        let arr = sparklineMap.get(row.package_name);
        if (!arr) {
          arr = [];
          sparklineMap.set(row.package_name, arr);
        }
        arr.push(row.downloads);
      }
    }

    // Enrich with sparkline + format
    const packagesWithGrowth = packages.map(pkg => {
      let growth = null;
      if (pkg.growth_percent !== null) {
        growth = Math.round(pkg.growth_percent * 10) / 10;
      } else if (pkg.period_downloads > 0) {
        growth = 100;
      }

      const sparkline = sparklineMap.get(pkg.name) || [];

      // Resolve display publisher (GitHub Actions OIDC -> repo owner)
      const { publisher, publisher_raw } = resolvePublisher(pkg.publisher, pkg.github_url);

      return {
        name: pkg.name,
        description: pkg.description,
        version: pkg.version,
        keywords: pkg.keywords ? JSON.parse(pkg.keywords) : [],
        publisher,
        publisher_raw,
        github_url: pkg.github_url,
        npm_url: pkg.npm_url,
        first_seen: pkg.first_seen,
        last_publish: pkg.last_publish,
        downloads: pkg.period_downloads,
        downloads_period: period,
        downloads_label: `/${periodLabel}`,
        weekly_downloads: pkg.weekly_downloads,
        monthly_downloads: pkg.monthly_downloads,
        growth,
        sparkline,
      };
    });

    // Sort by growth if trending (already in SQL, but ensure proper null handling)
    if (sort === 'trending') {
      packagesWithGrowth.sort((a, b) => (b.growth || -Infinity) - (a.growth || -Infinity));
    }

    const resultBody = {
      packages: packagesWithGrowth,
      period,
      pagination: {
        total: countResult.total,
        limit,
        offset,
        hasMore: offset + limit < countResult.total,
      },
    };

    // Cache the serialized response (invalidates automatically on sync complete)
    const serialized = JSON.stringify(resultBody);
    cacheSet(cacheKey(['packages', sort, period, search, String(limit), String(offset)]), serialized, 200);

    return c.json(resultBody, 200, { 'cache-control': API_CACHE_CONTROL });
  } catch (err) {
    console.error('[API] Error fetching packages:', err);
    return c.json({ error: 'Failed to fetch packages' }, 500);
  }
});

/**
 * GET /api/packages/:name - Get package details with download history
 */
app.get('/api/packages/:name', async (c) => {
  try {
    const db = getDb();
    const name = c.req.param('name');

    // Get package info
    const pkg = db.prepare(`
      SELECT * FROM packages WHERE name = ?
    `).get(name) as any;

    if (!pkg) {
      return c.json({ error: 'Package not found' }, 404);
    }

    // Get download history for last 30 days
    const downloads = db.prepare(`
      SELECT date, downloads
      FROM daily_downloads
      WHERE package_name = ? AND date >= date('now', '-30 days')
      ORDER BY date ASC
    `).all(name) as Array<{ date: string; downloads: number }>;

    // Calculate stats for each period
    const now = Date.now();
    const dailyDownloads = downloads
      .filter(d => new Date(d.date) >= new Date(now - 1 * 24 * 60 * 60 * 1000))
      .reduce((sum, d) => sum + d.downloads, 0);
    const weeklyDownloads = downloads
      .filter(d => new Date(d.date) >= new Date(now - 7 * 24 * 60 * 60 * 1000))
      .reduce((sum, d) => sum + d.downloads, 0);
    const monthlyDownloads = downloads
      .reduce((sum, d) => sum + d.downloads, 0);

    const lastWeekDownloads = downloads
      .filter(d => {
        const date = new Date(d.date);
        return date >= new Date(now - 14 * 24 * 60 * 60 * 1000) && date < new Date(now - 7 * 24 * 60 * 60 * 1000);
      })
      .reduce((sum, d) => sum + d.downloads, 0);

    let growth = null;
    if (lastWeekDownloads > 0) {
      growth = ((weeklyDownloads - lastWeekDownloads) / lastWeekDownloads) * 100;
      growth = Math.round(growth * 10) / 10;
    } else if (weeklyDownloads > 0) {
      growth = 100;
    }

    // Generate sparkline data (7 days)
    const sparkline = downloads.slice(-7).map(d => d.downloads);

    // Resolve display publisher (GitHub Actions OIDC -> repo owner)
    const { publisher, publisher_raw } = resolvePublisher(pkg.publisher, pkg.github_url);

    return c.json({
      ...pkg,
      publisher,
      publisher_raw,
      keywords: pkg.keywords ? JSON.parse(pkg.keywords) : [],
      daily_downloads: dailyDownloads,
      weekly_downloads: weeklyDownloads,
      monthly_downloads: monthlyDownloads,
      growth,
      download_history: downloads,
      sparkline,
    });
  } catch (err) {
    console.error('[API] Error fetching package:', err);
    return c.json({ error: 'Failed to fetch package' }, 500);
  }
});

/**
 * GET /api/stats - Get ecosystem statistics
 */
app.get('/api/stats', async (c) => {
  try {
    // Response cache: stats is the most expensive endpoint (3 aggregate
    // queries scanning daily_downloads), and the data only changes on sync.
    const key = cacheKey(['stats']);
    const cached = cacheGet(key);
    if (cached) {
      return new Response(cached.body, {
        status: cached.status,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': API_CACHE_CONTROL,
        },
      });
    }

    const db = getDb();

    const totalPackages = db.prepare('SELECT COUNT(*) as count FROM packages').get() as { count: number };

    const totalWeeklyDownloads = db.prepare(`
      SELECT SUM(downloads) as total
      FROM daily_downloads
      WHERE date >= date('now', '-7 days')
    `).get() as { total: number | null };

    const totalMonthlyDownloads = db.prepare(`
      SELECT SUM(downloads) as total
      FROM daily_downloads
      WHERE date >= date('now', '-30 days')
    `).get() as { total: number | null };

    const avgGrowth = db.prepare(`
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
    `).get() as { avg: number | null };

    const nextSyncTime = getNextRunTime();
    const lastResult = getLastSyncResult();

    // Get last sync timestamp from sync_meta
    const syncMetaRow = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get('last_incremental_sync') as { value: string } | undefined;

    const resultBody = {
      total_packages: totalPackages.count,
      total_weekly_downloads: totalWeeklyDownloads.total || 0,
      total_monthly_downloads: totalMonthlyDownloads.total || 0,
      average_growth: avgGrowth.avg ? Math.round(avgGrowth.avg * 10) / 10 : 0,
      last_sync: syncMetaRow?.value || null,
      next_sync: nextSyncTime?.toISOString() || null,
      sync_running: isSyncRunning(),
      last_sync_mode: lastResult?.mode || null,
    };

    const serialized = JSON.stringify(resultBody);
    cacheSet(key, serialized, 200);

    return c.json(resultBody, 200, { 'cache-control': API_CACHE_CONTROL });
  } catch (err) {
    console.error('[API] Error fetching stats:', err);
    return c.json({ error: 'Failed to fetch stats' }, 500);
  }
});

/**
 * POST /api/sync - Manually trigger sync
 */
app.post('/api/sync', async (c) => {
  try {
    const full = c.req.query('full') === 'true';
    const result = await triggerSync(full);
    return c.json(result, result.success ? 200 : 409);
  } catch (err) {
    console.error('[API] Error triggering sync:', err);
    return c.json({ success: false, message: 'Failed to trigger sync' }, 500);
  }
});

// =============================================================================
// Static Files (Frontend) — immutable cache with content-version busting
// =============================================================================
//
// Frontend assets are pre-loaded into memory at boot with `?v=<version>`
// stamped onto every relative reference (HTML asset URLs, JS import/export
// specifiers, CSS @import/url()). The version rotates on any file mtime
// change (i.e. on deploy), so:
//   - assets get `Cache-Control: public, max-age=31536000, immutable` (safe,
//     because their URL changes when content changes), and
//   - index.html gets `no-cache` so returning visitors pick up the new ?v=
//     query strings and re-fetch any changed asset.

const FRONTEND_DIR = './frontend';
const ASSET_VERSION = computeAssetVersion(FRONTEND_DIR);
const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const assetCache = buildAssetCache(FRONTEND_DIR, ASSET_VERSION);

// Serve a stamped asset from the in-memory cache. Static-file requests hit
// this before serveStatic, so disk is never touched on the hot path.
app.get('/*', async (c, next) => {
  let path = c.req.path;
  if (path === '/') path = '/index.html';
  const asset = assetCache.get(path);
  if (!asset) return next();
  return new Response(asset.content, {
    status: 200,
    headers: {
      'content-type': asset.contentType,
      'cache-control': path === '/index.html' ? 'no-cache' : ASSET_CACHE_CONTROL,
    },
  });
});

// serveStatic is kept as a fallback for any file the in-memory cache doesn't
// cover (e.g. assets added at runtime, which shouldn't happen in practice).
app.use('/*', serveStatic({ root: FRONTEND_DIR }));

// SPA fallback: unknown routes serve index.html so client-side routing works.
// Uses the stamped cache (no per-request disk read).
app.get('*', async (c) => {
  const asset = assetCache.get('/index.html');
  return new Response(asset?.content ?? '', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
  });
});

// =============================================================================
// Server
// =============================================================================

const server = serve({
  port: PORT,
  fetch: app.fetch,
});

console.log(`[Server] Starting on port ${PORT}`);
console.log(`[Server] Dashboard: http://localhost:${PORT}`);
console.log(`[Server] API: http://localhost:${PORT}/api/packages`);

process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  server.close();
  closeDb();
  process.exit(0);
});
