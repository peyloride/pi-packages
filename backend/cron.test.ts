import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCron,
  shouldRun,
  getNextRunTime,
  isSyncRunning,
  cronTick,
  resetCronState,
  getLastSyncResult,
  getSyncVersion,
  type CronSchedule,
} from './cron';
import { getDb } from './db';

describe('cron.ts', () => {
  describe('parseCron', () => {
    it('should parse standard cron expression', () => {
      const schedule = parseCron('0 3 * * *');
      assert.deepEqual(schedule.minute, [0]);
      assert.deepEqual(schedule.hour, [3]);
      assert.equal(schedule.dayOfMonth, '*');
      assert.equal(schedule.month, '*');
      assert.equal(schedule.dayOfWeek, '*');
    });

    it('should parse cron with wildcard hour', () => {
      const schedule = parseCron('0 * * * *');
      assert.deepEqual(schedule.minute, [0]);
      assert.equal(schedule.hour, '*');
    });

    it('expands a step field (*/N) to explicit values', () => {
      // Regression: `*/4` used to be treated as a wildcard, so the default
      // sync cron "0 */4 * * *" (every 4 hours) fired hourly instead.
      const schedule = parseCron('0 */4 * * *');
      assert.deepEqual(schedule.minute, [0]);
      assert.deepEqual(schedule.hour, [0, 4, 8, 12, 16, 20]); // every 4th hour
      assert.equal(schedule.dayOfMonth, '*');
    });

    it('expands a minute step field (*/15) correctly', () => {
      const schedule = parseCron('*/15 * * * *');
      assert.deepEqual(schedule.minute, [0, 15, 30, 45]);
      assert.equal(schedule.hour, '*');
    });

    it('expands comma lists and ranges', () => {
      const schedule = parseCron('0,30 9-17 * * *');
      assert.deepEqual(schedule.minute, [0, 30]);
      assert.deepEqual(schedule.hour, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
      assert.equal(schedule.dayOfMonth, '*');
    });

    it('should parse cron with specific day', () => {
      const schedule = parseCron('30 14 15 * *');
      assert.deepEqual(schedule.minute, [30]);
      assert.deepEqual(schedule.hour, [14]);
      assert.deepEqual(schedule.dayOfMonth, [15]);
    });

    it('should throw on invalid cron expression', () => {
      assert.throws(() => parseCron('invalid'));
      assert.throws(() => parseCron('1 2'));
    });
  });

  describe('shouldRun', () => {
    it('should return true when all conditions match', () => {
      const schedule: CronSchedule = { minute: [0], hour: [3], dayOfMonth: '*', month: '*', dayOfWeek: '*' };
      const date = new Date('2024-01-15T03:00:00Z');
      assert.equal(shouldRun(schedule, date), true);
    });

    it('should return false when minute does not match', () => {
      const schedule: CronSchedule = { minute: [0], hour: [3], dayOfMonth: '*', month: '*', dayOfWeek: '*' };
      const date = new Date('2024-01-15T03:30:00Z');
      assert.equal(shouldRun(schedule, date), false);
    });

    it('should return false when hour does not match', () => {
      const schedule: CronSchedule = { minute: [0], hour: [3], dayOfMonth: '*', month: '*', dayOfWeek: '*' };
      const date = new Date('2024-01-15T05:00:00Z');
      assert.equal(shouldRun(schedule, date), false);
    });

    it('should match wildcard conditions', () => {
      const schedule: CronSchedule = { minute: '*', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' };
      const date = new Date('2024-01-15T15:30:00Z');
      assert.equal(shouldRun(schedule, date), true);
    });

    it('should match day of week', () => {
      const schedule: CronSchedule = { minute: [0], hour: [3], dayOfMonth: '*', month: '*', dayOfWeek: [1] }; // Monday
      const monday = new Date('2024-01-15T03:00:00Z'); // Jan 15, 2024 is Monday
      assert.equal(shouldRun(schedule, monday), true);
    });

    it('matches ONLY on the exact hours of a step field (0 */4 regression)', () => {
      const schedule: CronSchedule = { minute: [0], hour: [0, 4, 8, 12, 16, 20], dayOfMonth: '*', month: '*', dayOfWeek: '*' };
      assert.equal(shouldRun(schedule, new Date('2024-01-15T04:00:00Z')), true);  // 04:00 — on step
      assert.equal(shouldRun(schedule, new Date('2024-01-15T05:00:00Z')), false); // 05:00 — NOT on step
      assert.equal(shouldRun(schedule, new Date('2024-01-15T20:00:00Z')), true);  // 20:00 — on step
    });
  });

  describe('getNextRunTime', () => {
    it('returns the soonest of the incremental and full schedules', () => {
      // Both SYNC_CRON ('0 */4 * * *') and SYNC_FULL_CRON ('0 3 * * *')
      // are computable, so the result is the earlier upcoming match.
      const result = getNextRunTime();
      assert.ok(result instanceof Date, 'expected a computable next run time');
      assert.ok(result.getTime() > Date.now(), 'next run must be in the future');
      const minutesToRun = (result.getTime() - Date.now()) / 60000;
      assert.ok(minutesToRun <= 4 * 60, `incremental every 4h → next within 4h, got ${Math.round(minutesToRun)}m`);
    });

    // The default '0 */4 * * *' has explicit hours (0,4,8,12,16,20), so
    // nextFixedTime still finds a next run instead of returning null.
    it('returns a next run for the default */4 incremental schedule', () => {
      const result = getNextRunTime();
      assert.ok(result instanceof Date, 'expected a computable next run for */4');
      const h = result.getUTCHours();
      assert.ok([0, 4, 8, 12, 16, 20].includes(h), `expected hour in {0,4,8,12,16,20}, got ${h}`);
    });
  });

  describe('isSyncRunning', () => {
    it('should return boolean', () => {
      // Note: This may be true if sync is actually running
      const result = isSyncRunning();
      assert.equal(typeof result, 'boolean');
    });
  });
});

// ===========================================================================
// cronTick — the extracted scheduler body, driven synchronously by tests.
// ===========================================================================
//
// cronTick calls runIncrementalSync / runFullSync, which use globalThis.fetch
// and getDb(). The stub below feeds the npm search + downloads APIs canned
// responses so no real network calls happen. DB_PATH is :memory: so no prod
// data is touched.

interface FetchStub {
  (url: string, init?: any): Promise<any>;
  mockClear: () => void;
  mockResolvedValueOnce: (value: any) => FetchStub;
  mock: { calls: any[][] };
}

function makeFetchStub(): FetchStub {
  const calls: any[][] = [];
  const queue: any[] = [];
  const fn = ((url: string, init?: any) => {
    calls.push([url, init]);
    const value = queue.length > 0 ? queue.shift() : { ok: true, json: async () => ({ objects: [], total: 0 }) };
    return Promise.resolve(value);
  }) as FetchStub;
  fn.mockClear = () => { calls.length = 0; queue.length = 0; };
  fn.mockResolvedValueOnce = (value: any) => { queue.push(value); return fn; };
  Object.defineProperty(fn, 'mock', { value: { calls }, writable: false });
  return fn;
}

const originalFetch = globalThis.fetch as unknown as FetchStub;
const mockFetch = makeFetchStub();

before(() => {
  globalThis.fetch = mockFetch as any;
});

after(() => {
  globalThis.fetch = originalFetch as any;
});

describe('cron.cronTick', () => {
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    db = getDb();
    db.prepare('DELETE FROM daily_downloads').run();
    db.prepare('DELETE FROM packages').run();
    db.prepare('DELETE FROM sync_meta').run();
    mockFetch.mockClear();
    resetCronState();
  });

  /** Queue a search response (1 package) + a downloads response (30 days). */
  function queueOnePackageFetches() {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      json: async () => ({
        total: 1,
        objects: [{
          package: { name: 'cron-pkg', version: '1.0.0', links: { npm: 'https://npmjs.com/cron-pkg' } },
          updated: '2024-01-01',
        }],
      }),
    });
    const days = Array.from({ length: 30 }, (_, i) => ({
      day: new Date(Date.now() - i * 86400000).toISOString().split('T')[0],
      downloads: 100,
    }));
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      json: async () => ({
        'cron-pkg': { downloads: days, package: 'cron-pkg', start: days[29].day, end: days[0].day },
      }),
    });
  }

  it('runs a FULL sync when the full schedule matches (3 AM UTC)', async () => {
    // parseCron('0 3 * * *') → minute=[0], hour=[3]
    // 03:00:00Z matches both full ('0 3 * * *') and incremental ('0 */4' →
    // hours [0,4,8,12,16,20]; 03:00 is NOT one of them). Full takes priority.
    queueOnePackageFetches();
    await cronTick(new Date('2024-01-15T03:00:00Z'));
    const result = getLastSyncResult();
    assert.ok(result, 'expected a sync to have run');
    assert.equal(result!.mode, 'full');
    assert.ok(getSyncVersion() > 0, 'expected syncVersion to be bumped');
  });

  it('runs an INCREMENTAL sync when only the incremental schedule matches', async () => {
    // parseCron('0 */4 * * *') → minute=[0], hour=[0,4,8,12,16,20].
    // 04:00:00Z matches incremental (04:00 ∈ step hours) but NOT full (hour != 3).
    queueOnePackageFetches();
    await cronTick(new Date('2024-01-15T04:00:00Z'));
    const result = getLastSyncResult();
    assert.ok(result, 'expected a sync to have run');
    assert.equal(result!.mode, 'incremental');
  });

  it('runs no sync when neither schedule matches (minute != 0)', async () => {
    // 04:30:00Z → minute=30, doesn't match either schedule
    queueOnePackageFetches();
    await cronTick(new Date('2024-01-15T04:30:00Z'));
    assert.equal(getLastSyncResult(), null, 'expected no sync to run');
    assert.equal(getSyncVersion(), 0);
    assert.equal(mockFetch.mock.calls.length, 0, 'expected no fetch calls');
  });

  it('does not re-run a full sync in the same minute (dedup)', async () => {
    queueOnePackageFetches();
    const date = new Date('2024-01-15T03:00:00Z');
    await cronTick(date);
    assert.equal(getLastSyncResult()!.mode, 'full');
    const versionAfterFirst = getSyncVersion();

    // Second tick in the same minute → deduped, no new fetch calls
    mockFetch.mockClear();
    await cronTick(date);
    assert.equal(getSyncVersion(), versionAfterFirst, 'versionshould not bump on a deduped tick');
    assert.equal(mockFetch.mock.calls.length, 0, 'expected no fetch calls on deduped tick');
  });

  it('does not re-run an incremental sync in the same minute (dedup)', async () => {
    queueOnePackageFetches();
    const date = new Date('2024-01-15T04:00:00Z');
    await cronTick(date);
    assert.equal(getLastSyncResult()!.mode, 'incremental');
    const versionAfterFirst = getSyncVersion();

    mockFetch.mockClear();
    await cronTick(date);
    assert.equal(getSyncVersion(), versionAfterFirst);
    assert.equal(mockFetch.mock.calls.length, 0);
  });

  it('runs a sync in a different minute even after one already ran', async () => {
    // 03:00 full sync
    queueOnePackageFetches();
    await cronTick(new Date('2024-01-15T03:00:00Z'));
    assert.equal(getLastSyncResult()!.mode, 'full');

    // 04:00 incremental sync — different cronTriggerKey → allowed
    queueOnePackageFetches();
    await cronTick(new Date('2024-01-15T04:00:00Z'));
    assert.equal(getLastSyncResult()!.mode, 'incremental');
    assert.ok(getSyncVersion() >= 2, 'expected version bumped by both syncs');
  });

  it('handles sync failures without leaving isRunning stuck', async () => {
    // Make the search API return a non-OK response (4xx, no retry)
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: { get: () => null },
    });
    await cronTick(new Date('2024-01-15T03:00:00Z'));
    // Failure path: isRunning was reset, no lastSyncResult, version unchanged
    assert.equal(isSyncRunning(), false, 'isRunning should be reset after failure');
    assert.equal(getLastSyncResult(), null);
    assert.equal(getSyncVersion(), 0);
  });
});
