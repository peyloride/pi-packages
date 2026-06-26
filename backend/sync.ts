import { getDb } from './db';
import { fileURLToPath } from 'node:url';

const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';
const NPM_DOWNLOADS_URL = 'https://api.npmjs.org/downloads';
const RATE_LIMIT_DELAY = 500; // 500ms between requests (npm registry rate limit friendly)
const MAX_RETRIES = 5; // Max retries on transient errors (429, 5xx)
const RETRY_BASE_DELAY = 2000; // 2s base for exponential backoff
const BATCH_SIZE = 128; // Packages per bulk download request (npm limit for /range)
const DOWNLOAD_CONCURRENCY = 8; // Max concurrent npm downloads API requests
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
 * Run an async mapper over `items` with at most `limit` concurrent invocations.
 * Preserves input order in the returned array. `fn` may throw; the rejection
 * propagates immediately and abandons remaining work.
 */
async function pMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Aggregate weekly / monthly / last-week download totals from a daily map.
 * `monthStart` is the inclusive lower bound for "monthly" (30-day window).
 */
function aggregateStats(
  daily: Map<string, number>,
  monthStart: string,
  weekAgo: string,
  twoWeeksAgo: string,
): { weekly: number; monthly: number; lastWeek: number } {
  let weekly = 0, monthly = 0, lastWeek = 0;
  for (const [date, dl] of daily) {
    if (date >= monthStart) monthly += dl;
    if (date >= weekAgo) weekly += dl;
    if (date >= twoWeeksAgo && date < weekAgo) lastWeek += dl;
  }
  return { weekly, monthly, lastWeek };
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
 * Type guard for npm /range response entries.
 *
 * The contract is `{ package, start, end, downloads: [{ day, downloads }] }`
 * but under rate-limit pressure npm can return 200 OK with a non-standard body
 * (e.g. an error envelope like `{ "error": "..." }` after a 429 retry). Treat
 * any value that doesn't match the expected shape as "no data" rather than
 * throwing — one malformed package shouldn't kill the whole sync.
 */
function isRangeDownloads(value: unknown): value is NpmRangeDownloadsResponse {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.downloads);
}

/**
 * Execute one bulk /range request covering up to `BATCH_SIZE` packages.
 * Returns Map<name, DownloadData> for every package npm responded to
 * (including zero-traffic ones — caller filters at DB-write time if needed).
 * Returns an empty map on non-OK response (npmFetch already retried 429/5xx).
 */
async function executeBulkFetch(
  packages: string[],
  rangeStart: string,
  rangeEnd: string,
  weekAgo: string,
  twoWeeksAgo: string,
  monthStart: string,
): Promise<Map<string, DownloadData>> {
  const result = new Map<string, DownloadData>();
  if (packages.length === 0) return result;

  const rangeUrl = `${NPM_DOWNLOADS_URL}/range/${rangeStart}:${rangeEnd}/${packages.join(',')}`;
  const response = await npmFetch(rangeUrl);
  if (!response.ok) return result;

  const data = await response.json() as unknown;
  // Guard the top-level body too: npm can return 200 with `null` or a
  // non-object body under rate-limit pressure, and Object.entries(null)
  // throws on its own.
  if (!data || typeof data !== 'object') return result;
  for (const [pkgName, pkgData] of Object.entries(data as Record<string, unknown>)) {
    // Skip null entries (package not found) AND any malformed body shapes
    // (e.g. an `{ error: "..." }` envelope npm sometimes returns under
    // rate-limit pressure). See isRangeDownloads for the rationale.
    if (!isRangeDownloads(pkgData)) continue;
    const daily = new Map<string, number>();
    for (const day of pkgData.downloads) {
      if (!day || typeof day.day !== 'string' || typeof day.downloads !== 'number') continue;
      daily.set(day.day, day.downloads);
    }
    result.set(pkgName, { daily, ...aggregateStats(daily, monthStart, weekAgo, twoWeeksAgo) });
  }
  return result;
}

/**
 * Execute one single-package /range request (used for scoped packages,
 * which npm doesn't support in the bulk endpoint). Returns null if the
 * package has zero traffic (mirrors the legacy filter).
 */
