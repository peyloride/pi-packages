import { runIncrementalSync, runFullSync } from './sync';
import type { SyncResult } from './sync';
import { recomputeStatsCache } from './stats';
import { recomputeGrowthCache } from './growth';

// Cron configuration:
// SYNC_CRON: controls incremental sync (default: every 4 hours)
// SYNC_FULL_CRON: controls full sync (default: daily at 3 AM UTC)

const SYNC_CRON = process.env.SYNC_CRON || '0 */4 * * *';       // Default: every 4 hours
const SYNC_FULL_CRON = process.env.SYNC_FULL_CRON || '0 3 * * *'; // Default: 3 AM UTC daily

interface CronSchedule {
  minute: number | '*';
  hour: number | '*';
  dayOfMonth: number | '*';
  month: number | '*';
  dayOfWeek: number | '*';
}

function parseCronField(field: string): number | '*' {
  if (field === '*') return '*';
  const n = parseInt(field, 10);
  return isNaN(n) ? '*' : n;  // treat */N, 1-5, etc. as wildcard for scheduling
}

export function parseCron(expression: string): CronSchedule {
  const parts = expression.split(' ');
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${expression}`);
  }

  return {
    minute: parseCronField(parts[0]),
    hour: parseCronField(parts[1]),
    dayOfMonth: parseCronField(parts[2]),
    month: parseCronField(parts[3]),
    dayOfWeek: parseCronField(parts[4]),
  };
}

export function shouldRun(schedule: CronSchedule, now: Date): boolean {
  if (schedule.minute !== '*' && now.getUTCMinutes() !== schedule.minute) return false;
  if (schedule.hour !== '*' && now.getUTCHours() !== schedule.hour) return false;
  if (schedule.dayOfMonth !== '*' && now.getUTCDate() !== schedule.dayOfMonth) return false;
  if (schedule.month !== '*' && now.getUTCMonth() + 1 !== schedule.month) return false;
  if (schedule.dayOfWeek !== '*' && now.getUTCDay() !== schedule.dayOfWeek) return false;
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
  const incrementalSchedule = parseCron(SYNC_CRON);
  const fullSchedule = parseCron(SYNC_FULL_CRON);
  console.log(`[Cron] Incremental sync: ${SYNC_CRON}`);
  console.log(`[Cron] Full sync: ${SYNC_FULL_CRON}`);

  // Check every minute
  setInterval(async () => {
    const now = new Date();
    const currentRun = cronTriggerKey(now);

    if (isRunning) return;

    // Check if it's time for a full sync (takes priority)
    if (shouldRun(fullSchedule, now) && lastFullRun !== currentRun) {
      isRunning = true;
      console.log('[Cron] Starting scheduled FULL sync...');
      try {
        lastSyncResult = await runFullSync();
        recomputeStatsCache();
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
        recomputeGrowthCache();
        lastIncrementalRun = currentRun;
        syncVersion++;
        console.log('[Cron] Incremental sync completed');
      } catch (err) {
        console.error('[Cron] Incremental sync failed:', err);
      }
      isRunning = false;
    }
  }, 60000); // Check every minute
}

/**
 * Get the next scheduled run time (for the next upcoming event — incremental or full).
 * Only works for simple fixed-time crons like "0 3 * * *".
 * Returns null for interval patterns like "0 *\/4 * * *".
 */
export function getNextRunTime(): Date | null {
  const schedule = parseCron(SYNC_FULL_CRON);

  // Can only compute next run for simple fixed-time crons
  if (schedule.hour === '*' || schedule.minute === '*') return null;

  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(schedule.hour as number, schedule.minute as number, 0, 0);

  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  return next;
}

export function isSyncRunning(): boolean {
  return isRunning;
}

export function getLastSyncResult(): SyncResult | null {
  return lastSyncResult;
}
