/**
 * PI DESIGN SYSTEM — URL State Utilities
 *
 * Pure functions for encoding/decoding dashboard view state in the URL.
 * Dependency-free and unit-testable (no DOM / window access).
 *
 * View state lives in the query string:
 *   ?sort=popular&period=daily&search=agent&p=2
 *
 * The package detail modal lives in the hash: `#/pkg/<name>`.
 *
 * ═══════════════════════════════════════════════════════════════════ */

export const VALID_SORTS = ['trending', 'popular', 'new', 'updated'];
export const VALID_PERIODS = ['daily', 'weekly', 'monthly'];

export const DEFAULT_SORT = 'trending';
export const DEFAULT_PERIOD = 'weekly';
export const DEFAULT_SEARCH = '';
export const DEFAULT_PAGE = 1;
export const DEFAULT_PUBLISHER = '';
export const DEFAULT_MIN_DOWNLOADS = 0;

/**
 * Normalize a raw sort value to a valid sort, or the default.
 * @param {string|null|undefined} raw
 * @returns {string} One of VALID_SORTS
 */
export function normalizeSort(raw) {
  if (typeof raw === 'string' && VALID_SORTS.includes(raw)) return raw;
  return DEFAULT_SORT;
}

/**
 * Normalize a raw period value to a valid period, or the default.
 * @param {string|null|undefined} raw
 * @returns {string} One of VALID_PERIODS
 */
export function normalizePeriod(raw) {
  if (typeof raw === 'string' && VALID_PERIODS.includes(raw)) return raw;
  return DEFAULT_PERIOD;
}

/**
 * Normalize a raw page value to a positive integer.
 * Non-numeric, zero, negative, and fractional values fall back to 1.
 * @param {string|null|undefined} raw
 * @returns {number} Integer >= 1
 */
export function normalizePage(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_PAGE;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return DEFAULT_PAGE;
  return Math.floor(n);
}

/**
 * Normalize a raw publisher filter value.
 * Empty/whitespace → '' (no filter). Kept as-is otherwise (exact match,
 * case-insensitive server-side).
 * @param {string|null|undefined} raw
 * @returns {string}
 */
export function normalizePublisher(raw) {
  if (typeof raw !== 'string') return DEFAULT_PUBLISHER;
  return raw.trim();
}

/**
 * Normalize a raw min_downloads value to a non-negative integer, or 0 when
 * absent/invalid (0 = no filter). Negative/fractional/non-numeric → 0.
 * @param {string|null|undefined} raw
 * @returns {number}
 */
export function normalizeMinDownloads(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_MIN_DOWNLOADS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MIN_DOWNLOADS;
  return Math.floor(n);
}

/**
 * Parse a query string (e.g. location.search) into validated view state.
 * Invalid or missing params fall back to defaults without erroring.
 *
 * @param {string|URLSearchParams} query - Query string ("?sort=...") or params
 * @returns {{sort: string, period: string, search: string, page: number, publisher?: string, min_downloads?: number}}
 */
export function parseUrlState(query = '') {
  const params = query instanceof URLSearchParams
    ? query
    : new URLSearchParams((query || '').replace(/^\?/, ''));
  const publisher = normalizePublisher(params.get('publisher'));
  const minDownloads = normalizeMinDownloads(params.get('min_downloads'));
  const state = {
    sort: normalizeSort(params.get('sort')),
    period: normalizePeriod(params.get('period')),
    search: (params.get('search') || '').trim(),
    page: normalizePage(params.get('p')),
  };
  // Only include filter keys when actually active, so callers can distinguish
  // "no filter" from "filter = default".
  if (publisher) state.publisher = publisher;
  if (minDownloads > 0) state.min_downloads = minDownloads;
  return state;
}

/**
 * Build a query string (without leading "?") from view state.
 * Default values are omitted so the URL stays minimal.
 *
 * @param {Partial<{sort: string, period: string, search: string, page: number, publisher?: string, min_downloads?: number}>} state
 * @returns {string} e.g. "sort=popular&period=daily&search=agent&p=2"
 */
export function buildUrlState(state = {}) {
  const normalized = {
    sort: normalizeSort(state.sort),
    period: normalizePeriod(state.period),
    search: typeof state.search === 'string' ? state.search.trim() : DEFAULT_SEARCH,
    page: state.page === undefined || state.page === null ? DEFAULT_PAGE : normalizePage(String(state.page)),
  };

  const params = new URLSearchParams();
  if (normalized.sort !== DEFAULT_SORT) params.set('sort', normalized.sort);
  if (normalized.period !== DEFAULT_PERIOD) params.set('period', normalized.period);
  if (normalized.search) params.set('search', normalized.search);
  if (normalized.page !== DEFAULT_PAGE) params.set('p', String(normalized.page));

  const publisher = normalizePublisher(state.publisher);
  if (publisher) params.set('publisher', publisher);

  const minDownloads = normalizeMinDownloads(state.min_downloads === undefined || state.min_downloads === null ? undefined : String(state.min_downloads));
  if (minDownloads > 0) params.set('min_downloads', String(minDownloads));

  return params.toString();
}

/**
 * Parse a hash (e.g. location.hash) into a package name, or null.
 * Accepts "#/pkg/<name>" and "#/pkg/<name>" with trailing junk tolerated
 * but the name itself is taken literally (no URL-decoding beyond the
 * standard decodeURIComponent performed by URLSearchParams-style handling).
 *
 * @param {string|undefined|null} hash - e.g. "#/pkg/pi-dgoal"
 * @returns {string|null} Package name to deep-link, or null if not a package hash
 */
export function parsePackageHash(hash = '') {
  const h = String(hash || '').trim();
  const m = h.match(/^#\/pkg\/(.+)$/);
  if (!m) return null;
  const name = m[1];
  return name || null;
}

/**
 * Build a package detail hash from a package name.
 * @param {string} name
 * @returns {string} e.g. "#/pkg/pi-dgoal"
 */
export function buildPackageHash(name) {
  return `#/pkg/${name}`;
}
