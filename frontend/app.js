// ═══════════════════════════════════════════════════════════════════
// PI EXTENSION DASHBOARD — Using Design System
// ═══════════════════════════════════════════════════════════════════

// Import utilities from design system
import { formatNumber, timeAgo, debounce, copyToClipboard, renderLineArea } from './design-system/js/utils.js';
import { PackageCard, renderPackageList } from './design-system/components/package-card.js';
import { Pagination } from './design-system/components/pagination.js';
import { LoadingState, EmptyState, ErrorState } from './design-system/components/state-components.js';
import { openPackageDetailModal } from './design-system/components/package-detail-modal.js';
import { parseUrlState, buildUrlState, parsePackageHash, buildPackageHash } from './design-system/js/url-state.js';

// Make utilities available globally for inline handlers
window.formatNumber = formatNumber;
window.timeAgo = timeAgo;

// State
let currentSort = 'trending';
let currentPeriod = 'weekly';
let currentSearch = '';
let currentPublisher = ''; // exact resolved-publisher filter (stats → list)
let currentMinDownloads = 0; // 30-day download floor (stats p90/p99 cohort)
let currentOffset = 0; // derived: (page - 1) * limit
const limit = 30;
let totalCount = 0;

// Component instances
let pagination;
let detailModal = null;

// DOM Elements
const packagesEl = document.getElementById('packages');
const paginationEl = document.getElementById('pagination');
const totalCountEl = document.getElementById('total-count');
const syncStatusEl = document.getElementById('sync-status');
const searchInput = document.getElementById('search');
const sortFilters = document.querySelectorAll('.sort-group .filter');
const periodButtons = document.querySelectorAll('.period-group .period');
const searchContainer = document.querySelector('.search');
const statsTab = document.getElementById('stats-tab');
const statsViewEl = document.getElementById('stats-view');

// ── Route detection ───────────────────────────────────────────────────
// The two "routes" are hash-based (design D5):
//   - no hash / `#/packages`         → package list
//   - `#/stats`                       → ecosystem stats view
//   - `#/pkg/<name>`                  → package detail modal (over the list)
// The stats tab is a nav-level toggle: entering `#/stats` hides the list and
// shows the stats view; leaving restores the list.

function isStatsRoute(hash = location.hash) {
  return String(hash || '').trim() === '#/stats';
}

function applyRouteVisibility() {
  const statsRoute = isStatsRoute();
  const showList = !statsRoute;
  if (packagesEl) packagesEl.hidden = showList ? false : true;
  if (paginationEl) paginationEl.hidden = showList ? false : true;
  if (statsViewEl) statsViewEl.hidden = statsRoute ? false : true;
  if (statsTab) statsTab.classList.toggle('active', statsRoute);
}

// ── URL state sync ────────────────────────────────────────────────────
// View state lives in the query string (?sort=&period=&search=&p=); the
// package detail modal lives in the hash (#/pkg/<name>). See
// design.md (D1-D3) and specs/url-state-sync for the exact contract.

/**
 * Read the current state from module variables.
 * @returns {{sort: string, period: string, search: string, page: number}}
 */
function currentState() {
  const state = {
    sort: currentSort,
    period: currentPeriod,
    search: currentSearch,
    page: Math.floor(currentOffset / limit) + 1,
  };
  if (currentPublisher) state.publisher = currentPublisher;
  if (currentMinDownloads > 0) state.min_downloads = currentMinDownloads;
  return state;
}

/**
 * Write current state to the URL query string.
 * @param {'push'|'replace'} mode - push creates a history entry (explicit
 *   actions: sort tab, page change); replace updates silently (search typing,
 *   period toggle).
 */
function syncUrl(mode = 'replace') {
  const qs = buildUrlState(currentState());
  const url = qs ? `${location.pathname}?${qs}${location.hash}` : `${location.pathname}${location.hash}`;
  if (mode === 'push') {
    history.pushState({ view: 'list' }, '', url);
  } else {
    history.replaceState({ view: 'list' }, '', url);
  }
}

/**
 * Apply state from URL to module vars + active tab classes. Does NOT fetch.
 */
