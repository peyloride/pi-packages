import { runSync } from './sync';

// Simple cron implementation for daily sync
// Uses setInterval to check every minute if it's time to run

const SYNC_CRON = process.env.SYNC_CRON || '0 3 * * *'; // Default: 3 AM UTC

interface CronSchedule {
  minute: number | '*';
  hour: number | '*';
  dayOfMonth: number | '*';
  month: number | '*';
  dayOfWeek: number | '*';
}

export function parseCron(expression: string): CronSchedule {
  const parts = expression.split(' ');
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${expression}`);
  }

  return {
    minute: parts[0] === '*' ? '*' : parseInt(parts[0], 10),
    hour: parts[1] === '*' ? '*' : parseInt(parts[1], 10),
    dayOfMonth: parts[2] === '*' ? '*' : parseInt(parts[2], 10),
    month: parts[3] === '*' ? '*' : parseInt(parts[3], 10),
    dayOfWeek: parts[4] === '*' ? '*' : parseInt(parts[4], 10),
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

let lastRunDate: string | null = null;
let isRunning = false;

export function startCron(): void {
  const schedule = parseCron(SYNC_CRON);
  console.log(`[Cron] Scheduler started with expression: ${SYNC_CRON}`);
  console.log(`[Cron] Next run: ${schedule.hour === '*' ? 'every hour' : schedule.hour + ':00'} UTC`);

  // Check every minute
  setInterval(async () => {
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    // Prevent duplicate runs on the same day if configured for daily
    if (lastRunDate === today && schedule.hour !== '*') {
      return;
    }

    // Check if it's time to run
    if (shouldRun(schedule, now) && !isRunning) {
      isRunning = true;
      console.log('[Cron] Starting scheduled sync...');
      
      try {
        await runSync();
        lastRunDate = today;
        console.log('[Cron] Scheduled sync completed');
      } catch (err) {
        console.error('[Cron] Scheduled sync failed:', err);
      }
      
      isRunning = false;
    }
  }, 60000); // Check every minute
}

export function getNextRunTime(): Date | null {
  const schedule = parseCron(SYNC_CRON);
  const now = new Date();
  
  if (schedule.hour === '*') return null; // Running hourly, no "next" time
  
  const next = new Date(now);
  next.setUTCHours(schedule.hour as number, 0, 0, 0);
  
  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  
  return next;
}

// Manual trigger for API endpoint
export async function triggerSync(): Promise<{ success: boolean; message: string }> {
  if (isRunning) {
    return { success: false, message: 'Sync already in progress' };
  }
  
  isRunning = true;
  try {
    const result = await runSync();
    return { success: true, message: `Synced ${result.packages} packages, ${result.downloadsUpdated} download histories` };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, message: `Sync failed: ${message}` };
  } finally {
    isRunning = false;
  }
}

export function isSyncRunning(): boolean {
  return isRunning;
}
