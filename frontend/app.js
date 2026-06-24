// ═══════════════════════════════════════════════════════════════════
// PI EXTENSION DASHBOARD — Using Design System
// ═══════════════════════════════════════════════════════════════════

// Import utilities from design system
import { formatNumber, timeAgo, debounce, copyToClipboard } from './design-system/js/utils.js';
import { PackageCard, renderPackageList } from './design-system/components/package-card.js';
import { Pagination } from './design-system/components/pagination.js';
import { LoadingState, EmptyState, ErrorState } from './design-system/components/state-components.js';

// Make utilities available globally for inline handlers
window.formatNumber = formatNumber;
window.timeAgo = timeAgo;

// State
let currentSort = 'trending';
let currentPeriod = 'weekly';
let currentSearch = '';
let currentOffset = 0;
const limit = 30;
let totalCount = 0;

// Components
let pagination;

// DOM Elements
const packagesEl = document.getElementById('packages');
const paginationEl = document.getElementById('pagination');
const totalCountEl = document.getElementById('total-count');
const searchInput = document.getElementById('search');
const sortFilters = document.querySelectorAll('.sort-group .filter');
const periodButtons = document.querySelectorAll('.period-group .period');
const searchContainer = document.querySelector('.search');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadPackages();
  loadStats();
  setupEventListeners();
  setupSearch();
  setupSortFilters();
  setupPeriodButtons();
});

function setupSearch() {
  let debounceTimer;
  searchInput.addEventListener('input', (e) => {
    const value = e.target.value.trim();
    const hasInput = value.length > 0;
    searchContainer.dataset.hasInput = hasInput;
    
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentSearch = value;
      currentOffset = 0;
      searchContainer.dataset.loading = 'true';
      loadPackages().finally(() => {
        searchContainer.dataset.loading = 'false';
      });
    }, 250);
  });
  
  // Keyboard shortcut: / to focus search
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== searchInput) {
      e.preventDefault();
      searchInput.focus();
    }
  });
}

function setupSortFilters() {
  sortFilters.forEach(filter => {
    filter.addEventListener('click', () => {
      sortFilters.forEach(f => f.classList.remove('active'));
      filter.classList.add('active');
      currentSort = filter.dataset.sort;
      currentOffset = 0;
      loadPackages();
    });
  });
}

function setupPeriodButtons() {
  periodButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      periodButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPeriod = btn.dataset.period;
      currentOffset = 0;
      loadPackages();
    });
  });
}

function setupEventListeners() {
  window.retryLoad = () => loadPackages();
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
    totalCountEl.textContent = formatNumber(totalCount);
    
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
            searchInput.value = '';
            currentSearch = '';
            currentOffset = 0;
            searchContainer.dataset.hasInput = 'false';
            loadPackages();
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
      loadPackages();
    }
  });
}

// Load stats
async function loadStats() {
  try {
    const response = await fetch('/api/stats');
    const stats = await response.json();
    
    totalCountEl.textContent = formatNumber(stats.total_packages);
  } catch (err) {
    console.error('Failed to load stats:', err);
    totalCountEl.textContent = '—';
  }
}
