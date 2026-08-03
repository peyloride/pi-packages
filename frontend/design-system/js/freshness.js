/**
 * PI DESIGN SYSTEM — Freshness utilities
 *
 * Pure, DOM-free classification of package "freshness" for card badges:
 *   - NEW badge:  first_seen within the last NEW_DAYS (14) days
 *   - stale chip: last_publish older than STALE_DAYS (30) days
 *
 * Everything is derived from fields the API already returns (first_seen,
 * last_publish) — no backend involvement. All functions take explicit
 * timestamps / injected formatters so they are deterministic and
 * unit-testable under node:test (no DOM, no Date.now()).
 *
 * ═══════════════════════════════════════════════════════════════════ */

import { timeAgo as defaultTimeAgo } from './utils.js';

export const NEW_DAYS = 14;
export const STALE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Classify a package's freshness.
 *
 * Boundaries are INCLUSIVE:
 *   - first_seen exactly NEW_DAYS days ago is still "new"
 *   - last_publish exactly STALE_DAYS days ago is already "stale"
 *
 * Future timestamps are handled defensively (clock skew / bad data):
 *   - a future first_seen classifies as new (diff is negative)
 *   - a future last_publish never classifies as stale
 *
 * Unparseable or missing timestamps → not new / not stale, no throw.
 *
 * @param {number} now - Epoch ms "current time" (injected for determinism)
 * @param {string|null|undefined} firstSeen - ISO date string of first appearance
 * @param {string|null|undefined} lastPublish - ISO date string of last publish
 * @param {Function} [timeAgoFn] - Formatter for the relative updated label
 *   (defaults to utils.timeAgo; inject a stub in tests for determinism)
 * @param {Object} [options]
 * @param {number} [options.newDays=NEW_DAYS] - NEW-badge window in days
 * @param {number} [options.staleDays=STALE_DAYS] - stale threshold in days
 * @returns {{isNew: boolean, isStale: boolean, updatedLabel: string}}
 *   updatedLabel is the relative "X ago" label for last_publish ('' if absent)
 */
export function getFreshness(now, firstSeen, lastPublish, timeAgoFn = defaultTimeAgo, options = {}) {
  const newDays = options.newDays !== undefined ? options.newDays : NEW_DAYS;
  const staleDays = options.staleDays !== undefined ? options.staleDays : STALE_DAYS;

  const firstSeenMs = parseMs(firstSeen);
  const lastPublishMs = parseMs(lastPublish);

  // Negative diff (future) passes the <= window check → classified as new.
  const isNew = firstSeenMs !== null && now - firstSeenMs <= newDays * DAY_MS;
  const isStale = lastPublishMs !== null && now - lastPublishMs >= staleDays * DAY_MS;

  const updatedLabel = lastPublishMs !== null ? timeAgoFn(lastPublish) : '';

  return { isNew, isStale, updatedLabel };
}

/**
 * Build the muted stale-chip label, e.g. "updated 45d ago".
 * Reuses the injected relative-time formatter so it stays DOM-free and
 * matches the plain updated label exactly except for the "updated " prefix.
 *
 * @param {string} lastPublish - ISO date string of last publish
 * @param {Function} [timeAgoFn] - Relative-time formatter (defaults to utils.timeAgo)
 * @returns {string} "updated <relative time>" label
 */
export function formatStaleLabel(lastPublish, timeAgoFn = defaultTimeAgo) {
  return `updated ${timeAgoFn(lastPublish)}`;
}

/**
 * Parse an ISO date string to epoch ms. Returns null for missing, empty,
 * or unparseable input (never throws).
 */
function parseMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}
