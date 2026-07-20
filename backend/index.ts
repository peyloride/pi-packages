import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { etag } from 'hono/etag';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb } from './db';
import { startCron, isSyncRunning, getNextRunTime, getLastSyncResult, getSyncVersion } from './cron';
import { computeAssetVersion, buildAssetCache } from './assets';
import { compress } from './compress';
import { getStatsCache, recomputeStatsCache } from './stats';
import { recomputeGrowthCache, growthCacheExists } from './growth';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const FRONTEND_DIR = './frontend';

// Cache-Control guidance for API JSON. Data changes only on sync (every ~4h),
// so browsers can reuse for 60s (matches server cache TTL) and shared/CDN
// caches for 300s. ETag still allows revalidation after expiry.
const API_CACHE_CONTROL = 'public, max-age=60, s-maxage=300';
const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const CACHE_TTL_MS = 60_000; // 60s safety net

// Valid values for the period query param
const VALID_PERIODS = ['daily', 'weekly', 'monthly'] as const;
type Period = typeof VALID_PERIODS[number];

const PERIOD_DAYS: Record<Period, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
};

// -----------------------------------------------------------------------------
// Growth-percent tuning constants.
//
// TRENDING_MIN_DOWNLOADS: packages below this volume in the current period
// are excluded from the trending ranking. Cuts tiny-baseline noise from the
// trending tab (a 1 -> 5 package no longer dominates) without affecting the
// card stats for those packages when viewed via other tabs.
//
// Note: the smoothing prior (k) lives in growth.ts alongside the sync-time
// recompute, since that's the only place the raw formula is evaluated now.
// -----------------------------------------------------------------------------
const TRENDING_MIN_DOWNLOADS: Record<Period, number> = {
  daily: 10,
  weekly: 50,
  monthly: 200,
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

// -----------------------------------------------------------------------------
// In-memory response cache for expensive GET endpoints.
//
// The underlying data only changes when a sync completes (every ~4h), so we
// cache JSON responses keyed by the sync version + full query string. A sync
// completion bumps syncVersion (see cron.ts), so stale entries miss instantly
// — no stale window. The TTL is a safety net + bound on cache size.
//
// Lives inside createApp() so each app instance (and each test) gets an
// isolated cache — no cross-test leakage of cached responses.
// -----------------------------------------------------------------------------
function createResponseCache() {
  const cache = new Map<string, { body: string; status: number; storedAt: number }>();

  function key(parts: string[]): string {
    return `${getSyncVersion()}:${parts.join('|')}`;
  }
  function get(k: string): { body: string; status: number } | null {
    const hit = cache.get(k);
    if (!hit) return null;
    if (Date.now() - hit.storedAt > CACHE_TTL_MS) {
      cache.delete(k);
      return null;
    }
    return { body: hit.body, status: hit.status };
  }
  function set(k: string, body: string, status: number): void {
    // Bound cache size to avoid unbounded growth under a varied query string
    // (e.g. search params, pagination offsets).
    if (cache.size > 512) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(k, { body, status, storedAt: Date.now() });
  }
  return { key, get, set };
}

// =============================================================================
// App factory — used by both the production server (startServer) and tests.
// All middleware, routes, and per-instance caches live here so importing
// index.ts no longer starts the server or spawns the cron interval.
// =============================================================================

export function createApp(): Hono {
  const app = new Hono();
  const responseCache = createResponseCache();

  // CORS for local development
  app.use('/*', cors());

  // Response compression (brotli > gzip > deflate). Registered before etag so
  // compression runs OUTSIDE etag: etag computes its validator on the raw body
  // (and may short-circuit to 304), and we only encode the bytes that ship.
  app.use('/*', compress());

  // ETag for API responses: lets browsers/CDNs revalidate with If-None-Match
  // and get a free 304 (no body) when the payload is unchanged.
  app.use('/api/*', etag());

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
      // Clamp to a sane range. parseInt can yield NaN (non-numeric input) or
      // negatives, and SQLite treats a negative LIMIT as "no bound" (returns
      // every row), so an unclamped `?limit=-1` would bypass the 100-row cap.
      const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10) || 50, 1), 100);
      const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);

      const key = responseCache.key(['packages', sort, period, search, String(limit), String(offset)]);
      const cached = responseCache.get(key);
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
      let havingPart = '';

      switch (sort) {
        case 'trending':
          // Floor on absolute volume so tiny-baseline packages (1 -> 5 with
          // +400%) don't dominate the trending tab. The card still shows their
          // stats; they just don't rank on trending.
          havingPart = `HAVING COALESCE(SUM(CASE WHEN d.date >= date('now', '-${periodDays} days') THEN d.downloads ELSE 0 END), 0) >= ${TRENDING_MIN_DOWNLOADS[period]}`;
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

      const wherePart = `1=1 ${searchCondition} ${extraFilter}`;

      // Get total count. Trending needs the volume floor applied to the count
      // too, otherwise pagination total would over-report (and pages beyond the
      // floor would return empty).
      let countQuery: string;
      if (sort === 'trending') {
        countQuery = `
          SELECT COUNT(*) as total FROM (
            SELECT p.name
            FROM packages p
            LEFT JOIN daily_downloads d ON p.name = d.package_name
            WHERE ${wherePart}
            GROUP BY p.name
            ${havingPart}
          )
        `;
      } else {
        countQuery = `SELECT COUNT(*) as total FROM packages p WHERE ${wherePart}`;
      }
      const countResult = db.prepare(countQuery).get() as { total: number };

      // growth_percent is read from the materialized column (populated at sync
      // time by recomputeGrowthCache). This replaces the inline CASE expression
      // that computed the prev-period SUM + growth arithmetic per request —
      // ~5ms / 33% of every cold-miss query saved. The column value uses the
      // same Bayesian-smoothed formula with NULL for no-baseline packages, so
      // behavior is identical.
      const growthColumn = `${period}_growth`;
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
          p.${growthColumn} as growth_percent,
          COALESCE(SUM(CASE WHEN d.date >= date('now', '-${periodDays} days') THEN d.downloads ELSE 0 END), 0) as period_downloads,
          COALESCE(SUM(CASE WHEN d.date >= date('now', '-7 days') THEN d.downloads ELSE 0 END), 0) as weekly_downloads,
          COALESCE(SUM(CASE WHEN d.date >= date('now', '-30 days') THEN d.downloads ELSE 0 END), 0) as monthly_downloads
        FROM packages p
        LEFT JOIN daily_downloads d ON p.name = d.package_name
        WHERE ${wherePart}
        GROUP BY p.name
        ${havingPart}
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
        const growth: number | null = pkg.growth_percent !== null
          ? Math.round(pkg.growth_percent * 10) / 10
          : null;

        const sparkline = sparklineMap.get(pkg.name) || [];

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

      const serialized = JSON.stringify(resultBody);
      responseCache.set(key, serialized, 200);

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

      const pkg = db.prepare(`
        SELECT * FROM packages WHERE name = ?
      `).get(name) as any;

      if (!pkg) {
        return c.json({ error: 'Package not found' }, 404);
      }

      const downloads = db.prepare(`
        SELECT date, downloads
        FROM daily_downloads
        WHERE package_name = ? AND date >= date('now', '-30 days')
        ORDER BY date ASC
      `).all(name) as Array<{ date: string; downloads: number }>;

      const now = Date.now();
      const dailyDownloads = downloads
        .filter(d => new Date(d.date) >= new Date(now - 1 * 24 * 60 * 60 * 1000))
        .reduce((sum, d) => sum + d.downloads, 0);
      const weeklyDownloads = downloads
        .filter(d => new Date(d.date) >= new Date(now - 7 * 24 * 60 * 60 * 1000))
        .reduce((sum, d) => sum + d.downloads, 0);
      const monthlyDownloads = downloads
        .reduce((sum, d) => sum + d.downloads, 0);

      // Read materialized weekly growth from the packages table (computed at
      // sync time) so the detail view's badge matches the list view exactly.
      const growth: number | null = pkg.weekly_growth !== null && pkg.weekly_growth !== undefined
        ? Math.round(pkg.weekly_growth * 10) / 10
        : null;

      const sparkline = downloads.slice(-7).map(d => d.downloads);

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
      const key = responseCache.key(['stats']);
      const cached = responseCache.get(key);
      if (cached) {
        return new Response(cached.body, {
          status: cached.status,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': API_CACHE_CONTROL,
          },
        });
      }

      // Read materialized stats (computed once per sync). Falls back to a live
      // recompute only on cold start (no sync has ever run).
      let stats = getStatsCache();
      if (!stats) {
        stats = recomputeStatsCache();
      }

      const db = getDb();
      const nextSyncTime = getNextRunTime();
      const lastResult = getLastSyncResult();

      const syncMetaRow = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get('last_incremental_sync') as { value: string } | undefined;

      // total_packages: always live from the DB. The cached value can go stale
      // after an external write to `packages` that doesn't recompute the stats
      // cache (e.g. a manual `nub run sync` from the CLI, or any future direct
      // write). COUNT(*) on this table is sub-millisecond, so we skip the cache
      // for this one field and trust it for everything else.
      const liveTotal = (db.prepare('SELECT COUNT(*) as count FROM packages').get() as { count: number }).count;

      const resultBody = {
        total_packages: liveTotal,
        total_weekly_downloads: stats.total_weekly_downloads,
        total_monthly_downloads: stats.total_monthly_downloads,
        average_growth: stats.average_growth,
        last_sync: syncMetaRow?.value || null,
        next_sync: nextSyncTime?.toISOString() || null,
        sync_running: isSyncRunning(),
        last_sync_mode: lastResult?.mode || null,
      };

      const serialized = JSON.stringify(resultBody);
      responseCache.set(key, serialized, 200);

      return c.json(resultBody, 200, { 'cache-control': API_CACHE_CONTROL });
    } catch (err) {
      console.error('[API] Error fetching stats:', err);
      return c.json({ error: 'Failed to fetch stats' }, 500);
    }
  });

  // =============================================================================
  // Static Files (Frontend) — immutable cache with content-version busting
  // =============================================================================
  //
  // Frontend assets are pre-loaded into memory with `?v=<version>` stamped onto
  // every relative reference (HTML asset URLs, JS import/export specifiers,
  // CSS @import/url()). The version rotates on any file mtime change (i.e. on
  // deploy), so:
  //   - assets get `Cache-Control: public, max-age=31536000, immutable` (safe,
  //     because their URL changes when content changes), and
  //   - index.html gets `no-cache` so returning visitors pick up the new ?v=
  //     query strings and re-fetch any changed asset.

  const ASSET_VERSION = computeAssetVersion(FRONTEND_DIR);
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

  return app;
}

// =============================================================================
// Server boot — only runs when index.ts is the entry point, not when imported
// by tests. Guards against starting cron / opening a port during test runs.
// =============================================================================

export function startServer(): void {
  // Start cron scheduler
  startCron();

  // Ensure materialized caches exist at boot (covers cold start — otherwise the
  // first request after the schema migration would compute them lazily).
  // Subsequent syncs refresh both.
  if (!getStatsCache()) {
    recomputeStatsCache();
  }
  if (!growthCacheExists()) {
    recomputeGrowthCache();
  }

  const app = createApp();
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
}

const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && __filename === process.argv[1];
if (isMain) {
  startServer();
}

// Exported for tests that want to reset the singleton between cases.
export { closeDb };
