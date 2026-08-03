import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getFreshness, formatStaleLabel, NEW_DAYS, STALE_DAYS } from './freshness.js';

// Freshness classification is fully deterministic: `now` is injected and the
// relative-time formatter is stubbed, so these tests run under plain
// node:test with no DOM and no clock dependence.

const NOW = new Date('2026-08-01T12:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

// Stub formatter that echoes the input so assertions focus on the label
// plumbing, not on timeAgo's own behavior (covered by utils tests).
const stubTimeAgo = (d) => `[${d}]`;

describe('getFreshness — NEW badge (first_seen within 14 days, inclusive)', () => {
  it('classifies a package first seen 5 days ago as new', () => {
    const r = getFreshness(NOW, iso(NOW - 5 * DAY), null);
    assert.equal(r.isNew, true);
  });

  it('classifies a package first seen 60 days ago as not new', () => {
    const r = getFreshness(NOW, iso(NOW - 60 * DAY), null);
    assert.equal(r.isNew, false);
  });

  it('treats the 14-day boundary as inclusive (exactly 14 days → new)', () => {
    const r = getFreshness(NOW, iso(NOW - 14 * DAY), null);
    assert.equal(r.isNew, true);
  });

  it('treats just past the 14-day boundary as not new', () => {
    const r = getFreshness(NOW, iso(NOW - 14 * DAY - 1), null);
    assert.equal(r.isNew, false);
  });

  it('missing first_seen → not new, no throw', () => {
    assert.equal(getFreshness(NOW, null, null).isNew, false);
    assert.equal(getFreshness(NOW, undefined, null).isNew, false);
    assert.equal(getFreshness(NOW, '', null).isNew, false);
  });

  it('unparseable first_seen → not new, no throw', () => {
    assert.equal(getFreshness(NOW, 'not-a-date', null).isNew, false);
  });

  it('future first_seen → new (defensive clock skew)', () => {
    const r = getFreshness(NOW, iso(NOW + 2 * DAY), null);
    assert.equal(r.isNew, true);
  });

  it('respects a custom newDays option', () => {
    const r = getFreshness(NOW, iso(NOW - 20 * DAY), null, stubTimeAgo, { newDays: 21 });
    assert.equal(r.isNew, true);
    const r2 = getFreshness(NOW, iso(NOW - 20 * DAY), null, stubTimeAgo, { newDays: 19 });
    assert.equal(r2.isNew, false);
  });
});

describe('getFreshness — stale indicator (last_publish older than 30 days, inclusive)', () => {
  it('classifies a package last published 45 days ago as stale', () => {
    const r = getFreshness(NOW, null, iso(NOW - 45 * DAY));
    assert.equal(r.isStale, true);
  });

  it('classifies a package last published 2 days ago as not stale', () => {
    const r = getFreshness(NOW, null, iso(NOW - 2 * DAY));
    assert.equal(r.isStale, false);
  });

  it('treats the 30-day boundary as inclusive (exactly 30 days → stale)', () => {
    const r = getFreshness(NOW, null, iso(NOW - 30 * DAY));
    assert.equal(r.isStale, true);
  });

  it('treats just under the 30-day boundary as not stale', () => {
    const r = getFreshness(NOW, null, iso(NOW - 30 * DAY + 1));
    assert.equal(r.isStale, false);
  });

  it('missing last_publish → not stale, no throw', () => {
    assert.equal(getFreshness(NOW, null, null).isStale, false);
    assert.equal(getFreshness(NOW, null, undefined).isStale, false);
    assert.equal(getFreshness(NOW, null, '').isStale, false);
  });

  it('unparseable last_publish → not stale, no throw', () => {
    assert.equal(getFreshness(NOW, null, 'garbage').isStale, false);
  });

  it('future last_publish → never stale (defensive)', () => {
    const r = getFreshness(NOW, null, iso(NOW + 10 * DAY));
    assert.equal(r.isStale, false);
  });

  it('respects a custom staleDays option', () => {
    const r = getFreshness(NOW, null, iso(NOW - 40 * DAY), stubTimeAgo, { staleDays: 45 });
    assert.equal(r.isStale, false);
    const r2 = getFreshness(NOW, null, iso(NOW - 40 * DAY), stubTimeAgo, { staleDays: 39 });
    assert.equal(r2.isStale, true);
  });
});

describe('getFreshness — updatedLabel', () => {
  it('uses the injected timeAgo formatter for the label', () => {
    const lastPublish = iso(NOW - 45 * DAY);
    const r = getFreshness(NOW, null, lastPublish, stubTimeAgo);
    assert.equal(r.updatedLabel, `[${lastPublish}]`);
  });

  it('returns empty label when last_publish is missing', () => {
    assert.equal(getFreshness(NOW, null, null, stubTimeAgo).updatedLabel, '');
  });
});

describe('getFreshness — combined classification', () => {
  it('can be new AND stale simultaneously (seen 5d ago, last publish 40d ago)', () => {
    const r = getFreshness(NOW, iso(NOW - 5 * DAY), iso(NOW - 40 * DAY), stubTimeAgo);
    assert.deepEqual({ isNew: r.isNew, isStale: r.isStale }, { isNew: true, isStale: true });
  });
});

describe('formatStaleLabel', () => {
  it('prefixes the relative time with "updated "', () => {
    assert.equal(formatStaleLabel('2026-06-01T00:00:00Z', stubTimeAgo), 'updated [2026-06-01T00:00:00Z]');
  });

  it('defaults to the real timeAgo formatter when none injected', () => {
    const label = formatStaleLabel(new Date(NOW - 45 * DAY).toISOString());
    assert.match(label, /^updated /);
    assert.match(label, /ago$/);
  });
});

describe('exported constants', () => {
  it('documents the default windows', () => {
    assert.equal(NEW_DAYS, 14);
    assert.equal(STALE_DAYS, 30);
  });
});
