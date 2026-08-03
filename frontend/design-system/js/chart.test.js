import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderBars, escapeHtml, sanitizeUrl } from './utils.js';

/**
 * Minimal DOM shim — the project has no jsdom; tests run under plain
 * node:test. utils.js is DOM-free except renderBars, which only needs
 * document.createElementNS + basic El methods. This shim covers exactly
 * what renderBars touches.
 */
class FakeEl {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attrs = {};
    this.classList = {
      add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false,
    };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener() {}
}

function shimDocument() {
  globalThis.document = {
    createElementNS: (ns, tag) => new FakeEl(tag),
  };
}

shimDocument();

describe('renderBars', () => {
  it('renders one bar per data point, scaled to max', () => {
    const container = new FakeEl('div');
    const data = [
      { date: '2026-06-01', downloads: 100 },
      { date: '2026-06-02', downloads: 50 },
      { date: '2026-06-03', downloads: 0 },
    ];
    const svg = renderBars(container, data, { height: 100 });
    assert.equal(svg.tagName, 'svg');
    assert.equal(svg.children.length, 3);
    // Max bar sits at y=0
    assert.equal(svg.children[0].attrs.y, '0');
    assert.ok(Number(svg.children[1].attrs.y) > 0);
    assert.ok(Number(svg.children[2].attrs.y) > 0);
    // Titles carry date + count
    assert.equal(svg.children[0].attrs.title, '2026-06-01: 100 downloads');
  });

  it('handles empty data with no bars', () => {
    const container = new FakeEl('div');
    const svg = renderBars(container, [], { height: 100 });
    assert.equal(svg.children.length, 0);
  });

  it('handles all-zero data without NaN/infinite geometry', () => {
    const container = new FakeEl('div');
    const data = [
      { date: '2026-06-01', downloads: 0 },
      { date: '2026-06-02', downloads: 0 },
    ];
    const svg = renderBars(container, data, { height: 100 });
    svg.children.forEach((rect) => {
      assert.ok(!Number.isNaN(parseFloat(rect.attrs.y)));
      assert.ok(!Number.isNaN(parseFloat(rect.attrs.height)));
    });
  });

  it('treats missing downloads as 0', () => {
    const container = new FakeEl('div');
    const svg = renderBars(container, [{ date: '2026-06-01' }]);
    assert.equal(svg.children[0].attrs.title, '2026-06-01: 0 downloads');
  });
});

// Sanity: the modal relies on the XSS helpers — keep the guard visible here.
describe('modal XSS contract (escapeHtml + sanitizeUrl)', () => {
  it('escapes npm-sourced strings before innerHTML use', () => {
    assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(escapeHtml('"> <script>alert(1)</script>'), '&quot;&gt; &lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('neutralizes unsafe hrefs', () => {
    assert.equal(sanitizeUrl('javascript:alert(1)'), '#');
    assert.equal(sanitizeUrl('data:text/html,<script>1</script>'), '#');
  });
});
