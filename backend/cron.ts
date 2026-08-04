import { runIncrementalSync, runFullSync } from './sync';
import type { SyncResult } from './sync';
import { recomputeStatsCache } from './stats';
import { recomputeEcosystemCache } from './ecosystem';
import { recomputeGrowthCache } from './growth';

// Cron configuration:
// SYNC_CRON: controls incremental sync (default: every 4 hours)
// SYNC_FULL_CRON: controls full sync (default: daily at 3 AM UTC)

const SYNC_CRON = process.env.SYNC_CRON || '0 */4 * * *';       // Default: every 4 hours
const SYNC_FULL_CRON = process.env.SYNC_FULL_CRON || '0 3 * * *'; // Default: 3 AM UTC daily

export interface CronSchedule {
  minute: number[] | '*';
  hour: number[] | '*';
  dayOfMonth: number[] | '*';
  month: number[] | '*';
  dayOfWeek: number[] | '*';
}

// Field ranges for cron step/list/range expansion. minute/hour/dayOfWeek are
// zero-based (0-59, 0-23, 0-7); dayOfMonth and month are one-based (1-31, 1-12)
// to match cron semantics.
const FIELD_RANGES: Record<keyof CronSchedule, { start: number; end: number }> = {
  minute: { start: 0, end: 59 },
  hour: { start: 0, end: 23 },
  dayOfMonth: { start: 1, end: 31 },
  month: { start: 1, end: 12 },
  dayOfWeek: { start: 0, end: 7 },
};

/**
 * Parse one cron field into a set of concrete values — `'*'` for wildcard,
 * or an explicit list of numbers. Supports:
 *   - `*`     wildcard (any value)
 *   - `3`     a single value          -> [3]
 *   - `0,30`  a comma list            -> [0, 30]
 *   - `1-5`   a range                 -> [1, 2, 3, 4, 5]
 *   - star/4  a step                  -> every 4th value of the field's range
 *                                       (hour: [0,4,8,12,16,20]; minute: [0,4,8,...])
 *
 * Previously a step field like `star/4` was treated as a wildcard, so the
 * default sync cron `0 star/4 * * *` (every 4th hour) fired on EVERY hour
 * at :00 instead.
 */
function parseCronField(field: string, range: { start: number; end: number }): number[] | '*' {
  const value = field.trim();
  if (value === '*') return '*';

  const stepMatch = /^\*\/(\d+)$/.exec(value);
  if (stepMatch) {
    const step = parseInt(stepMatch[1], 10);
    if (step < 1) return '*';
    const values: number[] = [];
    for (let i = range.start; i <= range.end; i += step) values.push(i);
    return values;
  }

  const rangeMatch = /^(\d+)-(\d+)$/.exec(value);
  if (rangeMatch) {
    const values: number[] = [];
    for (let i = parseInt(rangeMatch[1], 10), end = parseInt(rangeMatch[2], 10); i <= end; i++) {
      values.push(i);
    }
    return values.length > 0 ? values : '*';
  }

  if (value.includes(',')) {
    const values = value
      .split(',')
      .map((v) => parseInt(v.trim(), 10))
      .filter((n) => !Number.isNaN(n));
    return values.length > 0 ? values : '*';
  }

  const n = parseInt(value, 10);
  return Number.isNaN(n) ? '*' : [n];
}

