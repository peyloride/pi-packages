// State
let currentSort = 'trending';
let currentSearch = '';
let currentOffset = 0;
const limit = 50;
let totalCount = 0;

// DOM Elements
const packagesEl = document.getElementById('packages');
const paginationEl = document.getElementById('pagination');
const statsEl = document.getElementById('stats');
const searchInput = document.getElementById('search');
const tabs = document.querySelectorAll('.tab');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadPackages();
  loadStats();
  
  // Tab clicks
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentSort = tab.dataset.sort;
      currentOffset = 0;
      loadPackages();
    });
  });
  
  // Search with debounce
  let debounceTimer;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentSearch = e.target.value.trim();
      currentOffset = 0;
      loadPackages();
    }, 300);
  });
});

// Format number with commas
function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toLocaleString();
}

// Format relative time
function timeAgo(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return '1 day ago';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  return `${Math.floor(diffDays / 365)} years ago`;
}

// Generate sparkline SVG
function generateSparkline(data) {
  if (!data || data.length === 0) return '';
  
  const width = 60;
  const height = 20;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  
  const points = data.map((val, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((val - min) / range) * height;
    return `${x},${y}`;
  }).join(' ');
  
  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}">
    <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5"/>
  </svg>`;
}

// Load packages from API
async function loadPackages() {
  packagesEl.innerHTML = '<div class="loading">Loading packages...</div>';
  
  try {
    const params = new URLSearchParams({
      sort: currentSort,
      limit: limit.toString(),
      offset: currentOffset.toString(),
    });
    
    if (currentSearch) {
      params.append('search', currentSearch);
    }
    
    const response = await fetch(`/api/packages?${params}`);
    const data = await response.json();
    
    totalCount = data.pagination.total;
    
    if (data.packages.length === 0) {
      packagesEl.innerHTML = '<div class="empty">No packages found</div>';
      paginationEl.innerHTML = '';
      return;
    }
    
    packagesEl.innerHTML = data.packages.map(pkg => renderPackage(pkg)).join('');
    renderPagination();
    
  } catch (err) {
    packagesEl.innerHTML = `
      <div class="error">
        Failed to load packages
        <button class="retry-btn" onclick="loadPackages()">Retry</button>
      </div>
    `;
  }
}

// Render a single package
function renderPackage(pkg) {
  const growthClass = pkg.growth > 0 ? 'positive' : pkg.growth < 0 ? 'negative' : '';
  const growthIcon = pkg.growth > 0 ? '↑' : pkg.growth < 0 ? '↓' : '';
  const growthText = pkg.growth !== null ? `${growthIcon} ${Math.abs(pkg.growth).toFixed(1)}%` : 'N/A';
  
  let badge = '';
  if (currentSort === 'new' && pkg.first_seen) {
    badge = `<span class="badge new">Added ${timeAgo(pkg.first_seen)}</span>`;
  } else if (currentSort === 'updated') {
    badge = `<span class="badge updated">Updated ${timeAgo(pkg.last_publish)}</span>`;
  }
  
  const keywordsHtml = pkg.keywords && pkg.keywords.length > 0
    ? `<div class="keywords">${pkg.keywords.slice(0, 5).map(k => `<span class="keyword">${k}</span>`).join('')}</div>`
    : '';
  
  const sparkline = generateSparkline(pkg.sparkline || [0, 0, 0, 0, 0, 0, 0]);
  
  // Format dates
  const firstReleased = pkg.first_seen ? new Date(pkg.first_seen).toLocaleDateString() : 'N/A';
  const lastUpdated = pkg.last_publish ? new Date(pkg.last_publish).toLocaleDateString() : 'N/A';
  
  return `
    <article class="package">
      <div class="package-header">
        <div>
          <a href="${pkg.npm_url}" target="_blank" rel="noopener" class="package-name">${pkg.name}</a>
          ${badge}
        </div>
        <div class="package-stats">
          ${sparkline}
          <span class="stat-item growth ${growthClass}">${growthText}</span>
          <span class="stat-item weekly">⬇️ ${formatNumber(pkg.weekly_downloads)}/week</span>
        </div>
      </div>
      <p class="package-description">${pkg.description || 'No description available'}</p>
      <div class="package-meta">
        ${pkg.version ? `<span>v${pkg.version}</span>` : ''}
        ${pkg.publisher ? `<span>by ${pkg.publisher}</span>` : ''}
        <span class="stat-item">📅 First: ${firstReleased}</span>
        <span class="stat-item">🔄 Updated: ${lastUpdated}</span>
        <span class="stat-item">📊 ${formatNumber(pkg.total_downloads || 0)} total</span>
      </div>
      <div class="package-links">
        ${pkg.github_url ? `<a href="${pkg.github_url}" target="_blank" rel="noopener">GitHub</a>` : ''}
        <a href="${pkg.npm_url}" target="_blank" rel="noopener">npm</a>
        ${keywordsHtml}
      </div>
    </article>
  `;
}

// Render pagination controls
function renderPagination() {
  const totalPages = Math.ceil(totalCount / limit);
  const currentPage = Math.floor(currentOffset / limit) + 1;
  
  if (totalPages <= 1) {
    paginationEl.innerHTML = '';
    return;
  }
  
  let buttons = '';
  
  // Previous button
  buttons += `<button ${currentOffset === 0 ? 'disabled' : ''} onclick="goToPage(${currentPage - 1})">← Previous</button>`;
  
  // Page numbers (show current ± 2)
  const startPage = Math.max(1, currentPage - 2);
  const endPage = Math.min(totalPages, currentPage + 2);
  
  if (startPage > 1) {
    buttons += `<button onclick="goToPage(1)">1</button>`;
    if (startPage > 2) buttons += `<span>...</span>`;
  }
  
  for (let i = startPage; i <= endPage; i++) {
    buttons += `<button ${i === currentPage ? 'style="background: var(--primary); border-color: var(--primary);"' : ''} onclick="goToPage(${i})">${i}</button>`;
  }
  
  if (endPage < totalPages) {
    if (endPage < totalPages - 1) buttons += `<span>...</span>`;
    buttons += `<button onclick="goToPage(${totalPages})">${totalPages}</button>`;
  }
  
  // Next button
  buttons += `<button ${currentOffset + limit >= totalCount ? 'disabled' : ''} onclick="goToPage(${currentPage + 1})">Next →</button>`;
  
  paginationEl.innerHTML = buttons;
}

// Navigate to page
function goToPage(page) {
  currentOffset = (page - 1) * limit;
  loadPackages();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Load stats
async function loadStats() {
  try {
    const response = await fetch('/api/stats');
    const stats = await response.json();
    
    statsEl.innerHTML = `
      <div class="stat">
        <div class="stat-value">${formatNumber(stats.total_packages)}</div>
        <div class="stat-label">Packages</div>
      </div>
      <div class="stat">
        <div class="stat-value">${formatNumber(stats.total_weekly_downloads)}</div>
        <div class="stat-label">Weekly Downloads</div>
      </div>
      <div class="stat">
        <div class="stat-value">${stats.average_growth > 0 ? '+' : ''}${stats.average_growth.toFixed(1)}%</div>
        <div class="stat-label">Avg Growth</div>
      </div>
    `;
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// Make goToPage available globally
window.goToPage = goToPage;
