import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUrlState,
  buildUrlState,
  parsePackageHash,
  buildPackageHash,
  normalizeSort,
  normalizePeriod,
  normalizePage,
} from './url-state.js';

describe('parseUrlState', () => {
  it('parses a full query string with all params', () => {
    assert.deepEqual(
      parseUrlState('?sort=popular&period=daily&search=agent&p=2'),
      { sort: 'popular', period: 'daily', search: 'agent', page: 2 },
    );
  });

  it('accepts a URLSearchParams instance', () => {
    assert.deepEqual(
      parseUrlState(new URLSearchParams('sort=new&period=monthly&p=3')),
      { sort: 'new', period: 'monthly', search: '', page: 3 },
    );
  });

  it('returns defaults for empty / missing query', () => {
    assert.deepEqual(
      parseUrlState(''),
      { sort: 'trending', period: 'weekly', search: '', page: 1 },
    );
    assert.deepEqual(
      parseUrlState(undefined),
      { sort: 'trending', period: 'weekly', search: '', page: 1 },
    );
  });

  it('falls back to defaults for invalid sort/period/page without erroring', () => {
    assert.deepEqual(
      parseUrlState('?sort=evil&period=yesterday&search=x&p=abc'),
      { sort: 'trending', period: 'weekly', search: 'x', page: 1 },
    );
  });

  it('clamps page to >= 1 for zero, negative, and fractional values', () => {
    assert.equal(parseUrlState('?p=0').page, 1);
    assert.equal(parseUrlState('?p=-3').page, 1);
    assert.equal(parseUrlState('?p=2.9').page, 2);
  });

  it('trims search whitespace', () => {
    assert.equal(parseUrlState('?search=  agent  ').search, 'agent');
  });

  it('tolerates a leading ? in the raw query', () => {
    assert.equal(parseUrlState('sort=updated').sort, 'updated');
  });
});

describe('buildUrlState', () => {
  it('round-trips a full state', () => {
    const q = buildUrlState({ sort: 'popular', period: 'daily', search: 'agent', page: 2 });
    assert.equal(q, 'sort=popular&period=daily&search=agent&p=2');
    assert.deepEqual(parseUrlState(`?${q}`), { sort: 'popular', period: 'daily', search: 'agent', page: 2 });
  });

  it('omits default values from the URL', () => {
    assert.equal(buildUrlState({}), '');
    assert.equal(buildUrlState({ sort: 'trending', period: 'weekly', page: 1 }), '');
  });

  it('encodes special characters in search', () => {
    const q = buildUrlState({ search: 'a & b' });
    assert.ok(q.includes('search=a+%26+b') || q.includes('search=a%20%26%20b'));
  });
});

describe('normalizeSort / normalizePeriod / normalizePage', () => {
  it('normalizeSort accepts only the 4 valid sorts', () => {
    assert.equal(normalizeSort('popular'), 'popular');
    assert.equal(normalizeSort('trending'), 'trending');
    assert.equal(normalizeSort('garbage'), 'trending');
    assert.equal(normalizeSort(null), 'trending');
    assert.equal(normalizeSort(42), 'trending');
  });

  it('normalizePeriod accepts only the 3 valid periods', () => {
    assert.equal(normalizePeriod('monthly'), 'monthly');
    assert.equal(normalizePeriod('daily'), 'daily');
    assert.equal(normalizePeriod('weekly'), 'weekly');
    assert.equal(normalizePeriod('hourly'), 'weekly');
  });

  it('normalizePage coerces and clamps', () => {
    assert.equal(normalizePage('4'), 4);
    assert.equal(normalizePage('abc'), 1);
    assert.equal(normalizePage(''), 1);
    assert.equal(normalizePage(null), 1);
    assert.equal(normalizePage('0'), 1);
    assert.equal(normalizePage('-1'), 1);
    assert.equal(normalizePage('1.7'), 1);
  });
});

describe('parsePackageHash / buildPackageHash', () => {
  it('parses a valid package hash', () => {
    assert.equal(parsePackageHash('#/pkg/pi-dgoal'), 'pi-dgoal');
  });

  it('returns null for non-package hashes and empty input', () => {
    assert.equal(parsePackageHash(''), null);
    assert.equal(parsePackageHash('#/other'), null);
    assert.equal(parsePackageHash('https://example.com'), null);
    assert.equal(parsePackageHash(null), null);
  });

  it('builds a hash that round-trips', () => {
    assert.equal(buildPackageHash('pi-dgoal'), '#/pkg/pi-dgoal');
    assert.equal(parsePackageHash(buildPackageHash('@scope/pkg')), '@scope/pkg');
  });
});
