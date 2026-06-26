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
} from './cron';
import { getDb } from './db';

describe('cron.ts', () => {
  describe('parseCron', () => {
    it('should parse standard cron expression', () => {
      const schedule = parseCron('0 3 * * *');
      assert.equal(schedule.minute, 0);
      assert.equal(schedule.hour, 3);
      assert.equal(schedule.dayOfMonth, '*');
      assert.equal(schedule.month, '*');
      assert.equal(schedule.dayOfWeek, '*');
    });

    it('should parse cron with wildcard hour', () => {
      const schedule = parseCron('0 * * * *');
      assert.equal(schedule.minute, 0);
      assert.equal(schedule.hour, '*');
    });

    it('should treat interval patterns as wildcards', () => {
      const schedule = parseCron('0 */4 * * *');
      assert.equal(schedule.minute, 0);
      assert.equal(schedule.hour, '*');  // */4 treated as wildcard
    });

    it('should parse cron with specific day', () => {
      const schedule = parseCron('30 14 15 * *');
      assert.equal(schedule.minute, 30);
      assert.equal(schedule.hour, 14);
      assert.equal(schedule.dayOfMonth, 15);
    });

    it('should throw on invalid cron expression', () => {
      assert.throws(() => parseCron('invalid'));
      assert.throws(() => parseCron('1 2'));
    });
  });

  describe('shouldRun', () => {
    it('should return true when all conditions match', () => {
      const schedule = { minute: 0, hour: 3, dayOfMonth: '*', month: '*', dayOfWeek: '*' };
      const date = new Date('2024-01-15T03:00:00Z');
      assert.equal(shouldRun(schedule, date), true);
    });

    it('should return false when minute does not match', () => {
      const schedule = { minute: 0, hour: 3, dayOfMonth: '*', month: '*', dayOfWeek: '*' };
      const date = new Date('2024-01-15T03:30:00Z');
      assert.equal(shouldRun(schedule, date), false);
    });

    it('should return false when hour does not match', () => {
      const schedule = { minute: 0, hour: 3, dayOfMonth: '*', month: '*', dayOfWeek: '*' };
      const date = new Date('2024-01-15T05:00:00Z');
      assert.equal(shouldRun(schedule, date), false);
    });

    it('should match wildcard conditions', () => {
      const schedule = { minute: '*', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' };
      const date = new Date('2024-01-15T15:30:00Z');
      assert.equal(shouldRun(schedule, date), true);
    });

    it('should match day of week', () => {
      const schedule = { minute: 0, hour: 3, dayOfMonth: '*', month: '*', dayOfWeek: 1 }; // Monday
      const monday = new Date('2024-01-15T03:00:00Z'); // Jan 15, 2024 is Monday
      assert.equal(shouldRun(schedule, monday), true);
    });
  });

  describe('getNextRunTime', () => {
    it('should return a Date object for fixed schedule', () => {
      // Default cron is '0 3 * * *' (3 AM UTC), so it should return a date
      const result = getNextRunTime();
      assert.ok(result instanceof Date);
    });

    it('should return next run time for fixed schedule', () => {
      // This depends on current time, but we can test the logic
      // by checking it returns a Date object
      const result = getNextRunTime();
      // Since default is 3 AM UTC, it should return a date
      if (result !== null) {
        assert.ok(result instanceof Date);
      }
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
    // parseCron('0 3 * * *') → minute=0, hour=3
    // 03:00:00Z matches both full ('0 3 * * *') and incremental ('0 */4...' → hourly at :00)
    // Full takes priority.
    queueOnePackageFetches();
    await cronTick(new Date('2024-01-15T03:00:00Z'));
    const result = getLastSyncResult();
    assert.ok(result, 'expected a sync to have run');
    assert.equal(result!.mode, 'full');
    assert.ok(getSyncVersion() > 0, 'expected syncVersion to be bumped');
  });

  it('runs an INCREMENTAL sync when only the incremental schedule matches', async () => {
    // parseCron('0 */4 * * *') → minute=0, hour='*' (*/4 is treated as wildcard)
    // 04:00:00Z matches incremental (minute=0) but NOT full (hour != 3)
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
