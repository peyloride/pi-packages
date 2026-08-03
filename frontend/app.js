// ═══════════════════════════════════════════════════════════════════
// PI EXTENSION DASHBOARD — Using Design System
// ═══════════════════════════════════════════════════════════════════

// Import utilities from design system
import { formatNumber, timeAgo, debounce, copyToClipboard } from './design-system/js/utils.js';
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

// ── URL state sync ────────────────────────────────────────────────────
// View state lives in the query string (?sort=&period=&search=&p=); the
// package detail modal lives in the hash (#/pkg/<name>). See
// design.md (D1-D3) and specs/url-state-sync for the exact contract.

/**
 * Read the current state from module variables.
 * @returns {{sort: string, period: string, search: string, page: number}}
 */
function currentState() {
  return {
    sort: currentSort,
    period: currentPeriod,
    search: currentSearch,
    page: Math.floor(currentOffset / limit) + 1,
  };
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
  loadPackages();
  loadStats();
  setupEventListeners();
  setupSearch();
  setupSortFilters();
  setupPeriodButtons();

  // Deep-link: if the URL hash is #/pkg/<name>, open the modal after the
  // initial list render. Fetch + render runs async; opening the modal is
  // independent of the list, so this is safe to do here.
  const pkgName = parsePackageHash(location.hash);
  if (pkgName) {
    openDetail(pkgName, 'replace');
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

    loadPackages(); // re-render list from the restored state
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