async function executeSingleFetch(
  name: string,
  rangeStart: string,
  rangeEnd: string,
  weekAgo: string,
  twoWeeksAgo: string,
  monthStart: string,
): Promise<DownloadData | null> {
  try {
    const rangeUrl = `${NPM_DOWNLOADS_URL}/range/${rangeStart}:${rangeEnd}/${encodeURIComponent(name)}`;
    const response = await fetch(rangeUrl);
    if (!response.ok) return null;
    const data = await response.json() as unknown;
    if (!isRangeDownloads(data)) return null;
    const daily = new Map<string, number>();
    for (const day of data.downloads) {
      if (!day || typeof day.day !== 'string' || typeof day.downloads !== 'number') continue;
      daily.set(day.day, day.downloads);
    }
    const stats = aggregateStats(daily, monthStart, weekAgo, twoWeeksAgo);
    if (stats.weekly === 0 && stats.monthly === 0) return null;
    return { daily, ...stats };
  } catch {
    return null;
  }
}

/**
 * Fetch download counts concurrently.
 *
 * Uses the /range endpoint for real daily data (sparklines + rolling
 * aggregation). Non-scoped packages go through the bulk endpoint (up to
 * `BATCH_SIZE` per request); scoped packages must be fetched individually
 * because npm's bulk endpoint doesn't accept them.
 *
 * All tasks (bulk batches + single scoped fetches) share a single
 * `DOWNLOAD_CONCURRENCY`-wide worker pool — no artificial sleeps between
 * requests. The npm downloads API tolerates ~10 concurrent requests, which is
 * what we run with by default.
 *
 * Pass `range` to override the default 30-day-back-to-today window.
 */
