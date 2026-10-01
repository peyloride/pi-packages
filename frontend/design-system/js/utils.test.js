import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, sanitizeUrl, formatNumber, timeAgo } from './utils.js';

// These helpers guard against stored XSS in the package cards: every npm-sourced
// field (description, name, publisher, URLs) flows through them before being
// interpolated into innerHTML / href. They are pure (no DOM) so they run under
// plain node:test.

describe('escapeHtml', () => {
  it('neutralizes the classic stored-XSS payload', () => {
    assert.equal(
      escapeHtml('<img src=x onerror=alert(1)>'),
      '&lt;img src=x onerror=alert(1)&gt;',
    );
  });

  it('escapes a real registry payload (raw HTML description)', () => {
    // pi-intercom ships its description as literal HTML; it must render inert.
    assert.equal(
      escapeHtml('<p> <img src="banner.png"> </p>'),
      '&lt;p&gt; &lt;img src=&quot;banner.png&quot;&gt; &lt;/p&gt;',
    );
  });

  it('escapes ampersand, double quote, and single quote (attribute-safe)', () => {
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
    assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;');
    assert.equal(escapeHtml("O'Brien"), 'O&#39;Brien');
  });

  it('returns empty string for null/undefined and coerces numbers', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(42), '42');
  });

  it('leaves plain text unchanged', () => {
    assert.equal(escapeHtml('just a description'), 'just a description');
  });
});

describe('sanitizeUrl', () => {
  it('allows http, https, mailto, and relative refs', () => {
    assert.equal(sanitizeUrl('https://github.com/u/r'), 'https://github.com/u/r');
    assert.equal(sanitizeUrl('http://example.com'), 'http://example.com');
    assert.equal(sanitizeUrl('mailto:a@b.com'), 'mailto:a@b.com');
    assert.equal(sanitizeUrl('/local/path'), '/local/path');
    assert.equal(sanitizeUrl('#anchor'), '#anchor');
    assert.equal(sanitizeUrl('./rel.js'), './rel.js');
  });

  it('neutralizes javascript:/data:/vbscript:/file: schemes', () => {
    assert.equal(sanitizeUrl('javascript:alert(1)'), '#');
    assert.equal(sanitizeUrl('JaVaScRiPt:alert(1)'), '#');
    assert.equal(sanitizeUrl('data:text/html,<script>alert(1)</script>'), '#');
    assert.equal(sanitizeUrl('vbscript:msgbox(1)'), '#');
    assert.equal(sanitizeUrl('file:///etc/passwd'), '#');
  });

  it('neutralizes non-http transport schemes the registry stores (ssh/git)', () => {
    assert.equal(sanitizeUrl('ssh://git@github.com/u/r'), '#');
    assert.equal(sanitizeUrl('git://github.com/u/r'), '#');
  });

  it('returns # for null/empty input', () => {
    assert.equal(sanitizeUrl(null), '#');
    assert.equal(sanitizeUrl(undefined), '#');
    assert.equal(sanitizeUrl(''), '#');
  });
});

describe('formatNumber', () => {
  it('formats compact magnitudes', () => {
    assert.equal(formatNumber(1500000), '1.5M');
    assert.equal(formatNumber(3500), '3.5K');
    assert.equal(formatNumber(999), '999');
  });

  it('rounds up into M instead of printing 1000.0K', () => {
    assert.equal(formatNumber(999950), '1.0M');
    assert.equal(formatNumber(999999), '1.0M');
    assert.equal(formatNumber(999949), '999.9K');
  });

  it('returns — for null/undefined/NaN', () => {
    assert.equal(formatNumber(null), '—');
    assert.equal(formatNumber(undefined), '—');
    assert.equal(formatNumber(NaN), '—');
  });
});

describe('timeAgo', () => {
  it('formats relative times', () => {
    const now = Date.now();
    assert.equal(timeAgo(new Date(now - 30000).toISOString()), 'just now');
    assert.equal(timeAgo(new Date(now - 5 * 60000).toISOString()), '5m ago');
    assert.equal(timeAgo(new Date(now - 3 * 3600000).toISOString()), '3h ago');
  });

  it('returns empty string for unparseable input (no "NaNy ago")', () => {
    assert.equal(timeAgo('not a date'), '');
    assert.equal(timeAgo('undefined'), '');
  });

  it('returns empty string for missing input', () => {
    assert.equal(timeAgo(''), '');
    assert.equal(timeAgo(null), '');
    assert.equal(timeAgo(undefined), '');
  });
});
