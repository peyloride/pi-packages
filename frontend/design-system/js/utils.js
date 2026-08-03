/**
 * PI DESIGN SYSTEM — Utilities
 * 
 * Shared utility functions for pi extension dashboards and apps.
 * 
 * Usage:
 *   import { formatNumber, timeAgo, debounce } from './design-system/js/utils.js';
 * 
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Format a number with compact notation (1.2K, 3.5M)
 * @param {number|null|undefined} num - The number to format
 * @returns {string} Formatted number or '—' if null/undefined
 */
export function formatNumber(num) {
  if (num === null || num === undefined) return '—';
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toLocaleString();
}

/**
 * Format a date as relative time (e.g., "2h ago", "3d ago")
 * @param {string|Date} dateString - The date to format
 * @returns {string} Relative time string
 */
export function timeAgo(dateString) {
  if (!dateString) return '';
  
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

/**
 * Create a debounced version of a function
 * @param {Function} fn - The function to debounce
 * @param {number} delay - Delay in milliseconds
 * @returns {Function} Debounced function
 */
export function debounce(fn, delay = 250) {
  let timeoutId;
  return function (...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Create a throttled version of a function
 * @param {Function} fn - The function to throttle
 * @param {number} limit - Limit in milliseconds
 * @returns {Function} Throttled function
 */
export function throttle(fn, limit = 100) {
  let inThrottle;
  return function (...args) {
    if (!inThrottle) {
      fn.apply(this, args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * Generate a unique ID
 * @param {string} [prefix='id'] - Prefix for the ID
 * @returns {string} Unique ID
 */
export function generateId(prefix = 'id') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Parse query string into an object
 * @param {string} [query=location.search] - Query string to parse
 * @returns {Object} Parsed query parameters
 */
export function parseQuery(query = '') {
  const params = new URLSearchParams(query);
  return Object.fromEntries(params.entries());
}

/**
 * Build query string from an object
 * @param {Object} params - Parameters to stringify
 * @returns {string} Query string
 */
export function buildQuery(params) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      searchParams.append(key, value);
    }
  });
  return searchParams.toString();
}

/**
 * Clamp a number between min and max
 * @param {number} num - Number to clamp
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} Clamped number
 */
export function clamp(num, min, max) {
  return Math.min(Math.max(num, min), max);
}

/**
 * Check if device prefers reduced motion
 * @returns {boolean} True if prefers reduced motion
 */
export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Copy text to clipboard
 * @param {string} text - Text to copy
 * @returns {Promise<boolean>} Success status
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error('Failed to copy:', err);
    return false;
  }
}

/**
 * Escape HTML special characters so a string can be safely interpolated into
 * HTML text or attribute contexts.
 *
 * Pure string replace (no DOM) so it works in any context and is unit-testable.
 * Escapes `& < > " '` — note this covers attribute values too, which the
 * previous `textContent`-based version did NOT (it left quotes untouched).
 *
 * @param {string|null|undefined} str - String to escape
 * @returns {string} Escaped string ('' for null/undefined)
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitize a URL for safe use in an `href`.
 *
 * Allowlist approach: only `http(s)://`, `mailto:`, and relative/path refs
 * (`/...`, `#...`, `./...`) pass through. Everything else — `javascript:`,
 * `data:`, `vbscript:`, `file:`, `ssh://`, `git://`, `ftp:` — is neutralized
 * to `#` so it can never navigate or execute. npm-sourced repository URLs are
 * not guaranteed to be http(s) (the registry happily stores `ssh://git@...`),
 * so this guard is required before putting any external URL into an anchor.
 *
 * @param {string|null|undefined} url - URL to sanitize
 * @returns {string} The URL if safe, otherwise '#'
 */
export function sanitizeUrl(url) {
  if (!url) return '#';
  const u = String(url).trim();
  if (/^(?:https?:\/\/|mailto:|[/#.]|\.\.?\/)/i.test(u)) return u;
  return '#';
}

/**
 * Render a dependency-free SVG bar chart into a container.
 *
 * Pure DOM builder (no layout math beyond simple scaling), designed for the
 * package detail modal's daily download history. Each bar carries a `title`
 * tooltip with the raw date + formatted value so hover/keyboard users get
 * exact numbers; the max value scales bars to the container height.
 *
 * Data format: array of `{ date: string, downloads: number }` (date is a
 * yyyy-mm-dd string). Emits nothing destructive — the container's previous
 * contents are preserved. Returns the created <svg> element.
 *
 * @param {HTMLElement} container - Element to receive the SVG
 * @param {Array<{date: string, downloads: number}>} data - Daily points
 * @param {Object} [options]
 * @param {number} [options.height=120] - Chart height in px
 * @param {number} [options.barGap=1] - Gap between bars in px
 * @returns {SVGSVGElement} The created SVG element (also appended to container)
 */
export function renderBars(container, data, options = {}) {
  const height = options.height || 120;
  const barGap = options.barGap !== undefined ? options.barGap : 1;
  const values = (data || []).map(d => d.downloads || 0);
  const max = values.length ? Math.max(...values) : 0;

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${Math.max(values.length, 1)} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Daily download count over the last 60 days');

  const n = values.length;
  if (n === 0) {
    container.appendChild(svg);
    return svg;
  }

  const slot = 1 / n;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    const barHeight = max > 0 ? Math.max(v / max, 0.01) : 0.01;
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', String(i * slot));
    rect.setAttribute('y', String(height * (1 - barHeight)));
    rect.setAttribute('width', String(Math.max(slot - barGap / 100, 0.02)));
    rect.setAttribute('height', String(height * barHeight));
    // Tooltip: yyyy-mm-dd + formatted count
    const point = data[i];
    const count = point.downloads === undefined || point.downloads === null ? 0 : point.downloads;
    rect.setAttribute('title', `${point.date}: ${count.toLocaleString()} downloads`);
    rect.classList.add('chart-bar');
    svg.appendChild(rect);
  }

  container.appendChild(svg);
  return svg;
}

/**
 * Truncate string to specified length
 * @param {string} str - String to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated string
 */
export function truncate(str, maxLength = 100) {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

// ═══════════════════════════════════════════════════════════════════
// LINE / AREA CHART (SVG)
// ═══════════════════════════════════════════════════════════════════
//
// Pure path-builder + DOM-lite renderer for the ecosystem trend chart.
// renderBars() (above) draws the per-package sparklines; this draws a
// line/area series over time. Both are dependency-free and typed for the
// {date, downloads} shape used by /api/ecosystem.downloads_series.
//
// Scaling: downloads are non-negative, so the y-axis baseline is always 0
// (design D6 / design.md — the area fill anchors to the x-axis, never to
// the data min, so a flat series still shows a visible 0-anchored area).

/**
 * Build an SVG path 'd' string for a series of download counts.
 *
 * Charts are laid out on a viewBox of width×height with `pad` inset on all
 * sides. X is evenly spaced across the padded width; Y maps values on
 * [0, max] to the padded height (value 0 sits on the bottom edge).
 *
 * @param {Array<{date: string, downloads: number}>} points - Series, oldest first
 * @param {number} width - viewBox width
 * @param {number} height - viewBox height
 * @param {number} [pad=4] - Inset from the viewBox edges
 * @returns {string} SVG path 'd', or '' for fewer than 2 points
 */
export function buildLinePath(points, width, height, pad = 4) {
  if (!Array.isArray(points) || points.length < 2) return '';
  const w = width > 0 ? width : 1;
  const h = height > 0 ? height : 1;
  const p = Math.min(Math.min(pad, w / 2), h / 2);
  const innerW = Math.max(w - p * 2, 0.001);
  const innerH = Math.max(h - p * 2, 0.001);

  const values = points.map((pt) => Number(pt.downloads) || 0);
  const max = Math.max(...values, 1); // floor at 1 so a flat 0 series draws

  const step = points.length > 1 ? innerW / (points.length - 1) : 0;
  const parts = values.map((v, i) => {
    const x = p + i * step;
    const y = p + innerH * (1 - v / max);
    return `${i === 0 ? 'M' : 'L'}${round(x, 3)} ${round(y, 3)}`;
  });
  return parts.join(' ');
}

/**
 * Build the area-fill path for a series: the line path closed down to the
 * bottom edge (0-baseline) and back to the start.
 *
 * @param {string} linePath - Output of buildLinePath()
 * @param {number} width - viewBox width (for the bottom-right corner)
 * @param {number} height - viewBox height (for the bottom-left corner)
 * @returns {string} Closed area path 'd', or '' for an empty line path
 */
export function buildAreaPath(linePath, width, height) {
  if (!linePath) return '';
  const bottomY = height - 0; // baseline is the viewBox bottom edge
  return `${linePath} L${width} ${bottomY} L0 ${bottomY} Z`;
}

function round(n, digits = 3) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Render a line/area chart into a container as an SVG element.
 *
 * @param {HTMLElement} container - Element to append the SVG into
 * @param {Array<{date: string, downloads: number}>} points - Series, oldest first
 * @param {Object} [options]
 * @param {number} [options.width=600] - viewBox width
 * @param {number} [options.height=160] - viewBox height
 * @param {boolean} [options.area=true] - Draw the filled area under the line
 * @param {boolean} [options.showLabels=true] - Draw sparse date x-axis labels
 * @param {number} [options.labelEvery=10] - Label every Nth point
 * @param {Function} [options.labelFn] - (point, index) => string for x labels
 * @returns {SVGSVGElement} The appended SVG element
 */
export function renderLineArea(container, points, options = {}) {
  const width = options.width || 600;
  const height = options.height || 160;
  const labels = options.showLabels !== false;
  const labelEvery = options.labelEvery || 10;
  const labelFn = options.labelFn || ((pt) => pt.date?.slice(5) || '');

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Daily total downloads over the last 60 days');
  svg.classList.add('line-chart');

  const linePath = buildLinePath(points, width, height);
  if (!linePath) {
    container.appendChild(svg);
    return svg;
  }

  if (options.area !== false) {
    const area = document.createElementNS(ns, 'path');
    area.setAttribute('d', buildAreaPath(linePath, width, height));
    area.classList.add('chart-area');
    svg.appendChild(area);
  }

  const line = document.createElementNS(ns, 'path');
  line.setAttribute('d', linePath);
  line.classList.add('chart-line');
  svg.appendChild(line);

  // Sparse x-axis labels: every Nth point, positioned under its x coordinate.
  if (labels) {
    const every = Math.max(1, Math.floor(labelEvery));
    points.forEach((pt, i) => {
      if (i % every !== 0) return;
      const values = points.map((p) => Number(p.downloads) || 0);
      const max = Math.max(...values, 1);
      const innerW = Math.max(width - 8, 0.001);
      const step = points.length > 1 ? innerW / (points.length - 1) : 0;
      const x = 4 + i * step;
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', String(round(x, 2)));
      label.setAttribute('y', String(height - 2));
      label.setAttribute('text-anchor', i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle');
      label.classList.add('chart-label');
      const text = document.createTextNode(labelFn(pt, i));
      label.appendChild(text);
      svg.appendChild(label);
    });
  }

  container.appendChild(svg);
  return svg;
}