function applyStateFromUrl() {
  const state = parseUrlState(location.search);
  currentSort = state.sort;
  currentPeriod = state.period;
  currentSearch = state.search;
  currentPublisher = typeof state.publisher === 'string' ? state.publisher : '';
  currentMinDownloads = typeof state.min_downloads === 'number' && state.min_downloads > 0 ? state.min_downloads : 0;
  currentOffset = (state.page - 1) * limit;

  // Sync active tab classes
  sortFilters.forEach((f) => f.classList.toggle('active', f.dataset.sort === currentSort));
  periodButtons.forEach((b) => b.classList.toggle('active', b.dataset.period === currentPeriod));
  searchInput.value = currentSearch;
  searchContainer.dataset.hasInput = currentSearch.length > 0 ? 'true' : 'false';
}

/**
 * Open the package detail modal for a package name, syncing the hash.
 * When a modal is already open, navigate it to the new package without
 * pushing a new history entry (design D4: no modal-to-modal stack).
 *
 * @param {string} name - Package name
 * @param {'push'|'replace'} hashMode - push for explicit card opens
 */
function openDetail(name, hashMode = 'push') {
  if (detailModal) {
    // Same package already open — no-op.
    if (detailModal.packageName === name) return;
    detailModal.close();
    detailModal = null;
  }

  // Update hash (replaceState keeps the current list entry; pushState for the
  // card click creates a new entry so Back closes the modal).
  const target = `${location.pathname}${location.search}#/pkg/${encodeURIComponent(name)}`;
  if (hashMode === 'push') {
    history.pushState({ view: 'detail' }, '', target);
  } else {
    history.replaceState({ view: 'detail' }, '', target);
  }

  detailModal = openPackageDetailModal({
    name,
    onClose: () => {
      detailModal = null;
      // Clear hash without disturbing query params (replaceState).
      const url = `${location.pathname}${location.search}`;
      history.replaceState({ view: 'list' }, '', url);
    },
  });
  detailModal.packageName = name;
}

/**
 * Close the detail modal without touching the URL hash (used on popstate
 * where the URL has already changed).
 */
function closeDetail() {
  if (detailModal) {
    detailModal.close();
    detailModal = null;
  }
}

// ── Initialize ───────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  applyStateFromUrl();
  applyRouteVisibility();
  loadPackages();
  loadStats();
  setupEventListeners();
  setupSearch();
  setupSortFilters();
  setupPeriodButtons();
  setupStatsTab();

  // Deep-link: if the URL hash is #/pkg/<name>, open the modal after the
  // initial list render. Fetch + render runs async; opening the modal is
  // independent of the list, so this is safe to do here.
  const pkgName = parsePackageHash(location.hash);
  if (pkgName) {
    openDetail(pkgName, 'replace');
  }

  // Stats route: load the ecosystem view on boot (and on any later route
  // change via the stats tab).
  if (isStatsRoute()) {
    loadEcosystem();
  }
});

function setupSearch() {
  let debounceTimer;
  // Local mirror of the raw input value (~not-yet-trimmed) for URL sync.
  let lastRaw = '';

  searchInput.addEventListener('input', (e) => {
    const value = e.target.value.trim();
    const hasInput = value.length > 0;
    searchContainer.dataset.hasInput = hasInput;
    lastRaw = e.target.value;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentSearch = value;
      currentOffset = 0;
      syncUrl('replace'); // debounced — replaceState, not pushState (D2)
      searchContainer.dataset.loading = 'true';
      loadPackages().finally(() => {
        searchContainer.dataset.loading = 'false';
      });
    }, 250);
  });

  // Clear-search action from EmptyState
  const clearSearch = () => {
    searchInput.value = '';
    lastRaw = '';
    currentSearch = '';
    currentOffset = 0;
    searchContainer.dataset.hasInput = 'false';
    syncUrl('replace');
    loadPackages();
  };
  window.clearSearch = clearSearch;

  // Keyboard shortcut: / to focus search (not while a modal button is focused)
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== searchInput && document.activeElement?.tagName !== 'BUTTON') {
      e.preventDefault();
      searchInput.focus();
    }
  });
}

function setupSortFilters() {
  sortFilters.forEach(filter => {
    filter.addEventListener('click', () => {
      if (filter.dataset.sort === currentSort) return;
      sortFilters.forEach(f => f.classList.remove('active'));
      filter.classList.add('active');
      currentSort = filter.dataset.sort;
      currentOffset = 0;
      syncUrl('push'); // explicit action — push (D2)
      loadPackages();
    });
  });
}

function setupPeriodButtons() {
  periodButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.period === currentPeriod) return;
      periodButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPeriod = btn.dataset.period;
      currentOffset = 0;
      syncUrl('replace'); // transient toggle — replace (D2)
      loadPackages();
    });
  });
}

