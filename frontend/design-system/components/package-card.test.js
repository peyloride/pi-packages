import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PackageCard } from './package-card.js';

/**
 * Minimal DOM shim for PackageCard tests (same pattern as
 * package-detail-modal.test.js — plain node:test, no jsdom). The card only
 * needs createElement, innerHTML parsing (we don't parse, we check the
 * article's innerHTML string), classList, querySelector/All, and events.
 */

class FakeHTMLElement {}
globalThis.HTMLElement = FakeHTMLElement;

class FakeEl extends FakeHTMLElement {
  constructor(tagName) {
    super();
    this.tagName = (tagName || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._attrs = {};
    this.style = {};
    this._listeners = {};
    this._classes = [];
    this.classList = {
      add: (...c) => { this._classes.push(...c); },
      remove: (...c) => { this._classes = this._classes.filter(x => !c.includes(x)); },
      toggle: (c, force) => {
        const has = this._classes.includes(c);
        if (force === undefined) { if (has) this._classes = this._classes.filter(x => x !== c); else this._classes.push(c); }
        else if (force) { if (!has) this._classes.push(c); }
        else this._classes = this._classes.filter(x => x !== c);
      },
      contains: (c) => this._classes.includes(c),
    };
    this._textContent = '';
    this._innerHTML = '';
  }

  get className() { return (this._classes || []).join(' '); }
  set className(v) { this._classes = String(v).split(/\s+/).filter(Boolean); }

  get textContent() { return this._textContent; }
  set textContent(v) { this._textContent = String(v); this._innerHTML = ''; this.children = []; }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) {
    this._innerHTML = String(v);
    this._textContent = '';
    // Minimal parse: split top-level tags into children so querySelector
    // (.copy-btn, .install-cmd, .package-name, ...) works for event binding.
    this.children = [];
    const re = /<([a-zA-Z0-9-]+)([^>]*)>([\s\S]*?)<\/\1>/g;
    let m;
    while ((m = re.exec(this._innerHTML))) {
      const el = new FakeEl(m[1]);
      const attrs = m[2] || '';
      const cls = attrs.match(/class=\"([^\"]*)\"/);
      if (cls) el._classes = cls[1].split(/\s+/).filter(Boolean);
      const idm = attrs.match(/id=\"([^\"]*)\"/);
      if (idm) el._attrs.id = idm[1];
      const hrefm = attrs.match(/href=\"([^\"]*)\"/);
      if (hrefm) el._attrs.href = hrefm[1];
      // Recurse for nested children
      const inner = m[3];
      const innerEl = new FakeEl(m[1]);
      innerEl._innerHTML = inner;
      innerEl._textContent = inner.replace(/<[^>]*>/g, '');
      el._innerHTML = inner;
      el._textContent = inner.replace(/<[^>]*>/g, '');
      // rebuild children from the fragment via the same parser
      const frag = new FakeEl('div');
      frag.innerHTML = inner;
      el.children = frag.children;
      for (const c of el.children) c.parentNode = el;
      this.children.push(el);
    }
  }

  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k] !== undefined ? this._attrs[k] : null; }
  removeAttribute(k) { delete this._attrs[k]; }

  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach(c => this.appendChild(c)); }

  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.parentNode = null; } }

  addEventListener(t, fn) { this._listeners[t] = this._listeners[t] || []; this._listeners[t].push(fn); }
  removeEventListener(t, fn) { this._listeners[t] = (this._listeners[t] || []).filter(f => f !== fn); }

  querySelector(sel) { return this._query(sel, false); }
  querySelectorAll(sel) { return this._query(sel, true); }

  _query(sel, all) {
    const results = [];
    const matches = (el) => {
      if (sel.startsWith('.')) return (el._classes || []).includes(sel.slice(1));
      return el.tagName === sel.toUpperCase();
    };
    const walk = (el) => {
      for (const c of el.children || []) {
        if (matches(c)) results.push(c);
        walk(c);
      }
    };
    walk(this);
    return all ? results : results[0] || null;
  }
}

globalThis.document = {
  body: new FakeEl('body'),
  activeElement: null,
  createElement: (tag) => new FakeEl(tag),
  createElementNS: (ns, tag) => new FakeEl(tag),
};

// The card renders its HTML via innerHTML string; querySelector on the shim
// works on children, but innerHTML assignment doesn't parse into children.
// So for the card we assert on the innerHTML string (the XSS-escaped output).
function cardHtml(data, options = {}) {
  const card = new PackageCard(data, options);
  return card.element.innerHTML;
}

describe('PackageCard (github stars)', () => {
  it('renders a star count next to the GitHub link when github.stars > 0', () => {
    const html = cardHtml({
      name: 'pi-stars',
      description: 'x',
      github_url: 'https://github.com/owner/repo',
      github: { stars: 1234 },
    });
    // formatNumber(1234) → "1.2K" (compacted util)
    assert.ok(html.includes('card-stars'), 'star span present');
    assert.ok(html.includes('★ 1.2K'), 'formatted star count present');
    assert.ok(html.includes('link-github'), 'github link still present');
  });

  it('renders no star count when github is null', () => {
    const html = cardHtml({
      name: 'pi-plain',
      description: 'x',
      github_url: 'https://github.com/owner/repo',
    });
    assert.ok(!html.includes('card-stars'), 'no star span expected');
    assert.ok(html.includes('link-github'), 'github link still present');
  });

  it('renders no star count when showStars is false', () => {
    const html = cardHtml({
      name: 'pi-hide',
      description: 'x',
      github_url: 'https://github.com/owner/repo',
      github: { stars: 1234 },
    }, { showStars: false });
    assert.ok(!html.includes('card-stars'), 'no star span when disabled');
  });

  it('renders no star count for stars of 0', () => {
    const html = cardHtml({
      name: 'pi-zero',
      description: 'x',
      github_url: 'https://github.com/owner/repo',
      github: { stars: 0 },
    });
    assert.ok(!html.includes('card-stars'), 'no star span for 0 stars');
  });

  it('retains the NEW badge and stale chip behavior alongside stars', () => {
    const recentFirstSeen = new Date(Date.now() - 2 * 86400000).toISOString();
    const html = cardHtml({
      name: 'pi-combo',
      description: 'x',
      github_url: 'https://github.com/owner/repo',
      github: { stars: 42 },
      first_seen: recentFirstSeen,
      last_publish: new Date().toISOString(),
    });
    assert.ok(html.includes('badge-new'), 'NEW badge still renders');
    assert.ok(html.includes('★ 42'), 'star count renders');
  });
});