export async function fetchDownloadsBatched(
  packageNames: string[],
  range?: { start: string; end: string },
): Promise<Map<string, DownloadData>> {
  if (packageNames.length === 0) return new Map();

  const scopedPackages = packageNames.filter(isScopedPackage);
  const nonScopedPackages = packageNames.filter(n => !isScopedPackage(n));

  const now = new Date();
  const rangeStart = range?.start ?? fmt(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
  const rangeEnd = range?.end ?? fmt(now);
  const weekAgo = fmt(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  const twoWeeksAgo = fmt(new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000));
  // "monthly" bucket uses the same lower bound as the requested range —
  // by default 30 days back. For short delta ranges this still reflects
  // only what we fetched, which is the same behavior as the legacy path.
  const monthStart = rangeStart;

  const bulkBatches: string[][] = [];
  for (let i = 0; i < nonScopedPackages.length; i += BATCH_SIZE) {
    bulkBatches.push(nonScopedPackages.slice(i, i + BATCH_SIZE));
  }

  type Task =
    | { kind: 'bulk'; names: string[] }
    | { kind: 'single'; name: string };

  const tasks: Task[] = [
    ...bulkBatches.map(names => ({ kind: 'bulk' as const, names })),
    ...scopedPackages.map(name => ({ kind: 'single' as const, name })),
  ];

  console.log(`[Sync] Fetching downloads: ${nonScopedPackages.length} non-scoped (${bulkBatches.length} bulk batches) + ${scopedPackages.length} scoped (individual) — concurrency=${DOWNLOAD_CONCURRENCY}, range=${rangeStart}:${rangeEnd}`);

  const maps = await pMap(tasks, DOWNLOAD_CONCURRENCY, async (task): Promise<Map<string, DownloadData>> => {
    if (task.kind === 'bulk') {
      return executeBulkFetch(task.names, rangeStart, rangeEnd, weekAgo, twoWeeksAgo, monthStart);
    }
    const data = await executeSingleFetch(task.name, rangeStart, rangeEnd, weekAgo, twoWeeksAgo, monthStart);
    const out = new Map<string, DownloadData>();
    if (data) out.set(task.name, data);
    return out;
  });

  const allDownloads = new Map<string, DownloadData>();
  for (const m of maps) {
    for (const [k, v] of m) allDownloads.set(k, v);
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
// Unified concurrent download sync (merged fetch + persist)
// =============================================================================

/**
 * Unified concurrent downloads fetch + persist for an incremental sync.
 *
 * Replaces what used to be two sequential phases:
 *   - 3a: fetch full 30-day range for new/updated packages, per-package
 *     DELETE + INSERT (wipe stale rows + rewrite history).
 *   - 3b: fetch delta-range downloads for unchanged packages (sliding window
 *     since last sync), per-day UPSERT (add newer days onto existing history).
 *
 * Both are now one pass: packages fan out through a single
 * `DOWNLOAD_CONCURRENCY`-wide worker pool. Bulk batches cover non-scoped
 * packages (up to `BATCH_SIZE` per request); scoped packages are fetched
 * individually because npm's bulk endpoint doesn't accept them. New/updated
 * packages run with the full 30-day range; unchanged packages run with the
 * delta range (day after last sync -> today), falling back to the full 30-day
 * range if there's no recorded last sync or the gap exceeds 25 days.
 *
 * DB writes are serialized into ONE transaction at the end: `node:sqlite`'s
 * `DatabaseSync` is synchronous on a single shared connection, so two
 * concurrent `BEGIN TRANSACTION` blocks would collide. The transaction also
 * prunes `daily_downloads` rows older than 30 days.
 *
 * Returns the count of packages whose download rows were inserted/upserted.
 */
async function fetchAndPersistIncrementalDownloads(
  newOrUpdated: NpmSearchResult[],
  unchanged: NpmSearchResult[],
  lastSync: string | null,
): Promise<number> {
  const now = new Date();
  const today = fmt(now);
  const fullRangeStart = fmt(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
  const weekAgo = fmt(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  const twoWeeksAgo = fmt(new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000));

  // Delta range for unchanged packages — fall back to full 30-day range if
  // we never synced or the gap is too large (>25 days). `runSync()` routes
  // first-time runs to `runFullSync`, so lastSync should rarely be null here,
  // but the fallback keeps us safe.
  let deltaStart: string;
  if (lastSync) {
    const lastSyncDate = new Date(lastSync);
    const daysSinceSync = (now.getTime() - lastSyncDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceSync > 25) {
      deltaStart = fullRangeStart;
      console.log(`[Sync] Gap since last sync is ${Math.round(daysSinceSync)} days — using full 30-day range for unchanged packages`);
    } else {
      deltaStart = fmt(new Date(lastSyncDate.getTime() + 24 * 60 * 60 * 1000));
    }
  } else {
    deltaStart = fullRangeStart;
    console.log('[Sync] No previous sync found — using full 30-day range for unchanged packages');
  }

  const unchangedUpToDate = deltaStart >= today;

  const newOrUpdatedNames = newOrUpdated.map(p => p.package.name);
  const unchangedNames = unchanged.map(p => p.package.name);

  const newOrUpdatedNonScoped = newOrUpdatedNames.filter(n => !isScopedPackage(n));
  const newOrUpdatedScoped = newOrUpdatedNames.filter(isScopedPackage);
  const unchangedNonScoped = unchangedNames.filter(n => !isScopedPackage(n));
  const unchangedScoped = unchangedNames.filter(isScopedPackage);

  type Task =
    | { kind: 'bulk'; names: string[]; rangeStart: string; rangeEnd: string; fullRange: true }
    | { kind: 'single'; names: [string]; rangeStart: string; rangeEnd: string; fullRange: true };

  const chunk = <T>(arr: T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  const tasks: Task[] = [
    // New + updated: full 30-day range
    ...chunk(newOrUpdatedNonScoped, BATCH_SIZE).map(names => ({
      kind: 'bulk' as const, names, rangeStart: fullRangeStart, rangeEnd: today, fullRange: true as const,
    })),
    ...newOrUpdatedScoped.map(name => ({
      kind: 'single' as const, names: [name] as [string], rangeStart: fullRangeStart, rangeEnd: today, fullRange: true as const,
    })),
    // Unchanged: delta range (skipped entirely if up-to-date)
    ...(unchangedUpToDate ? [] : chunk(unchangedNonScoped, BATCH_SIZE).map(names => ({
      kind: 'bulk' as const, names, rangeStart: deltaStart, rangeEnd: today, fullRange: true as const,
    }))),
    ...(unchangedUpToDate ? [] : unchangedScoped.map(name => ({
      kind: 'single' as const, names: [name] as [string], rangeStart: deltaStart, rangeEnd: today, fullRange: true as const,
    }))),
  ];

  const totalNewOrUpdated = newOrUpdatedNonScoped.length + newOrUpdatedScoped.length;
  const totalUnchanged = unchangedNonScoped.length + unchangedScoped.length;
  console.log(
    `[Sync] Downloads fetch: ${totalNewOrUpdated} new/updated (full 30-day range) + ` +
    `${totalUnchanged} unchanged (${unchangedUpToDate ? 'up to date, skipped' : `delta ${deltaStart}:${today}`}) ` +
    `— ${tasks.length} tasks at concurrency=${DOWNLOAD_CONCURRENCY}`,
  );

  // Fan all tasks through one shared worker pool — npm sees at most
  // DOWNLOAD_CONCURRENCY requests in flight at once, regardless of which
  // group each task belongs to.
  //
  // Each task is isolated: a thrown error (transient npm quirk, shape change,
  // network blip) returns an empty map rather than failing pMap's Promise.all,
  // which would otherwise lose ALL the work from the other concurrent tasks.
  // We log so the failure is visible without taking down the sync.
  const taskResults = await pMap(tasks, DOWNLOAD_CONCURRENCY, async (task): Promise<{ map: Map<string, DownloadData>; fullRange: boolean }> => {
    try {
      let map: Map<string, DownloadData>;
      if (task.kind === 'bulk') {
        map = await executeBulkFetch(task.names, task.rangeStart, task.rangeEnd, weekAgo, twoWeeksAgo, task.rangeStart);
      } else {
        const data = await executeSingleFetch(task.names[0], task.rangeStart, task.rangeEnd, weekAgo, twoWeeksAgo, task.rangeStart);
        map = new Map();
        if (data) map.set(task.names[0], data);
      }
      return { map, fullRange: task.fullRange };
    } catch (err) {
      const label = task.kind === 'bulk'
        ? `bulk (${task.names.length} pkgs, ${task.rangeStart}:${task.rangeEnd})`
        : `single ${task.names[0]} (${task.rangeStart}:${task.rangeEnd})`;
      console.warn(`[Sync] Downloads task failed (${label}) — skipping:`, err instanceof Error ? err.message : err);
      return { map: new Map(), fullRange: task.fullRange };
    }
  });

  // Single transaction: node:sqlite is sync on one shared connection, so we
  // can't run concurrent transactions. Waiting for all network I/O to finish
  // and then doing the writes in one BEGIN/COMMIT block is both faster
  // (one fsync) and correct.
  const db = getDb();
  const upsertStmt = db.prepare(`
    INSERT INTO daily_downloads (package_name, date, downloads)
    VALUES (?, ?, ?)
    ON CONFLICT(package_name, date) DO UPDATE SET
      downloads = excluded.downloads
  `);
  const deleteStmt = db.prepare('DELETE FROM daily_downloads WHERE package_name = ?');

  const t0 = Date.now();
  let downloadsUpdated = 0;
  db.exec('BEGIN TRANSACTION');
  try {
    for (const { map, fullRange } of taskResults) {
      for (const [pkgName, data] of map) {
        if (fullRange) {
          // New/updated path: skip dead packages (zero traffic over the
          // full 30-day range) — preserves the legacy filter and avoids
          // writing 30 zero rows for packages nobody uses. Existing rows
          // for previously-live packages are intentionally preserved.
          if (data.weekly === 0 && data.monthly === 0) continue;
          deleteStmt.run(pkgName);
        }
        for (const [date, dl] of data.daily) {
          upsertStmt.run(pkgName, date, dl);
        }
        downloadsUpdated++;
      }
    }
    // Prune anything older than the 30-day window.
    db.prepare('DELETE FROM daily_downloads WHERE date < ?').run(fullRangeStart);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[Sync] Persisted ${downloadsUpdated} package download records in ${elapsed}s`);

  return downloadsUpdated;
}

// =============================================================================
// Sync entry points
// =============================================================================


/**
 * Incremental sync — fast periodic update.
 *
 * 1. Paginates npm search to discover the full package list (lightweight,
 *    ~12 API calls — must run first since later steps need the names).
 * 2. Diffs against DB to find new/changed packages.
 * 3. Upserts only new/changed package metadata (DB transaction — fast).
 * 4. Fetches downloads concurrently in one pass:
 *      - new/updated packages get the full 30-day range (DELETE + INSERT)
 *      - unchanged packages get the delta range since last sync (UPSERT)
 *    All npm requests share a single `DOWNLOAD_CONCURRENCY`-wide worker
 *    pool. DB writes are serialized into one transaction at the end.
 * 5. Records sync timestamp.
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

  // 4. Unified concurrent downloads fetch + persist (merged former phases 3a + 3b)
  //    - new/updated: full 30-day range, per-package DELETE + INSERT
  //    - unchanged: delta range since last sync, per-day UPSERT
  //    Both fan out through one DOWNLOAD_CONCURRENCY-wide worker pool.
  const lastSync = getSyncMeta(SYNC_META_KEY);
  const downloadsUpdated = await fetchAndPersistIncrementalDownloads(
    packagesToUpsert,
    diff.unchangedPackages,
    lastSync,
  );

  // 5. Mark packages as removed if they disappeared from npm
  if (diff.removedNames.length > 0) {
    console.log(`[Sync] ${diff.removedNames.length} packages no longer found on npm (retaining in DB)`);
    // We keep them in DB — they might just be temporarily unavailable
  }

  // 6. Record sync timestamp
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