// Back/forward: re-parse the URL and re-render (no reload).
function setupEventListeners() {
  window.retryLoad = () => loadPackages();

  window.addEventListener('popstate', () => {
    applyStateFromUrl();

    const pkgName = parsePackageHash(location.hash);
    if (pkgName) {
      // Navigate the existing modal (or open it) without pushing again.
      openDetail(pkgName, 'replace');
    } else {
      closeDetail();
    }

    // Stats route toggles the list/stats views on back/forward too.
    const wasStats = isStatsRoute();
    applyRouteVisibility();
    if (wasStats) {
      loadEcosystem();
    }

    loadPackages(); // re-render list from the restored state
  });
}

// Stats tab: push a history entry for #/stats; clicking again returns to
// the list (Back also works via popstate).
function setupStatsTab() {
  if (!statsTab) return;
  statsTab.addEventListener('click', () => {
    if (isStatsRoute()) {
      // Already on stats — go back to the list.
      history.pushState({ view: 'list' }, '', location.pathname + location.search);
      applyRouteVisibility();
      loadPackages();
      return;
    }
    const url = `${location.pathname}${location.search}#/stats`;
    history.pushState({ view: 'stats' }, '', url);
    applyRouteVisibility();
    loadEcosystem();
  });
}

// Load packages from API
async function loadPackages() {
  packagesEl.innerHTML = '';
  packagesEl.appendChild(LoadingState({ message: 'Loading packages...' }));
  
  try {
    const params = new URLSearchParams({
      sort: currentSort,
      period: currentPeriod,
      limit: limit.toString(),
      offset: currentOffset.toString(),
    });
    
    if (currentSearch) {
      params.append('search', currentSearch);
    }
    if (currentPublisher) {
      params.append('publisher', currentPublisher);
    }
    if (currentMinDownloads > 0) {
      params.append('min_downloads', String(currentMinDownloads));
    }
    
    const response = await fetch(`/api/packages?${params}`);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    
    totalCount = data.pagination?.total || data.packages.length;
    // NOTE: `totalCountEl` (the badge in the topbar) is intentionally NOT
    // updated here. It shows the absolute package count, sourced from
    // /api/stats.total_packages (a live COUNT(*) in the backend). Updating
    // it with the per-filter pagination.total here would briefly flash a
    // wrong number on every sort/filter change before /api/stats overwrites
    // it — and the two values are different (e.g. trending filter excludes
    // packages with insufficient download history).
    
    if (data.packages.length === 0) {
      packagesEl.innerHTML = '';
      const hasSearch = currentSearch.length > 0;
      const suggestions = hasSearch 
        ? 'Try searching for something broader, like "tool" or "util"'
        : 'Try a different filter or check back later for new packages';
      packagesEl.appendChild(EmptyState({
        title: hasSearch ? 'No packages match your search' : 'No packages found',
        message: suggestions,
        action: hasSearch ? {
          label: 'Clear search',
          onClick: () => {
            if (typeof window.clearSearch === 'function') window.clearSearch();
            else loadPackages();
          }
        } : null
      }));
      if (pagination) {
        pagination.destroy();
      }
      paginationEl.innerHTML = '';
      return;
    }
    
    renderPackages(data.packages);
    renderPagination();
    
  } catch (err) {
    console.error('Failed to load packages:', err);
    packagesEl.innerHTML = '';
    packagesEl.appendChild(ErrorState({
      message: 'Failed to load packages',
      onRetry: () => loadPackages()
    }));
    paginationEl.innerHTML = '';
  }
}

// Render packages using design system
function renderPackages(packages) {
  packagesEl.innerHTML = '';
  packagesEl.appendChild(renderPackageList(packages, {
    onNameClick: (pkg, event) => {
      // Only the name link opens the modal; modifier-clicks (cmd/ctrl) and
      // right-clicks fall through to the default link behavior. GitHub/npm
      // links keep their real hrefs (D6).
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      openDetail(pkg.name);
    },
    onCopy: (cmd) => {
      console.log('Copied:', cmd);
    }
  }));

  // Stats-driven filters (publisher / min_downloads cohort) get a visible
  // "clear filter" chip above the list — Back also works, but a chip is the
  // explicit affordance (design D5).
  if (currentPublisher || currentMinDownloads > 0) {
    packagesEl.appendChild(buildFilterChip());
  }
}

/**
 * Build the "clear filter" chip shown above the list when a stats-driven
 * filter (publisher / min_downloads cohort) is active.
 * @returns {HTMLElement} the chip element
 */
