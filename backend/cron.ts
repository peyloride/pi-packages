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
 * Compute the next fire time for a simple fixed-time cron like "0 3 * * *".
 * Returns null for interval/wildcard patterns (e.g. "0 *\/4 * * *", "0 * * * *")
 * whose next fire can't be derived from a single fixed hour+minute.
 */
function nextFixedTime(expression: string): Date | null {
  const schedule = parseCron(expression);

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
