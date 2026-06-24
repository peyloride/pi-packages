import { getDb } from './db';
import { fileURLToPath } from 'node:url';

const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';
const NPM_DOWNLOADS_URL = 'https://api.npmjs.org/downloads';
const RATE_LIMIT_DELAY = 500; // 500ms between requests (npm registry rate limit friendly)
const MAX_RETRIES = 5; // Max retries on transient errors (429, 5xx)
const RETRY_BASE_DELAY = 2000; // 2s base for exponential backoff
const BATCH_SIZE = 128; // Packages per bulk download request (npm limit for /range)
const SYNC_META_KEY = 'last_incremental_sync'; // Key in sync_meta table

// =============================================================================
// Types
// =============================================================================

interface NpmSearchResult {
  updated?: string;  // Last modified date from search API
  package: {
    name: string;
    version: string;
    description?: string;
    keywords?: string[];
    publisher?: { username: string };
    links?: { npm?: string; repository?: string };
    date?: string;  // Version publish date
  };
  score: {
    detail: { popularity: number };
  };
}

interface NpmSearchResponse {
  total: number;
  objects: NpmSearchResult[];
  time?: string;
}

interface NpmRangeDay {
  downloads: number;
  day: string;
}

interface NpmRangeDownloadsResponse {
  start: string;
  end: string;
  package: string;
  downloads: NpmRangeDay[];
}

interface DownloadData {
  daily: Map<string, number>;  // date -> downloads (last 30 days)
  weekly: number;
  monthly: number;
  lastWeek: number;
}

export interface SyncResult {
  packages: number;
  newPackages: number;
  updatedPackages: number;
  downloadsUpdated: number;
  mode: 'full' | 'incremental';
}

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fmt(d: Date): string {
  return d.toISOString().split('T')[0];
}

function isScopedPackage(name: string): boolean {
  return name.startsWith('@');
}

/**
 * Retry-aware fetch wrapper for npm API calls.
 * Retries on 429 and 5xx with exponential backoff.
 */
async function npmFetch(url: string): Promise<Response> {
  let response: Response | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    response = await fetch(url);
    if (response.ok) return response;

    if (response.status === 429 || response.status >= 500) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const delay = retryAfterHeader
        ? Math.max(parseInt(retryAfterHeader, 10) * 1000, RETRY_BASE_DELAY)
        : RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
      console.warn(`[Sync] npm returned ${response.status}, retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})...`);
      await sleep(delay);
      continue;
    }

    // 4xx client error (not 429) — don't retry
    break;
  }

  return response!;
}

// =============================================================================
// sync_meta helpers
// =============================================================================