function buildFilterChip() {
  const chip = document.createElement('div');
  chip.className = 'filter-chip';

  const label = document.createElement('span');
  label.className = 'filter-chip-label';
  const parts = [];
  if (currentPublisher) parts.push(`publisher: ${currentPublisher}`);
  if (currentMinDownloads > 0) parts.push(`≥ ${formatNumber(currentMinDownloads)} downloads/30d`);
  label.textContent = parts.join(' · ');
  chip.appendChild(label);

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'filter-chip-clear';
  clear.textContent = '× Clear filter';
  clear.setAttribute('aria-label', 'Clear active filter');
  clear.addEventListener('click', () => {
    currentPublisher = '';
    currentMinDownloads = 0;
    currentOffset = 0;
    syncUrl('replace');
    loadPackages();
  });
  chip.appendChild(clear);
  return chip;
}

/**
 * Navigate from the stats view to the package list with a filter applied.
 * Pushes a history entry (so Back returns to stats), clears the hash, and
 * reloads the list. Used by interactive stats rows/cards (design D4/D5).
 * @param {{publisher?: string, min_downloads?: number}} [filter]
 */
function navigateToList(filter = {}) {
  if (typeof filter.publisher === 'string' && filter.publisher.trim()) {
    currentPublisher = filter.publisher.trim();
  }
  if (typeof filter.min_downloads === 'number' && filter.min_downloads > 0) {
    currentMinDownloads = filter.min_downloads;
  }
  currentSort = 'popular'; // cohort/publisher views default to popularity (design)
  currentOffset = 0;

  const url = `${location.pathname}?${buildUrlState(currentState())}`;
  history.pushState({ view: 'list' }, '', url);
  applyRouteVisibility();
  loadPackages();
}

// Render pagination using design system
function renderPagination() {
  if (pagination) {
    pagination.destroy();
  }
  
  pagination = new Pagination(paginationEl, {
    total: totalCount,
    limit: limit,
    current: Math.floor(currentOffset / limit) + 1,
    onChange: (page) => {
      currentOffset = (page - 1) * limit;
      syncUrl('push'); // explicit page change — push (D2)
      loadPackages();
    }
  });
}

// Load stats — populates the "last sync" indicator in the topbar AND sets the
// absolute package count in the badge. /api/stats.total_packages is a live
// COUNT(*) in the backend, so this is correct immediately after any data
// write (no stale-cache window). The 60s setInterval refresh keeps the
// relative time and count current while the page stays open.
async function loadStats() {
  try {
    const response = await fetch('/api/stats');
    const stats = await response.json();
    
    totalCountEl.textContent = formatNumber(stats.total_packages);
    updateSyncStatus(stats);
  } catch (err) {
    console.error('Failed to load stats:', err);
    totalCountEl.textContent = '—';
    if (syncStatusEl) {
      syncStatusEl.textContent = 'sync unavailable';
      syncStatusEl.dataset.state = 'never';
    }
  }
}

/**
 * Render the "Synced Xh ago" / "Syncing…" / "Never synced" indicator.
 * Reads three fields from /api/stats:
 *   - sync_running: bool — show a pulsing dot + "syncing…"
 *   - last_sync: ISO string — show relative time since last successful sync
 *   - both null — "never synced"
 */
function updateSyncStatus(stats) {
  if (!syncStatusEl) return;

  if (stats.sync_running) {
    syncStatusEl.textContent = 'syncing…';
    syncStatusEl.dataset.state = 'syncing';
    syncStatusEl.title = 'Sync in progress';
    return;
  }

  if (!stats.last_sync) {
    syncStatusEl.textContent = 'never synced';
    syncStatusEl.dataset.state = 'never';
    syncStatusEl.title = 'No sync has run yet';
    return;
  }

  const synced = timeAgo(stats.last_sync);
  syncStatusEl.textContent = `synced ${synced}`;
  syncStatusEl.dataset.state = 'synced';
  syncStatusEl.title = `Last sync: ${new Date(stats.last_sync).toLocaleString()}` +
    (stats.last_sync_mode ? ` (${stats.last_sync_mode})` : '');
}

// Refresh the sync indicator every 60s so "2m ago" doesn't go stale while the
// page is open. /api/stats is cached server-side for 60s, so this is cheap.
setInterval(loadStats, 60_000);

