import { getDb } from './db';

const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';
const NPM_DOWNLOADS_URL = 'https://api.npmjs.org/downloads';
const RATE_LIMIT_DELAY = 200; // 200ms between requests
const BATCH_SIZE = 128; // Packages per bulk download request (npm limit for /range)

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

interface NpmPointDownloadsResponse {
  [packageName: string]: {
    downloads: number;
    package: string;
    start: string;
    end: string;
  } | null;
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fmt(d: Date): string {
  return d.toISOString().split('T')[0];
}

/**
 * Fetch all packages tagged with 'pi-package' from npm registry
 */
export async function fetchPiPackages(): Promise<NpmSearchResult[]> {
  const allPackages: NpmSearchResult[] = [];
  let from = 0;
  const size = 250; // npm max per page
  let total = Infinity;

  console.log('[Sync] Starting npm registry search for pi-package tagged packages...');

  while (from < total) {
    const url = `${NPM_SEARCH_URL}?text=keywords:pi-package&size=${size}&from=${from}`;
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`npm search failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as NpmSearchResponse;
    total = data.total;
    allPackages.push(...data.objects);
    
    console.log(`[Sync] Fetched ${allPackages.length}/${total} packages...`);
    
    from += size;
    
    // Rate limiting between pagination requests
    if (from < total) {
      await sleep(RATE_LIMIT_DELAY);
    }
  }

  console.log(`[Sync] Found ${allPackages.length} total packages`);
  return allPackages;
}

function isScopedPackage(name: string): boolean {
  return name.startsWith('@');
}

/**
 * Fetch daily download data for a single package via /range endpoint.
 * Returns map of date -> downloads for the last 30 days.
 */
async function fetchDailyDownloadsSingle(packageName: string): Promise<Map<string, number>> {
  const now = new Date();
  const start = fmt(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
  const end = fmt(now);

  const dailyMap = new Map<string, number>();

  // Fetch daily range for sparklines + weekly/monthly aggregation
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

interface DownloadData {
  daily: Map<string, number>;  // date -> downloads (last 30 days)
  weekly: number;
  monthly: number;
  lastWeek: number;
}

/**
 * Fetch download counts in batches.
 * Uses /range endpoint for real daily data (sparklines + aggregation).
 * Scoped packages are fetched individually (no bulk support).
 */
export async function fetchDownloadsBatched(
  packageNames: string[]
): Promise<Map<string, DownloadData>> {
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
    const rangeResponse = await fetch(rangeUrl);
    
    if (rangeResponse.ok) {
      const rangeData = await rangeResponse.json() as { [key: string]: NpmRangeDownloadsResponse | null };
      for (const [pkgName, pkgData] of Object.entries(rangeData)) {
        if (!pkgData) continue;
        const daily = new Map<string, number>();
        for (const day of pkgData.downloads) {
          daily.set(day.day, day.downloads);
        }
        
        // Aggregate weekly/monthly from daily data
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
    VALUES ($name, $description, $version, $keywords, $publisher, $github_url, $npm_url, $first_seen, $last_publish)
    ON CONFLICT(name) DO UPDATE SET
      description = excluded.description,
      version = excluded.version,
      keywords = excluded.keywords,
      publisher = excluded.publisher,
      github_url = excluded.github_url,
      last_publish = excluded.last_publish
  `);

  stmt.run({
    $name: pkg.package.name,
    $description: pkg.package.description || null,
    $version: pkg.package.version,
    $keywords: pkg.package.keywords ? JSON.stringify(pkg.package.keywords) : null,
    $publisher: pkg.package.publisher?.username || null,
    $github_url: githubUrl,
    $npm_url: pkg.package.links?.npm || `https://www.npmjs.com/package/${pkg.package.name}`,
    $first_seen: pkg.package.date || now,
    $last_publish: pkg.updated || null,
  });
}

/**
 * Persist daily download data to SQLite.
 * Stores actual per-day counts from the npm /range endpoint.
 */
export function upsertDownloads(packageName: string, data: DownloadData): void {
  const db = getDb();
  
  const stmt = db.prepare(`
    INSERT INTO daily_downloads (package_name, date, downloads)
    VALUES ($package_name, $date, $downloads)
    ON CONFLICT(package_name, date) DO UPDATE SET
      downloads = excluded.downloads
  `);

  const transaction = db.transaction(() => {
    // Delete old data for this package to avoid stale rows
    db.prepare('DELETE FROM daily_downloads WHERE package_name = $name').run({ $name: packageName });
    
    // Store actual daily downloads
    for (const [date, downloads] of data.daily) {
      stmt.run({ $package_name: packageName, $date: date, $downloads: downloads });
    }
  });

  transaction();
}

/**
 * Main sync function - fetch all data from npm
 */
export async function runSync(): Promise<{ packages: number; downloadsUpdated: number }> {
  console.log('[Sync] Starting full sync at', new Date().toISOString());
  
  // Fetch packages
  const packages = await fetchPiPackages();
  console.log(`[Sync] Saving ${packages.length} packages to database...`);
  
  // Save all package metadata
  const db = getDb();
  const transaction = db.transaction(() => {
    for (const pkg of packages) {
      upsertPackage(pkg);
    }
  });
  transaction();
  
  // Fetch download data in batches
  const packageNames = packages.map(p => p.package.name);
  const allDownloads = await fetchDownloadsBatched(packageNames);
  
  // Save downloads for each package
  let downloadsUpdated = 0;
  const downloadTransaction = db.transaction(() => {
    for (const pkg of packages) {
      const downloads = allDownloads.get(pkg.package.name);
      if (downloads && (downloads.weekly > 0 || downloads.monthly > 0)) {
        upsertDownloads(pkg.package.name, downloads);
        downloadsUpdated++;
      }
    }
  });
  downloadTransaction();

  console.log(`[Sync] Complete! ${packages.length} packages, ${downloadsUpdated} download histories updated`);
  
  return { packages: packages.length, downloadsUpdated };
}

// CLI entry point
if (import.meta.main) {
  runSync()
    .then(result => {
      console.log('[Sync] Sync completed successfully:', result);
      process.exit(0);
    })
    .catch(err => {
      console.error('[Sync] Sync failed:', err);
      process.exit(1);
    });
}