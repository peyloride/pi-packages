import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openPackageDetailModal } from './package-detail-modal.js';
/**
 * Minimal DOM shim for modal tests. The project runs frontend tests under
 * plain node:test (no jsdom). The modal only needs:
 *   - document.createElement / createElementNS / body.appendChild
 *   - element.append/appendChild, querySelector/querySelectorAll
 *   - classList, set/getAttribute, addEventListener, focus, remove
 * The shim implements just enough for the modal's structure + event wiring.
 */

function makeClassList(el) {
  return {
    add: (...c) => { el._classes = el._classes || []; el._classes.push(...c); },
    remove: (...c) => { el._classes = (el._classes || []).filter(x => !c.includes(x)); },
    toggle: (c, force) => {
      el._classes = el._classes || [];
      const has = el._classes.includes(c);
      if (force === undefined) { if (has) el._classes = el._classes.filter(x => x !== c); else el._classes.push(c); }
      else if (force) { if (!has) el._classes.push(c); }
      else el._classes = el._classes.filter(x => x !== c);
    },
    contains: (c) => (el._classes || []).includes(c),
  };
}

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
    this.classList = makeClassList(this);
    this._textContent = '';
    this._innerHTML = '';
  }

  get className() { return (this._classes || []).join(' '); }
  set className(v) { this._classes = String(v).split(/\s+/).filter(Boolean); }

  get id() { return this._attrs.id || ''; }
  set id(v) { this._attrs.id = v; }

  get textContent() { return this._textContent; }
  set textContent(v) { this._textContent = String(v); this._innerHTML = ''; this.children = []; }

  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = String(v); this._textContent = ''; this.children = []; }

  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k] !== undefined ? this._attrs[k] : null; }
  removeAttribute(k) { delete this._attrs[k]; }

  setAttributeNS(_, k, v) { this.setAttribute(k, v); }

  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach(c => this.appendChild(c)); }

  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.parentNode = null; } }

  addEventListener(type, fn) { this._listeners[type] = this._listeners[type] || []; this._listeners[type].push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter(f => f !== fn); }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    ev.preventDefault = ev.preventDefault || (() => {});
    (this._listeners[ev.type] || []).slice().forEach(fn => fn(ev));
    return true;
  }
  focus() { document.activeElement = this; }

  querySelector(sel) { return this._query(sel, false); }
  querySelectorAll(sel) { return this._query(sel, true); }

  _query(sel, all) {
    // Support a tiny subset: tag name, .class
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
    if (sel.startsWith('.')) {
      // class selectors only on direct children for our purposes — but walk
      // already covers descendants
    }
    return all ? results : results[0] || null;
  }
}


const fakeBody = new FakeEl('body');

globalThis.document = {
  body: fakeBody,
  activeElement: null,
  createElement: (tag) => new FakeEl(tag),
  createElementNS: (ns, tag) => new FakeEl(tag),
  _listeners: {},
  addEventListener(type, fn) { this._listeners[type] = this._listeners[type] || []; this._listeners[type].push(fn); },
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter(f => f !== fn); },
  dispatchEvent(ev) { ev.target = ev.target || this; ev.preventDefault = ev.preventDefault || (() => {}); (this._listeners[ev.type] || []).slice().forEach(fn => fn(ev)); return true; },
};

globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };

// Node has no HTMLElement; the component guards `previousFocus instanceof
// HTMLElement`. Provide a minimal class our fake elements inherit from.

function stubFetch(response) {
  return async () => response;
}

const SAMPLE_PKG = {
  name: 'pi-dgoal',
  description: 'Pi extension for durable goal loops.',
  version: '0.5.3',
  keywords: ['pi', 'goal', 'loop'],
  publisher: 'diwu507',
  github_url: 'https://github.com/diwu507/pi-dgoal',
  npm_url: 'https://www.npmjs.com/package/pi-dgoal',
  first_seen: '2026-06-23T04:12:53.479Z',
  last_publish: '2026-06-29T16:51:20.824Z',
  daily_downloads: 10,
  weekly_downloads: 55,
  monthly_downloads: 220,
  growth: 12.5,
  download_history: [
    { date: '2026-06-01', downloads: 10 },
    { date: '2026-06-02', downloads: 12 },
  ],
};