export function parseCron(expression: string): CronSchedule {
  const parts = expression.split(' ');
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${expression}`);
  }

  return {
    minute: parseCronField(parts[0], FIELD_RANGES.minute),
    hour: parseCronField(parts[1], FIELD_RANGES.hour),
    dayOfMonth: parseCronField(parts[2], FIELD_RANGES.dayOfMonth),
    month: parseCronField(parts[3], FIELD_RANGES.month),
    dayOfWeek: parseCronField(parts[4], FIELD_RANGES.dayOfWeek),
  };
}

function fieldMatches(field: number[] | '*', value: number): boolean {
  return field === '*' || field.includes(value);
}

export function shouldRun(schedule: CronSchedule, now: Date): boolean {
  if (!fieldMatches(schedule.minute, now.getUTCMinutes())) return false;
  if (!fieldMatches(schedule.hour, now.getUTCHours())) return false;
  if (!fieldMatches(schedule.dayOfMonth, now.getUTCDate())) return false;
  if (!fieldMatches(schedule.month, now.getUTCMonth() + 1)) return false;
  if (!fieldMatches(schedule.dayOfWeek, now.getUTCDay())) return false;
  return true;
}

let lastIncrementalRun: string | null = null;
let lastFullRun: string | null = null;
let isRunning = false;
let lastSyncResult: SyncResult | null = null;

/**
 * Per-trigger dedup key for scheduled syncs, at minute resolution in UTC.
 * Two ticks during the same matching minute (or the same matching hour for
 * an hourly cron, etc.) produce the same key — that's what suppresses the
 * duplicate fire when setInterval drifts or when shouldRun stays true across
 * adjacent ticks. Different scheduled triggers (different minutes/hours/days)
 * produce different keys, so sub-daily crons like `0 * * * *` actually fire
 * hourly instead of being throttled to once-per-day.
 */
function cronTriggerKey(date: Date): string {
  // `YYYY-MM-DDTHH:MM` (UTC). Slice is cheaper than formatting by hand and
  // matches what `shouldRun` checks against (which also uses UTC fields).
  return date.toISOString().slice(0, 16);
}

/**
 * Monotonic counter bumped every time a sync (incremental or full) completes.
 * Lets API response caches key off the data version so they invalidate the
 * instant new data lands — no stale window, no polling.
 */
let syncVersion = 0;

export function getSyncVersion(): number {
  return syncVersion;
}

export function startCron(): void {
  console.log(`[Cron] Incremental sync: ${SYNC_CRON}`);
  console.log(`[Cron] Full sync: ${SYNC_FULL_CRON}`);

  // Check every minute. The per-trigger dedup (lastFullRun / lastIncrementalRun
  // vs cronTriggerKey) lives inside cronTick so the logic is testable without
  // waiting for a real interval.
  setInterval(() => {
    void cronTick(new Date());
  }, 60000); // Check every minute
}

/**
 * Compute the next fire time for a fixed-time cron whose minute and hour are
 * explicit values (single or list, e.g. "0 3 * * *" or "15 6,18 * * *").
 * Returns null for wildcard patterns (e.g. "0 * * * *") whose next fire
 * can't be derived from fixed hour+minute sets.
 */
function nextFixedTime(expression: string): Date | null {
  const schedule = parseCron(expression);

  // Can only compute next run for simple fixed-time crons (explicit minutes
  // + explicit hours). A wildcard minute or hour means "every minute/hour".
  if (schedule.minute === '*' || schedule.hour === '*') return null;

  const now = new Date();

  // Search over the next 2 days of candidate (day, hour, minute) triples and
  // return the soonest that matches the schedule's explicit sets.
  for (let offsetDays = 0; offsetDays <= 1; offsetDays++) {
    const day = new Date(now);
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + offsetDays);

    // Skip days that don't match dayOfMonth / month / dayOfWeek when those
    // are explicit (wildcards match any day).
    if (schedule.dayOfMonth !== '*' && !schedule.dayOfMonth.includes(day.getUTCDate())) continue;
    if (schedule.month !== '*' && !schedule.month.includes(day.getUTCMonth() + 1)) continue;
    if (schedule.dayOfWeek !== '*' && !schedule.dayOfWeek.includes(day.getUTCDay())) continue;

    for (const hour of schedule.hour) {
      for (const minute of schedule.minute) {
        const candidate = new Date(day);
        candidate.setUTCHours(hour, minute, 0, 0);
        if (candidate > now) return candidate;
      }
    }
  }

  return null;
}

/**
 * Get the next scheduled run time — the soonest of the incremental and full
 * sync schedules. Previously this only looked at the full sync, so next_sync
 * ignored a more-frequent fixed-time incremental schedule. Each component is
 * only computable for fixed-time crons; interval patterns (the default
 * hourly / 4-hourly incremental sync) contribute null. Returns null only when
 * neither schedule is a fixed-time cron.
 */
export function getNextRunTime(): Date | null {
  const candidates = [nextFixedTime(SYNC_CRON), nextFixedTime(SYNC_FULL_CRON)]
    .filter((d): d is Date => d !== null);
  if (candidates.length === 0) return null;
  return new Date(Math.min(...candidates.map((d) => d.getTime())));
}

export function isSyncRunning(): boolean {
  return isRunning;
}

export function getLastSyncResult(): SyncResult | null {
  return lastSyncResult;
}

/**
 * One timer-tick of the cron scheduler. Exported so tests can drive the full
 * sync-trigger + dedup logic synchronously without waiting for the 60s
 * setInterval. Returns the (possibly still-in-flight) promise so callers can
 * await completion.
 */
export async function cronTick(now: Date): Promise<void> {
  const incrementalSchedule = parseCron(SYNC_CRON);
  const fullSchedule = parseCron(SYNC_FULL_CRON);
  const currentRun = cronTriggerKey(now);

  if (isRunning) return;

  // Check if it's time for a full sync (takes priority)
  if (shouldRun(fullSchedule, now) && lastFullRun !== currentRun) {
    isRunning = true;
    console.log('[Cron] Starting scheduled FULL sync...');
    try {
      lastSyncResult = await runFullSync();
      recomputeStatsCache();
      recomputeEcosystemCache();
      recomputeGrowthCache();
      lastFullRun = currentRun;
      lastIncrementalRun = currentRun;
      syncVersion++;
      console.log('[Cron] Full sync completed');
    } catch (err) {
      console.error('[Cron] Full sync failed:', err);
    }
    isRunning = false;
    return;
  }

  // Check if it's time for an incremental sync
  if (shouldRun(incrementalSchedule, now) && lastIncrementalRun !== currentRun) {
    isRunning = true;
    console.log('[Cron] Starting scheduled incremental sync...');
    try {
      lastSyncResult = await runIncrementalSync();
      recomputeStatsCache();
      recomputeEcosystemCache();
      recomputeGrowthCache();
      lastIncrementalRun = currentRun;
      syncVersion++;
      console.log('[Cron] Incremental sync completed');
    } catch (err) {
      console.error('[Cron] Incremental sync failed:', err);
    }
    isRunning = false;
  }
}

/**
 * Reset all module-level cron state. Intended for tests only — lets each test
 * start from a clean slate (no lingering last-run dedup, no isRunning flag,
 * no syncVersion accumulation across tests).
 */
export function resetCronState(): void {
  lastIncrementalRun = null;
  lastFullRun = null;
  isRunning = false;
  lastSyncResult = null;
  syncVersion = 0;
}