// ── Ecosystem Stats view ──────────────────────────────────────────────
// Renders /api/ecosystem: 60-day trend area chart, top publishers (by
// package count and by 30-day downloads), top packages, and distribution
// cards. Reuses the design-system state components for loading/empty/error.

async function loadEcosystem() {
  if (!statsViewEl) return;
  statsViewEl.innerHTML = '';
  statsViewEl.appendChild(LoadingState({ message: 'Loading ecosystem stats...' }));

  try {
    const response = await fetch('/api/ecosystem');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    renderEcosystem(data);
  } catch (err) {
    console.error('Failed to load ecosystem stats:', err);
    statsViewEl.innerHTML = '';
    statsViewEl.appendChild(ErrorState({
      title: 'Failed to load ecosystem stats',
      message: 'Could not reach the stats API. Check your connection and try again.',
      onRetry: () => loadEcosystem(),
    }));
  }
}

function renderEcosystem(data) {
  if (!statsViewEl) return;
  statsViewEl.innerHTML = '';

  const { downloads_series } = data;
  const isEmpty = !downloads_series || downloads_series.length === 0;

  if (isEmpty) {
    statsViewEl.appendChild(EmptyState({
      title: 'No ecosystem data yet',
      message: 'Once syncs run, the ecosystem trend, publishers, and distribution will appear here.',
    }));
    return;
  }

  // --- Trend chart ---
  const chartSection = document.createElement('section');
  chartSection.className = 'stats-section';
  const chartTitle = document.createElement('h2');
  chartTitle.className = 'stats-section-title';
  chartTitle.textContent = 'Ecosystem downloads — last 60 days';
  const chartWrap = document.createElement('div');
  chartWrap.className = 'stats-chart';
  renderLineArea(chartWrap, downloads_series, { height: 180, labelEvery: 10 });
  chartSection.appendChild(chartTitle);
  chartSection.appendChild(chartWrap);
  statsViewEl.appendChild(chartSection);

  // --- Distribution cards ---
  const dist = data.distribution || {};
  const distSection = document.createElement('section');
  distSection.className = 'stats-section';
  const distTitle = document.createElement('h2');
  distTitle.className = 'stats-section-title';
  distTitle.textContent = 'Ecosystem snapshot';
  distSection.appendChild(distTitle);

  const distGrid = document.createElement('div');
  distGrid.className = 'stats-grid';
  distGrid.appendChild(statCard('Total packages', formatNumber(data.total_packages)));
  // Active 30d → cohort "has any downloads in 30d" (min_downloads=1).
  distGrid.appendChild(makeClickableStatCard(
    'Active packages (30d)',
    formatNumber(data.active_packages_30d),
    data.active_packages_30d > 0 ? () => navigateToList({ min_downloads: 1 }) : null,
  ));
  distGrid.appendChild(statCard('Median downloads (30d)', dist.p50 == null ? '—' : formatNumber(dist.p50)));
  // p90/p99 are cohort floors — clicking shows the packages at/above them.
  distGrid.appendChild(makeClickableStatCard(
    'p90 downloads (30d)',
    dist.p90 == null ? '—' : formatNumber(dist.p90),
    dist.p90 == null ? null : () => navigateToList({ min_downloads: dist.p90 }),
  ));
  distGrid.appendChild(makeClickableStatCard(
    'p99 downloads (30d)',
    dist.p99 == null ? '—' : formatNumber(dist.p99),
    dist.p99 == null ? null : () => navigateToList({ min_downloads: dist.p99 }),
  ));
  distGrid.appendChild(statCard('Median growth', dist.median_growth == null ? '—' : `${dist.median_growth > 0 ? '+' : ''}${dist.median_growth}%`));
  distSection.appendChild(distGrid);
  statsViewEl.appendChild(distSection);

  // --- Top publishers (both rankings, side by side) ---
  const pubsSection = document.createElement('section');
  pubsSection.className = 'stats-section';
  const pubsTitle = document.createElement('h2');
  pubsTitle.className = 'stats-section-title';
  pubsTitle.textContent = 'Top publishers';
  pubsSection.appendChild(pubsTitle);

  const pubsGrid = document.createElement('div');
  pubsGrid.className = 'stats-grid stats-grid-2col';
  const publisherClick = (publisher) => navigateToList({ publisher });
  pubsGrid.appendChild(publisherTable('By package count', data.top_publishers?.by_packages || [], publisherClick));
  pubsGrid.appendChild(publisherTable('By 30-day downloads', data.top_publishers?.by_downloads || [], publisherClick));
  pubsSection.appendChild(pubsGrid);
  statsViewEl.appendChild(pubsSection);

  // --- Top packages ---
  const topSection = document.createElement('section');
  topSection.className = 'stats-section';
  const topTitle = document.createElement('h2');
  topTitle.className = 'stats-section-title';
  topTitle.textContent = 'Top packages — 30-day downloads';
  topSection.appendChild(topTitle);

  const topList = document.createElement('ol');
  topList.className = 'top-list';
  (data.top_packages || []).forEach((pkg) => {
    const li = document.createElement('li');
    li.className = 'top-list-item';
    if (pkg.name) {
      // Interactive: clicking opens the package detail modal (same as list).
      li.classList.add('clickable');
      li.setAttribute('role', 'link');
      li.setAttribute('tabindex', '0');
      li.setAttribute('aria-label', `Open package ${pkg.name}`);
      li.addEventListener('click', () => openDetail(pkg.name));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDetail(pkg.name);
        }
      });
    }
    const name = document.createElement('span');
    name.className = 'top-list-name';
    name.textContent = pkg.name; // textContent — safe
    const dl = document.createElement('span');
    dl.className = 'top-list-downloads';
    dl.textContent = formatNumber(pkg.downloads);
    const growth = document.createElement('span');
    growth.className = 'top-list-growth' + (pkg.growth != null && pkg.growth > 0 ? ' positive' : pkg.growth != null && pkg.growth < 0 ? ' negative' : '');
    growth.textContent = pkg.growth == null ? '—' : `${pkg.growth > 0 ? '+' : ''}${pkg.growth}%`;
    li.appendChild(name);
    li.appendChild(dl);
    li.appendChild(growth);
    topList.appendChild(li);
  });
  topSection.appendChild(topList);
  statsViewEl.appendChild(topSection);
}

