import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { cors } from 'hono/cors';
import { getDb, closeDb } from './db';
import { startCron, triggerSync, isSyncRunning, getNextRunTime } from './cron';

const app = new Hono();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 0;

// Start cron scheduler
startCron();

// CORS for local development
app.use('/*', cors());

// =============================================================================
// API Routes
// =============================================================================

/**
 * GET /api/packages - List packages with sorting and pagination
 * Query params:
 *   - sort: popular | trending | new | updated (default: popular)
 *   - search: filter by name/description
 *   - limit: number of results (default: 50)
 *   - offset: pagination offset (default: 0)
 */
app.get('/api/packages', async (c) => {
  try {
    const db = getDb();
    const sort = c.req.query('sort') || 'popular';
    const search = c.req.query('search') || '';
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    // Build search condition
    const searchCondition = search
      ? `WHERE (p.name LIKE '%${search.replace(/'/g, "''")}%' OR p.description LIKE '%${search.replace(/'/g, "''")}%')`
      : '';

    // Build sort order and filter
    let orderBy = '';
    let extraFilter = '';
    let whereClause = searchCondition ? 'WHERE' : 'WHERE 1=1';
    
    switch (sort) {
      case 'trending':
        // Sort by growth percentage - will use subquery
        orderBy = `ORDER BY growth_percent DESC NULLS LAST`;
        break;
      case 'new':
        // Packages added within last 30 days
        extraFilter = `date(p.first_seen) >= date('now', '-30 days')`;
        orderBy = `ORDER BY p.first_seen DESC`;
        break;
      case 'updated':
        orderBy = `ORDER BY p.last_publish DESC NULLS LAST`;
        break;
      case 'popular':
        // Sort by weekly downloads (default)
        orderBy = `ORDER BY weekly_downloads DESC NULLS LAST`;
        break;
      case 'alltime':
        // Sort by total (weekly + monthly) downloads
        orderBy = `ORDER BY (weekly_downloads + monthly_downloads) DESC NULLS LAST`;
        break;
      default:
        orderBy = `ORDER BY weekly_downloads DESC NULLS LAST`;
    }

    // Build WHERE clause with search and extra filters
    const conditions: string[] = [];
    if (search) {
      conditions.push(searchCondition.replace('WHERE ', ''));
    }
    if (extraFilter) {
      conditions.push(extraFilter);
    }
    const wherePart = conditions.length > 0 ? conditions.join(' AND ') : '1=1';

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total FROM packages p
      WHERE ${wherePart}
    `;
    const countResult = db.prepare(countQuery).get() as { total: number };
    const total = countResult.total;

    // Get packages with download stats
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
        COALESCE(SUM(CASE WHEN d.date >= date('now', '-7 days') AND d.date NOT LIKE '%\\_%' ESCAPE '\\' THEN d.downloads ELSE 0 END), 0) as weekly_downloads,
        COALESCE(SUM(CASE WHEN d.date >= date('now', '-30 days') AND d.date NOT LIKE '%\\_%' ESCAPE '\\' THEN d.downloads ELSE 0 END), 0) as monthly_downloads,
        COALESCE(SUM(CASE WHEN d.date >= date('now', '-14 days') AND d.date < date('now', '-7 days') AND d.date NOT LIKE '%\\_%' ESCAPE '\\' THEN d.downloads ELSE 0 END), 0) as last_week_downloads,
        COALESCE(SUM(CASE WHEN d.date >= date('now', '-7 days') AND d.date NOT LIKE '%\\_%' ESCAPE '\\' THEN d.downloads ELSE 0 END), 0) as this_week_downloads,
        CASE 
          WHEN COALESCE(SUM(CASE WHEN d.date >= date('now', '-14 days') AND d.date < date('now', '-7 days') AND d.date NOT LIKE '%\\_%' ESCAPE '\\' THEN d.downloads ELSE 0 END), 0) > 0
          THEN (COALESCE(SUM(CASE WHEN d.date >= date('now', '-7 days') AND d.date NOT LIKE '%\\_%' ESCAPE '\\' THEN d.downloads ELSE 0 END), 0) - COALESCE(SUM(CASE WHEN d.date >= date('now', '-14 days') AND d.date < date('now', '-7 days') AND d.date NOT LIKE '%\\_%' ESCAPE '\\' THEN d.downloads ELSE 0 END), 0)) * 100.0 / COALESCE(SUM(CASE WHEN d.date >= date('now', '-14 days') AND d.date < date('now', '-7 days') AND d.date NOT LIKE '%\\_%' ESCAPE '\\' THEN d.downloads ELSE 0 END), 0)
          ELSE CASE WHEN COALESCE(SUM(CASE WHEN d.date >= date('now', '-7 days') AND d.date NOT LIKE '%\\_%' ESCAPE '\\' THEN d.downloads ELSE 0 END), 0) > 0 THEN 100 ELSE NULL END
        END as growth_percent
      FROM packages p
      LEFT JOIN daily_downloads d ON p.name = d.package_name
      WHERE ${wherePart}
      GROUP BY p.name
      ${orderBy}
      LIMIT $limit OFFSET $offset
    `;

    const packages = db.prepare(query).all({ $limit: limit, $offset: offset }) as any[];

    // Calculate growth percentage for trending
    const packagesWithGrowth = packages.map(pkg => {
      let growth = null;
      if (pkg.growth_percent !== null) {
        growth = Math.round(pkg.growth_percent * 10) / 10;
      } else if (pkg.this_week_downloads > 0) {
        growth = 100; // New package with downloads
      }
      
      // Get sparkline data (last 7 days)
      const sparklineData = db.prepare(`
        SELECT downloads FROM daily_downloads
        WHERE package_name = $name AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date >= date('now', '-7 days')
        ORDER BY date ASC
      `).all({ $name: pkg.name }) as Array<{ downloads: number }>;
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
        weekly_downloads: pkg.weekly_downloads,
        monthly_downloads: pkg.monthly_downloads,
        total_downloads: pkg.weekly_downloads + pkg.monthly_downloads,
        growth,
        sparkline,
      };
    });

    // Sort by growth if trending
    if (sort === 'trending') {
      packagesWithGrowth.sort((a, b) => (b.growth || -Infinity) - (a.growth || -Infinity));
    }

    return c.json({
      packages: packagesWithGrowth,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
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
      SELECT * FROM packages WHERE name = $name
    `).get({ $name: name }) as any;

    if (!pkg) {
      return c.json({ error: 'Package not found' }, 404);
    }

    // Get download history for last 30 days
    const downloads = db.prepare(`
      SELECT date, downloads 
      FROM daily_downloads 
      WHERE package_name = $name AND date >= date('now', '-30 days')
      ORDER BY date ASC
    `).all({ $name: name }) as Array<{ date: string; downloads: number }>;

    // Calculate stats
    const weeklyDownloads = downloads
      .filter(d => new Date(d.date) >= new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
      .reduce((sum, d) => sum + d.downloads, 0);

    const lastWeekDownloads = downloads
      .filter(d => {
        const date = new Date(d.date);
        const now = Date.now();
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
      weekly_downloads: weeklyDownloads,
      monthly_downloads: downloads.reduce((sum, d) => sum + d.downloads, 0),
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
    
    const totalDownloads = db.prepare(`
      SELECT SUM(downloads) as total 
      FROM daily_downloads 
      WHERE date >= date('now', '-7 days')
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

    const lastSync = getNextRunTime();

    return c.json({
      total_packages: totalPackages.count,
      total_weekly_downloads: totalDownloads.total || 0,
      average_growth: avgGrowth.avg ? Math.round(avgGrowth.avg * 10) / 10 : 0,
      last_sync: lastSync?.toISOString() || null,
      next_sync: lastSync?.toISOString() || null,
      sync_running: isSyncRunning(),
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
    const result = await triggerSync();
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
  return c.html(await Bun.file('./frontend/index.html').text());
});

// =============================================================================
// Server
// =============================================================================

const server = Bun.serve({
  port: PORT,
  fetch: app.fetch,
});

console.log(`[Server] Starting on port ${server.port}`);
console.log(`[Server] Dashboard: http://localhost:${server.port}`);
console.log(`[Server] API: http://localhost:${server.port}/api/packages`);

process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  server.stop();
  closeDb();
  process.exit(0);
});
