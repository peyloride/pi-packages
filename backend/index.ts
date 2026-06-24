import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { readFileSync } from 'node:fs';
import { getDb, closeDb } from './db';
import { startCron, triggerSync, isSyncRunning, getNextRunTime, getLastSyncResult } from './cron';

const app = new Hono();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Start cron scheduler
startCron();

// CORS for local development
app.use('/*', cors());

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
    const db = getDb();
    const sort = c.req.query('sort') || 'popular';
    const period = parsePeriod(c.req.query('period'));
    const periodDays = PERIOD_DAYS[period];
    const periodLabel = period === 'daily' ? 'day' : period === 'weekly' ? 'week' : 'month';
    const search = c.req.query('search') || '';
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
    const offset = parseInt(c.req.query('offset') || '0', 10);

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

    // Enrich with sparkline + format
    const packagesWithGrowth = packages.map(pkg => {
      let growth = null;
      if (pkg.growth_percent !== null) {
        growth = Math.round(pkg.growth_percent * 10) / 10;
      } else if (pkg.period_downloads > 0) {
        growth = 100;
      }

      // Get sparkline data for the selected period (up to 7 data points)
      const sparklineDays = Math.min(periodDays, 7);
      const sparklineData = db.prepare(`
        SELECT downloads FROM daily_downloads
        WHERE package_name = ?
        AND date >= date('now', '-${sparklineDays} days')
        ORDER BY date ASC
      `).all(pkg.name) as Array<{ downloads: number }>;
      const sparkline = sparklineData.map(d => d.downloads);

      return {
        name: pkg.name,
        description: pkg.description,
        version: pkg.version,
        keywords: pkg.keywords ? JSON.parse(pkg.keywords) : [],
        publisher: pkg.publisher,
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

    return c.json({
      packages: packagesWithGrowth,
      period,
      pagination: {
        total: countResult.total,
        limit,
        offset,
        hasMore: offset + limit < countResult.total,
      },
    });
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

    return c.json({
      ...pkg,
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

    return c.json({
      total_packages: totalPackages.count,
      total_weekly_downloads: totalWeeklyDownloads.total || 0,
      total_monthly_downloads: totalMonthlyDownloads.total || 0,
      average_growth: avgGrowth.avg ? Math.round(avgGrowth.avg * 10) / 10 : 0,
      last_sync: syncMetaRow?.value || null,
      next_sync: nextSyncTime?.toISOString() || null,
      sync_running: isSyncRunning(),
      last_sync_mode: lastResult?.mode || null,
    });
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
// Static Files (Frontend)
// =============================================================================

app.use('/*', serveStatic({ root: './frontend' }));

// Fallback to index.html for SPA routing
app.get('*', async (c) => {
  const html = readFileSync('./frontend/index.html', 'utf-8');
  return c.html(html);
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