function statCard(label, value) {
  const card = document.createElement('div');
  card.className = 'stat-card';
  const val = document.createElement('div');
  val.className = 'stat-card-value';
  val.textContent = value;
  const lbl = document.createElement('div');
  lbl.className = 'stat-card-label';
  lbl.textContent = label;
  card.appendChild(val);
  card.appendChild(lbl);
  return card;
}

/**
 * A stat card that is a clickable cohort filter when `onClick` is provided;
 * otherwise identical to statCard() (inert — e.g. null p90/p99 values).
 * @param {string} label
 * @param {string} value
 * @param {(() => void)|null} onClick
 * @returns {HTMLElement}
 */
function makeClickableStatCard(label, value, onClick) {
  const card = statCard(label, value);
  if (!onClick) return card;
  card.classList.add('clickable');
  card.setAttribute('role', 'link');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', `${label}: ${value} — show matching packages`);
  card.addEventListener('click', onClick);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  });
  return card;
}

function publisherTable(title, entries, onClick) {
  const wrap = document.createElement('div');
  wrap.className = 'publisher-table';
  const h = document.createElement('h3');
  h.className = 'publisher-table-title';
  h.textContent = title;
  wrap.appendChild(h);

  if (!entries.length) {
    const p = document.createElement('p');
    p.className = 'publisher-empty';
    p.textContent = 'No publisher data';
    wrap.appendChild(p);
    return wrap;
  }

  const list = document.createElement('ol');
  list.className = 'publisher-list';
  entries.forEach((entry) => {
    const li = document.createElement('li');
    li.className = 'publisher-list-item';
    if (entry.publisher && onClick) {
      // Interactive: clicking navigates to the publisher-filtered list.
      li.classList.add('clickable');
      li.setAttribute('role', 'link');
      li.setAttribute('tabindex', '0');
      li.setAttribute('aria-label', `Show packages by publisher ${entry.publisher}`);
      li.addEventListener('click', () => onClick(entry.publisher));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(entry.publisher);
        }
      });
    }
    const name = document.createElement('span');
    name.className = 'publisher-list-name';
    name.textContent = entry.publisher; // textContent — safe
    const pkgs = document.createElement('span');
    pkgs.className = 'publisher-list-packages';
    pkgs.textContent = `${entry.packages} pkg${entry.packages === 1 ? '' : 's'}`;
    const dl = document.createElement('span');
    dl.className = 'publisher-list-downloads';
    dl.textContent = formatNumber(entry.downloads);
    li.appendChild(name);
    li.appendChild(pkgs);
    li.appendChild(dl);
    list.appendChild(li);
  });
  wrap.appendChild(list);
  return wrap;
}
