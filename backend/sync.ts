import { getDb } from './db';

const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';
const NPM_DOWNLOADS_URL = 'https://api.npmjs.org/downloads';
const RATE_LIMIT_DELAY = 200; // 200ms between requests
const BATCH_SIZE = 50; // Packages per bulk download request

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
 * Fetch downloads for a single package (used for scoped packages which don't support bulk)
 */
async function fetchSinglePackageDownloads(
  packageName: string
): Promise<{ weekly: number; monthly: number; lastWeek: number } | null> {
  const now = new Date();
  const lastWeekStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const lastWeekEnd = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().split('T')[0];

  let weekly = 0, monthly = 0, lastWeek = 0;

  const weeklyRes = await fetch(`${NPM_DOWNLOADS_URL}/point/last-week/${packageName}`);
  if (weeklyRes.ok) {
    const data = await weeklyRes.json() as NpmPointDownloadsResponse;
    const entry = data[packageName];
    if (entry) weekly = entry.downloads;
  }

  await sleep(RATE_LIMIT_DELAY);
  const monthlyRes = await fetch(`${NPM_DOWNLOADS_URL}/point/last-month/${packageName}`);
  if (monthlyRes.ok) {
    const data = await monthlyRes.json() as NpmPointDownloadsResponse;
    const entry = data[packageName];
    if (entry) monthly = entry.downloads;
  }

  await sleep(RATE_LIMIT_DELAY);
  const lastWeekRange = `${fmt(lastWeekStart)}:${fmt(lastWeekEnd)}`;
  const lastWeekRes = await fetch(`${NPM_DOWNLOADS_URL}/point/${lastWeekRange}/${packageName}`);
  if (lastWeekRes.ok) {
    const data = await lastWeekRes.json() as NpmPointDownloadsResponse;
    const entry = data[packageName];
    if (entry) lastWeek = entry.downloads;
  }

  if (weekly === 0 && monthly === 0 && lastWeek === 0) return null;
  return { weekly, monthly, lastWeek };
}

/**
 * Fetch download counts in batches using point endpoint (bulk supported!)
 * Scoped packages (@scope/pkg) cannot use bulk lookups and are fetched individually.
 */
export async function fetchDownloadsBatched(
  packageNames: string[]
): Promise<Map<string, { weekly: number; monthly: number; lastWeek: number }>> {
  const allDownloads = new Map<string, { weekly: number; monthly: number; lastWeek: number }>();
  
  // Separate scoped and non-scoped packages
  const scopedPackages = packageNames.filter(isScopedPackage);
  const nonScopedPackages = packageNames.filter(n => !isScopedPackage(n));
  
  // Fetch non-scoped packages in bulk batches
  const batches: string[][] = [];
  for (let i = 0; i < nonScopedPackages.length; i += BATCH_SIZE) {
    batches.push(nonScopedPackages.slice(i, i + BATCH_SIZE));
  }
  
  console.log(`[Sync] Fetching downloads: ${nonScopedPackages.length} non-scoped (${batches.length} batches) + ${scopedPackages.length} scoped (individual)`);
  
  const now = new Date();
  const lastWeekStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const lastWeekEnd = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().split('T')[0];
  const lastWeekRange = `${fmt(lastWeekStart)}:${fmt(lastWeekEnd)}`;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const packageList = batch.join(',');
    
    // Get weekly downloads (this week)
    const weeklyUrl = `${NPM_DOWNLOADS_URL}/point/last-week/${packageList}`;
    const weeklyResponse = await fetch(weeklyUrl);
    
    if (weeklyResponse.ok) {
      const weeklyData = await weeklyResponse.json() as NpmPointDownloadsResponse;
      for (const [pkgName, data] of Object.entries(weeklyData)) {
        if (!data) continue;
        allDownloads.set(pkgName, { weekly: data.downloads, monthly: 0, lastWeek: 0 });
      }
    }
    
    // Get monthly downloads
    await sleep(RATE_LIMIT_DELAY);
    const monthlyUrl = `${NPM_DOWNLOADS_URL}/point/last-month/${packageList}`;
    const monthlyResponse = await fetch(monthlyUrl);
    
    if (monthlyResponse.ok) {
      const monthlyData = await monthlyResponse.json() as NpmPointDownloadsResponse;
      for (const [pkgName, data] of Object.entries(monthlyData)) {
        if (!data) continue;
        const existing = allDownloads.get(pkgName);
        if (existing) {
          existing.monthly = data.downloads;
        }
      }
    }
    
    // Get week-before-last for growth calculation
    await sleep(RATE_LIMIT_DELAY);
    const lastWeekUrl = `${NPM_DOWNLOADS_URL}/point/${lastWeekRange}/${packageList}`;
    const lastWeekResponse = await fetch(lastWeekUrl);
    
    if (lastWeekResponse.ok) {
      const lastWeekData = await lastWeekResponse.json() as NpmPointDownloadsResponse;
      for (const [pkgName, data] of Object.entries(lastWeekData)) {
        if (!data) continue;
        const existing = allDownloads.get(pkgName);
        if (existing) {
          existing.lastWeek = data.downloads;
        }
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
      const result = await fetchSinglePackageDownloads(scopedPackages[i]);
      if (result) {
        allDownloads.set(scopedPackages[i], result);
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
    $first_seen: pkg.package.date || now,  // Use version date for first_seen
    $last_publish: pkg.updated || null,    // Use updated field for last_publish
  });
}

/**
 * Persist download counts to SQLite
 * We store weekly and monthly totals as separate date entries for API queries
 */
export function upsertDownloads(packageName: string, weekly: number, monthly: number, lastWeek: number): void {
  const db = getDb();
  
  // Get dates for storage
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  
  const formatDate = (d: Date) => d.toISOString().split('T')[0];
  
  const stmt = db.prepare(`
    INSERT INTO daily_downloads (package_name, date, downloads)
    VALUES ($package_name, $date, $downloads)
    ON CONFLICT(package_name, date) DO UPDATE SET
      downloads = excluded.downloads
  `);

  const transaction = db.transaction(() => {
    // Store daily breakdowns for the past week (for sparklines)
    for (let i = 0; i < 7; i++) {
      const date = new Date(weekAgo.getTime() + i * 24 * 60 * 60 * 1000);
      // Distribute weekly total across days (approximation)
      const dailyEstimate = Math.round(weekly / 7);
      stmt.run({ $package_name: packageName, $date: formatDate(date), $downloads: dailyEstimate });
    }
    
    // Also store special markers for weekly/last-week/monthly totals
    stmt.run({ $package_name: packageName, $date: 'weekly_total', $downloads: weekly });
    stmt.run({ $package_name: packageName, $date: 'last_week_total', $downloads: lastWeek });
    stmt.run({ $package_name: packageName, $date: 'monthly_total', $downloads: monthly });
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
        upsertDownloads(pkg.package.name, downloads.weekly, downloads.monthly, downloads.lastWeek);
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