function getSyncMeta(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setSyncMeta(key: string, value: string): void {
  const db = getDb();
  db.prepare('INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// =============================================================================
// Fetch package list from npm search (light — no download data)
// =============================================================================

/**
 * Fetch all packages tagged with 'pi-package' from npm registry.
 * This is lightweight — only fetches the package list from the search API.
 * No download data is fetched here.
 */
export async function fetchPiPackages(): Promise<NpmSearchResult[]> {
  const allPackages: NpmSearchResult[] = [];
  let from = 0;
  const size = 250; // npm max per page
  let total = Infinity;

  console.log('[Sync] Fetching package list from npm registry...');

  while (from < total) {
    const url = `${NPM_SEARCH_URL}?text=keywords:pi-package&size=${size}&from=${from}`;

    const response = await npmFetch(url);
    if (!response.ok) {
      throw new Error(`npm search failed after ${MAX_RETRIES} retries: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as NpmSearchResponse;
    total = data.total;
    allPackages.push(...data.objects);

    console.log(`[Sync] Fetched ${allPackages.length}/${total} packages...`);

    from += size;

    if (from < total) {
      await sleep(RATE_LIMIT_DELAY);
    }
  }

  console.log(`[Sync] Found ${allPackages.length} packages on npm`);
  return allPackages;
}

// =============================================================================
// Diff — find new / changed packages vs database
// =============================================================================

interface DiffResult {
  /** Packages not in the DB at all */
  newPackages: NpmSearchResult[];
  /** Packages in the DB whose version or last_publish has changed */
  updatedPackages: NpmSearchResult[];
  /** Packages unchanged (still in DB with same version) */
  unchangedPackages: NpmSearchResult[];
  /** Package names that exist in the DB but were NOT in the npm results (removed/unlisted) */
  removedNames: string[];
}

/**
 * Compare fetched packages against the database to find new and changed ones.
 * A package is "changed" if its version differs or if it has a newer last_publish date.
 */
export function diffPackages(packages: NpmSearchResult[]): DiffResult {
  const db = getDb();

  // Build a map of existing packages from DB
  const existingRows = db.prepare('SELECT name, version, last_publish FROM packages').all() as Array<{ name: string; version: string; last_publish: string | null }>;
  const existingMap = new Map(existingRows.map(r => [r.name, r]));

  const fetchedNames = new Set(packages.map(p => p.package.name));
  const removedNames = existingRows.filter(r => !fetchedNames.has(r.name)).map(r => r.name);

  const newPackages: NpmSearchResult[] = [];
  const updatedPackages: NpmSearchResult[] = [];
  const unchangedPackages: NpmSearchResult[] = [];

  for (const pkg of packages) {
    const existing = existingMap.get(pkg.package.name);

    if (!existing) {
      newPackages.push(pkg);
    } else {
      // Only version matters — npm 'updated' timestamps fluctuate between search calls
      if (existing.version !== pkg.package.version) {
        updatedPackages.push(pkg);
      } else {
        unchangedPackages.push(pkg);
      }
    }
  }

  return { newPackages, updatedPackages, unchangedPackages, removedNames };
}

// =============================================================================
// Fetch download data (heavy)
// =============================================================================

/**
 * Fetch daily download data for a single package via /range endpoint.
 */
async function fetchDailyDownloadsSingle(packageName: string): Promise<Map<string, number>> {
  const now = new Date();
  const start = fmt(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
  const end = fmt(now);

  const dailyMap = new Map<string, number>();

  const rangeUrl = `${NPM_DOWNLOADS_URL}/range/${start}:${end}/${packageName}`;
  const rangeRes = await fetch(rangeUrl);
  if (rangeRes.ok) {
    const data = await rangeRes.json() as NpmRangeDownloadsResponse;
    for (const day of data.downloads) {
      dailyMap.set(day.day, day.downloads);
    }
  }

  return dailyMap;
}

/**
 * Fetch download counts in batches.
 * Uses /range endpoint for real daily data (sparklines + aggregation).
 * Scoped packages are fetched individually (no bulk support).
 */
export async function fetchDownloadsBatched(
  packageNames: string[]
): Promise<Map<string, DownloadData>> {
  if (packageNames.length === 0) return new Map();

  const allDownloads = new Map<string, DownloadData>();

  const scopedPackages = packageNames.filter(isScopedPackage);
  const nonScopedPackages = packageNames.filter(n => !isScopedPackage(n));

  const now = new Date();
  const rangeStart = fmt(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
  const rangeEnd = fmt(now);
  const weekAgo = fmt(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  const twoWeeksAgo = fmt(new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000));

  // Process non-scoped packages in bulk batches using /range endpoint
  const batches: string[][] = [];
  for (let i = 0; i < nonScopedPackages.length; i += BATCH_SIZE) {
    batches.push(nonScopedPackages.slice(i, i + BATCH_SIZE));
  }

  console.log(`[Sync] Fetching downloads: ${nonScopedPackages.length} non-scoped (${batches.length} batches) + ${scopedPackages.length} scoped (individual)`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const packageList = batch.join(',');

    const rangeUrl = `${NPM_DOWNLOADS_URL}/range/${rangeStart}:${rangeEnd}/${packageList}`;
    const rangeResponse = await npmFetch(rangeUrl);

    if (rangeResponse.ok) {
      const rangeData = await rangeResponse.json() as { [key: string]: NpmRangeDownloadsResponse | null };
      for (const [pkgName, pkgData] of Object.entries(rangeData)) {
        if (!pkgData) continue;
        const daily = new Map<string, number>();
        for (const day of pkgData.downloads) {
          daily.set(day.day, day.downloads);
        }

        let weekly = 0, monthly = 0, lastWeek = 0;
        for (const [date, dl] of daily) {
          if (date >= rangeStart) monthly += dl;
          if (date >= weekAgo) weekly += dl;
          if (date >= twoWeeksAgo && date < weekAgo) lastWeek += dl;
        }

        allDownloads.set(pkgName, { daily, weekly, monthly, lastWeek });
      }
    }

    console.log(`[Sync] Batch ${i + 1}/${batches.length} complete`);

    if (i < batches.length - 1) {
      await sleep(RATE_LIMIT_DELAY);
    }
  }

  // Fetch scoped packages individually
  for (let i = 0; i < scopedPackages.length; i++) {
    try {
      const daily = await fetchDailyDownloadsSingle(scopedPackages[i]);

      let weekly = 0, monthly = 0, lastWeek = 0;
      for (const [date, dl] of daily) {
        if (date >= rangeStart) monthly += dl;
        if (date >= weekAgo) weekly += dl;
        if (date >= twoWeeksAgo && date < weekAgo) lastWeek += dl;
      }

      if (weekly > 0 || monthly > 0) {
        allDownloads.set(scopedPackages[i], { daily, weekly, monthly, lastWeek });
      }
    } catch {
      // Skip packages that fail
    }
    if ((i + 1) % 50 === 0 || i === scopedPackages.length - 1) {
      console.log(`[Sync] Scoped packages: ${i + 1}/${scopedPackages.length}`);
    }
    await sleep(RATE_LIMIT_DELAY);
  }

  return allDownloads;
}

// =============================================================================
// DB upsert helpers
// =============================================================================

/**
 * Persist package metadata to SQLite
 */
export function upsertPackage(pkg: NpmSearchResult): void {
  const db = getDb();
  const now = new Date().toISOString();

  // Clean up GitHub URL - remove git+ prefix and .git suffix
  let githubUrl = pkg.package.links?.repository || null;
  if (githubUrl) {
    githubUrl = githubUrl.replace(/^git\+/, '').replace(/\.git$/, '');
  }

  const stmt = db.prepare(`
    INSERT INTO packages (name, description, version, keywords, publisher, github_url, npm_url, first_seen, last_publish)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      description = excluded.description,
      version = excluded.version,
      keywords = excluded.keywords,
      publisher = excluded.publisher,
      github_url = excluded.github_url,
      last_publish = excluded.last_publish
  `);

  stmt.run(
    pkg.package.name,
    pkg.package.description || null,
    pkg.package.version,
    pkg.package.keywords ? JSON.stringify(pkg.package.keywords) : null,
    pkg.package.publisher?.username || null,
    githubUrl,
    pkg.package.links?.npm || `https://www.npmjs.com/package/${pkg.package.name}`,
    pkg.package.date || now,
    pkg.updated || null,
  );
}

/**
 * Persist daily download data to SQLite.
 */
export function upsertDownloads(packageName: string, data: DownloadData): void {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO daily_downloads (package_name, date, downloads)
    VALUES (?, ?, ?)
    ON CONFLICT(package_name, date) DO UPDATE SET
      downloads = excluded.downloads
  `);

  // NOTE: Node.js `DatabaseSync` does not expose a `transaction()` method
  // like `bun:sqlite` does. We run the delete + inserts sequentially inside a
  // single `exec()`-based transaction for atomicity.
  db.exec('BEGIN TRANSACTION');
  try {
    db.prepare('DELETE FROM daily_downloads WHERE package_name = ?').run(packageName);

    for (const [date, downloads] of data.daily) {
      stmt.run(packageName, date, downloads);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// =============================================================================
// Incremental download refresh (sliding window)
// =============================================================================

/**
 * Incrementally refresh download data for ALL packages.
 * Instead of re-fetching the full 30-day range, only fetch the days since
 * our last successful sync. If the gap is too large (>25 days), fall back
 * to full fetch.
 *
 * This uses the npm /range endpoint which returns per-day data, so we can
 * request just the delta days and upsert them into the existing table.
 */
async function refreshDownloadsIncremental(allPackageNames: string[]): Promise<number> {
  const lastSync = getSyncMeta(SYNC_META_KEY);
  const now = new Date();
  const today = fmt(now);

  // Calculate the range we need to fetch
  let rangeStart: string;
  if (lastSync) {
    const lastSyncDate = new Date(lastSync);
    const daysSinceSync = (now.getTime() - lastSyncDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceSync > 25) {
      // Gap too large — fall back to full 30-day range
      rangeStart = fmt(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
      console.log(`[Sync] Gap since last sync is ${Math.round(daysSinceSync)} days — using full 30-day range`);
    } else {
      // Fetch from the day after last sync
      rangeStart = fmt(new Date(lastSyncDate.getTime() + 24 * 60 * 60 * 1000));
      console.log(`[Sync] Incremental download refresh: ${rangeStart} to ${today}`);
    }
  } else {
    // Never synced before — full range
    rangeStart = fmt(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
    console.log('[Sync] No previous sync found — using full 30-day range');
  }

  // If rangeStart is today or in the future, nothing to fetch
  if (rangeStart > today) {
    console.log('[Sync] Download data is up to date — nothing to refresh');
    return 0;
  }

  const scopedPackages = allPackageNames.filter(isScopedPackage);
  const nonScopedPackages = allPackageNames.filter(n => !isScopedPackage(n));

  let downloadsUpdated = 0;

  // Batch non-scoped packages
  const batches: string[][] = [];
  for (let i = 0; i < nonScopedPackages.length; i += BATCH_SIZE) {
    batches.push(nonScopedPackages.slice(i, i + BATCH_SIZE));
  }

  console.log(`[Sync] Refreshing downloads: ${nonScopedPackages.length} non-scoped (${batches.length} batches) + ${scopedPackages.length} scoped`);

  const weekAgo = fmt(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  const twoWeeksAgo = fmt(new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000));
  const fullRangeStart = fmt(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const packageList = batch.join(',');

    const rangeUrl = `${NPM_DOWNLOADS_URL}/range/${rangeStart}:${today}/${packageList}`;
    const rangeResponse = await npmFetch(rangeUrl);

    if (rangeResponse.ok) {
      const rangeData = await rangeResponse.json() as { [key: string]: NpmRangeDownloadsResponse | null };

      const db = getDb();
      const upsertStmt = db.prepare(`
        INSERT INTO daily_downloads (package_name, date, downloads)
        VALUES (?, ?, ?)
        ON CONFLICT(package_name, date) DO UPDATE SET
          downloads = excluded.downloads
      `);

      db.exec('BEGIN TRANSACTION');
      try {
        for (const [pkgName, pkgData] of Object.entries(rangeData)) {
          if (!pkgData) continue;

          for (const day of pkgData.downloads) {
            upsertStmt.run(pkgName, day.day, day.downloads);
          }
          downloadsUpdated++;
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }

    console.log(`[Sync] Batch ${i + 1}/${batches.length} complete (${downloadsUpdated} packages updated)`);

    if (i < batches.length - 1) {
      await sleep(RATE_LIMIT_DELAY);
    }
  }

  // Scoped packages individually
  const db = getDb();
  const upsertStmt = db.prepare(`
    INSERT INTO daily_downloads (package_name, date, downloads)
    VALUES (?, ?, ?)
    ON CONFLICT(package_name, date) DO UPDATE SET
      downloads = excluded.downloads
  `);

  for (let i = 0; i < scopedPackages.length; i++) {
    try {
      const rangeUrl = `${NPM_DOWNLOADS_URL}/range/${rangeStart}:${today}/${encodeURIComponent(scopedPackages[i])}`;
      const rangeRes = await fetch(rangeUrl);
      if (rangeRes.ok) {
        const data = await rangeRes.json() as NpmRangeDownloadsResponse;

        db.exec('BEGIN TRANSACTION');
        try {
          for (const day of data.downloads) {
            upsertStmt.run(scopedPackages[i], day.day, day.downloads);
          }
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        downloadsUpdated++;
      }
    } catch {
      // Skip
    }

    if ((i + 1) % 50 === 0 || i === scopedPackages.length - 1) {
      console.log(`[Sync] Scoped packages: ${i + 1}/${scopedPackages.length}`);
    }
    await sleep(RATE_LIMIT_DELAY);
  }

  // Prune download data older than 30 days to keep the table small
  db.prepare('DELETE FROM daily_downloads WHERE date < ?').run(fullRangeStart);

  return downloadsUpdated;
}

// =============================================================================
// Sync entry points
// =============================================================================

/**
 * Incremental sync — fast periodic update.
 *
 * 1. Paginates npm search to discover the full package list (lightweight, ~12 API calls)
 * 2. Diffs against DB to find new/changed packages
 * 3. Upserts only new/changed package metadata
 * 4. Refreshes download data incrementally (only new days since last sync)
 * 5. Records sync timestamp
 *
 * This is designed to run every few hours in production.
 */
export async function runIncrementalSync(): Promise<SyncResult> {
  const startTime = Date.now();
  console.log('[Sync] Starting incremental sync at', new Date().toISOString());

  // 1. Discover package list from npm
  const packages = await fetchPiPackages();

  // 2. Diff against DB
  const diff = diffPackages(packages);
  console.log(`[Sync] Diff: ${diff.newPackages.length} new, ${diff.updatedPackages.length} updated, ${diff.unchangedPackages.length} unchanged`);

  // 3. Upsert only new + changed package metadata
  const packagesToUpsert = [...diff.newPackages, ...diff.updatedPackages];
  if (packagesToUpsert.length > 0) {
    const db = getDb();
    // Use manual transaction since node:sqlite doesn't have bun:sqlite's .transaction()
    db.exec('BEGIN TRANSACTION');
    try {
      for (const pkg of packagesToUpsert) {
        upsertPackage(pkg);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    console.log(`[Sync] Upserted ${packagesToUpsert.length} package records`);
  }

  // 4. Fetch full downloads for new/updated packages
  let downloadsUpdated = 0;
  if (packagesToUpsert.length > 0) {
    const names = packagesToUpsert.map(p => p.package.name);
    const allDownloads = await fetchDownloadsBatched(names);

    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO daily_downloads (package_name, date, downloads)
      VALUES (?, ?, ?)
      ON CONFLICT(package_name, date) DO UPDATE SET
        downloads = excluded.downloads
    `);

    db.exec('BEGIN TRANSACTION');
    try {
      for (const pkg of packagesToUpsert) {
        const downloads = allDownloads.get(pkg.package.name);
        if (downloads && (downloads.weekly > 0 || downloads.monthly > 0)) {
          db.prepare('DELETE FROM daily_downloads WHERE package_name = ?').run(pkg.package.name);
          for (const [date, dl] of downloads.daily) {
            stmt.run(pkg.package.name, date, dl);
          }
          downloadsUpdated++;
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // 5. Incrementally refresh download data for ALL packages (sliding window)
  const allNames = packages.map(p => p.package.name);
  const refreshedCount = await refreshDownloadsIncremental(allNames);
  downloadsUpdated += refreshedCount;

  // 6. Mark packages as removed if they disappeared from npm
  if (diff.removedNames.length > 0) {
    console.log(`[Sync] ${diff.removedNames.length} packages no longer found on npm (retaining in DB)`);
    // We keep them in DB — they might just be temporarily unavailable
  }

  // 7. Record sync timestamp
  setSyncMeta(SYNC_META_KEY, new Date().toISOString());

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Sync] Incremental complete in ${elapsed}s! ${packages.length} packages, ${diff.newPackages.length} new, ${diff.updatedPackages.length} updated, ${downloadsUpdated} download records refreshed`);

  return {
    packages: packages.length,
    newPackages: diff.newPackages.length,
    updatedPackages: diff.updatedPackages.length,
    downloadsUpdated,
    mode: 'incremental',
  };
}

/**
 * Full sync — fetch everything from scratch.
 *
 * 1. Fetches all package metadata from npm search
 * 2. Upserts all package records
 * 3. Re-fetches full 30-day download data for ALL packages
 *
 * Use this for initial setup or periodic full refreshes (e.g. weekly).
 */
export async function runFullSync(): Promise<SyncResult> {
  const startTime = Date.now();
  console.log('[Sync] Starting FULL sync at', new Date().toISOString());

  // 1. Fetch packages
  const packages = await fetchPiPackages();
  console.log(`[Sync] Saving ${packages.length} packages to database...`);

  // 2. Save all package metadata
  const db = getDb();
  db.exec('BEGIN TRANSACTION');
  try {
    for (const pkg of packages) {
      upsertPackage(pkg);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // 3. Diff to count new/updated for reporting
  const diff = diffPackages(packages);

  // 4. Fetch download data in batches for ALL packages
  const packageNames = packages.map(p => p.package.name);
  const allDownloads = await fetchDownloadsBatched(packageNames);

  // 5. Save downloads for each package
  let downloadsUpdated = 0;
  const stmt = db.prepare(`
    INSERT INTO daily_downloads (package_name, date, downloads)
    VALUES (?, ?, ?)
    ON CONFLICT(package_name, date) DO UPDATE SET
      downloads = excluded.downloads
  `);

  db.exec('BEGIN TRANSACTION');
  try {
    for (const pkg of packages) {
      const downloads = allDownloads.get(pkg.package.name);
      if (downloads && (downloads.weekly > 0 || downloads.monthly > 0)) {
        db.prepare('DELETE FROM daily_downloads WHERE package_name = ?').run(pkg.package.name);
        for (const [date, dl] of downloads.daily) {
          stmt.run(pkg.package.name, date, dl);
        }
        downloadsUpdated++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // 6. Record sync timestamp
  setSyncMeta(SYNC_META_KEY, new Date().toISOString());

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Sync] Full sync complete in ${elapsed}s! ${packages.length} packages, ${downloadsUpdated} download histories updated`);

  return {
    packages: packages.length,
    newPackages: diff.newPackages.length,
    updatedPackages: diff.updatedPackages.length,
    downloadsUpdated,
    mode: 'full',
  };
}

/**
 * Backwards-compatible wrapper — runs incremental by default, full with --full flag.
 */
export async function runSync(): Promise<SyncResult> {
  const fullFlag = process.argv.includes('--full');
  if (fullFlag) {
    return runFullSync();
  }
  // If we've never synced before, force full
  const lastSync = getSyncMeta(SYNC_META_KEY);
  if (!lastSync) {
    console.log('[Sync] No previous sync found — running full sync first');
    return runFullSync();
  }
  return runIncrementalSync();
}

// =============================================================================
// CLI entry point
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && __filename === process.argv[1];

if (isMain) {
  const isFull = process.argv.includes('--full');

  runSync()
    .then(result => {
      console.log('[Sync] Completed successfully:', result);
      process.exit(0);
    })
    .catch(err => {
      console.error('[Sync] Failed:', err);
      process.exit(1);
    });
}