const SAMPLE_PKG_WITH_GITHUB = {
  ...SAMPLE_PKG,
  github: {
    stars: 1234,
    forks: 56,
    open_issues: 7,
    license: 'MIT',
    archived: false,
    pushed_at: '2026-06-01T00:00:00Z',
  },
};

function okResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

describe('openPackageDetailModal', () => {
  function resetDom() {
    fakeBody.children = [];
    document.activeElement = null;
  }

  it('renders loading then full detail on success', async () => {
    resetDom();
    let resolveFetch;
    const fetchFn = () => new Promise((r) => { resolveFetch = r; });
    const handle = openPackageDetailModal({ name: 'pi-dgoal', fetchFn });

    // Loading state visible
    const overlay = fakeBody.children[0];
    assert.ok(overlay);
    assert.equal(overlay.className.includes('modal-overlay'), true);

    // Resolve with data
    resolveFetch(okResponse(SAMPLE_PKG));
    await new Promise((r) => setTimeout(r, 0));

    const body = overlay.querySelector('.modal-body');
    assert.ok(body);
    // Description present
    assert.ok(body.querySelector('.modal-description'));
    // Keywords tags
    assert.ok(body.querySelectorAll('.modal-tag').length >= 1);
    // Stats
    assert.ok(body.querySelector('.modal-stat'));
    // Install command text
    const installCmd = body.querySelector('.install-cmd');
    assert.equal(installCmd.textContent, 'pi install npm:pi-dgoal');
    // Chart svg rendered
    const chartSvg = body.querySelector('svg');
    assert.ok(chartSvg || body.querySelector('.modal-chart'));
  });

  it('shows error state with retry on HTTP 500', async () => {
    resetDom();
    let callCount = 0;
    const fetchFn = async () => {
      callCount += 1;
      if (callCount === 1) return okResponse(null, 500);
      return okResponse(SAMPLE_PKG);
    };
    const handle = openPackageDetailModal({ name: 'pi-dgoal', fetchFn });
    await new Promise((r) => setTimeout(r, 0));

    const overlay = fakeBody.children[0];
    const body = overlay.querySelector('.modal-body');
    assert.ok(body.querySelector('.modal-error'));
    assert.ok(body.querySelector('.retry-btn'));

    // Retry succeeds
    body.querySelector('.retry-btn').dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(body.querySelector('.modal-description'));
    assert.equal(callCount, 2);
  });

  it('shows not-found state on 404', async () => {
    resetDom();
    const fetchFn = async () => okResponse(null, 404);
    const handle = openPackageDetailModal({ name: 'nope', fetchFn });
    await new Promise((r) => setTimeout(r, 0));

    const overlay = fakeBody.children[0];
    const body = overlay.querySelector('.modal-body');
    assert.ok(body.querySelector('.modal-empty'));
  });

  it('shows error on network failure', async () => {
    resetDom();
    const fetchFn = async () => { throw new Error('network down'); };
    const handle = openPackageDetailModal({ name: 'pi-dgoal', fetchFn });
    await new Promise((r) => setTimeout(r, 0));

    const overlay = fakeBody.children[0];
    const body = overlay.querySelector('.modal-body');
    assert.ok(body.querySelector('.modal-error'));
  });

  it('closes on Escape and triggers onClose', async () => {
    resetDom();
    let closed = false;
    const handle = openPackageDetailModal({
      name: 'pi-dgoal',
      fetchFn: () => Promise.resolve(okResponse(SAMPLE_PKG)),
      onClose: () => { closed = true; },
    });
    await new Promise((r) => setTimeout(r, 0));

    document.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(closed, true);
    assert.equal(fakeBody.children.length, 0); // removed from DOM
  });

  it('closes via programmatic close() and removes backdrop listener', async () => {
    resetDom();
    const handle = openPackageDetailModal({
      name: 'pi-dgoal',
      fetchFn: () => Promise.resolve(okResponse(SAMPLE_PKG)),
    });
    await new Promise((r) => setTimeout(r, 0));
    handle.close();
    assert.equal(fakeBody.children.length, 0);
  });

  it('closes when backdrop (overlay itself) is clicked', async () => {
    resetDom();
    let closed = false;
    const handle = openPackageDetailModal({
      name: 'pi-dgoal',
      fetchFn: () => Promise.resolve(okResponse(SAMPLE_PKG)),
      onClose: () => { closed = true; },
    });
    await new Promise((r) => setTimeout(r, 0));

    const overlay = fakeBody.children[0];
    overlay.dispatchEvent({ type: 'click', target: overlay });
    assert.equal(closed, true);
    assert.equal(fakeBody.children.length, 0);
  });

  it('does not close when clicking inside the dialog', async () => {
    resetDom();
    let closed = false;
    const handle = openPackageDetailModal({
      name: 'pi-dgoal',
      fetchFn: () => Promise.resolve(okResponse(SAMPLE_PKG)),
      onClose: () => { closed = true; },
    });
    await new Promise((r) => setTimeout(r, 0));

    const overlay = fakeBody.children[0];
    const dialog = overlay.children[0];
    // Click event target is the dialog, not overlay
    overlay.dispatchEvent({ type: 'click', target: dialog });
    assert.equal(closed, false);
  });

  it('renders a GitHub stats strip when github metadata is present', async () => {
    resetDom();
    const handle = openPackageDetailModal({
      name: 'pi-dgoal',
      fetchFn: () => Promise.resolve(okResponse(SAMPLE_PKG_WITH_GITHUB)),
    });
    await new Promise((r) => setTimeout(r, 0));

    const overlay = fakeBody.children[0];
    const body = overlay.querySelector('.modal-body');
    const strip = body.querySelector('.github-strip');
    assert.ok(strip, 'github-strip should render');

    const values = strip.querySelectorAll('.gh-stat-value').map((el) => el.textContent);
    assert.ok(values.some((v) => v.includes('1.2K')));    // stars formatted (formatNumber compacts >1k)
    assert.ok(values.some((v) => v.includes('56')));       // forks
    assert.ok(values.some((v) => v.includes('7')));        // open issues
    assert.ok(strip.querySelector('.license-chip'));       // license chip
    assert.equal(strip.querySelector('.license-chip').textContent, 'MIT');
    assert.equal(strip.querySelector('.archived-badge'), null); // not archived
  });

  it('renders no github strip when github is null', async () => {
    resetDom();
    const handle = openPackageDetailModal({
      name: 'pi-dgoal',
      fetchFn: () => Promise.resolve(okResponse(SAMPLE_PKG)), // no github field
    });
    await new Promise((r) => setTimeout(r, 0));

    const overlay = fakeBody.children[0];
    const body = overlay.querySelector('.modal-body');
    assert.equal(body.querySelector('.github-strip'), null);
    // Everything else still renders
    assert.ok(body.querySelector('.modal-description'));
    assert.ok(body.querySelector('.modal-stat'));
  });

  it('shows an archived warning badge when github.archived is true', async () => {
    resetDom();
    const archivedPkg = {
      ...SAMPLE_PKG_WITH_GITHUB,
      github: { ...SAMPLE_PKG_WITH_GITHUB.github, archived: true },
    };
    const handle = openPackageDetailModal({
      name: 'pi-dgoal',
      fetchFn: () => Promise.resolve(okResponse(archivedPkg)),
    });
    await new Promise((r) => setTimeout(r, 0));

    const overlay = fakeBody.children[0];
    const body = overlay.querySelector('.modal-body');
    const badge = body.querySelector('.archived-badge');
    assert.ok(badge);
    assert.equal(badge.textContent, 'ARCHIVED');
  });
});
