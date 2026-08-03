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
    // renderLineArea adds x-axis label text via createTextNode.
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
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

// ═══════════════════════════════════════════════════════════════════
// buildLinePath / buildAreaPath / renderLineArea — pure geometry
// ═══════════════════════════════════════════════════════════════════

import { buildLinePath, buildAreaPath, renderLineArea } from './utils.js';

describe('buildLinePath', () => {
  it('returns empty string for fewer than 2 points', () => {
    assert.equal(buildLinePath([], 100, 50), '');
    assert.equal(buildLinePath([{ date: '2026-01-01', downloads: 5 }], 100, 50), '');
    assert.equal(buildLinePath(null, 100, 50), '');
  });

  it('maps values to a padded viewBox with 0 at the bottom edge', () => {
    const points = [
      { date: '2026-01-01', downloads: 0 },
      { date: '2026-01-02', downloads: 100 },
    ];
    const d = buildLinePath(points, 100, 50, 4);
    // First point (value 0) sits on the bottom edge: y = height - pad... but
    // we anchor 0 to the bottom of the inner area (y = pad + innerH).
    const tokens = d.split(' ');
    // "M4 46" — 0 maps to pad + innerH = 4 + 42 = 46
    assert.equal(tokens[0], 'M4');
    assert.equal(tokens[1], '46');
    // "L96 4" — 100 maps to the top of the inner area (pad)
    assert.equal(tokens[2], 'L96');
    assert.equal(tokens[3], '4');
  });

  it('floors a flat zero series at max=1 so it still renders', () => {
    const points = [
      { date: '2026-01-01', downloads: 0 },
      { date: '2026-01-02', downloads: 0 },
    ];
    const d = buildLinePath(points, 100, 50);
    const tokens = d.split(' ');
    // value 0 / max(1) → y = pad + innerH = 4 + 42 = 46 for both
    assert.equal(tokens[1], '46');
    assert.equal(tokens[3], '46');
  });

  it('spaces x coordinates evenly across the padded width', () => {
    const points = [
      { date: '2026-01-01', downloads: 10 },
      { date: '2026-01-02', downloads: 10 },
      { date: '2026-01-03', downloads: 10 },
    ];
    const d = buildLinePath(points, 100, 50, 4).split(' ');
    // x positions: 4, 4 + 46, 4 + 92 → 4, 50, 96
    assert.equal(d[0], 'M4');
    assert.equal(d[2], 'L50');
    assert.equal(d[4], 'L96');
  });

  it('handles non-numeric downloads defensively (treated as 0)', () => {
    const points = [
      { date: '2026-01-01', downloads: 'oops' },
      { date: '2026-01-02', downloads: 50 },
    ];
    const d = buildLinePath(points, 100, 50);
    assert.ok(d.startsWith('M'));
    assert.ok(d.includes('L'));
  });
});

describe('buildAreaPath', () => {
  it('closes the line path back to the bottom edge', () => {
    const linePath = buildLinePath([
      { date: '2026-01-01', downloads: 0 },
      { date: '2026-01-02', downloads: 100 },
    ], 100, 50);
    const area = buildAreaPath(linePath, 100, 50);
    assert.ok(area.endsWith(' L100 50 L0 50 Z'));
  });

  it('returns empty string for an empty line path', () => {
    assert.equal(buildAreaPath('', 100, 50), '');
  });
});

describe('renderLineArea', () => {
  it('appends an empty SVG with role img for fewer than 2 points', () => {
    const container = new FakeEl('div');
    const svg = renderLineArea(container, []);
    assert.equal(svg.tagName, 'svg');
    assert.equal(svg.attrs.role, 'img');
    assert.equal(svg.children.length, 0);
  });

  it('renders line + area paths and sparse labels for a full series', () => {
    const container = new FakeEl('div');
    const points = [];
    for (let i = 0; i < 60; i++) {
      points.push({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, downloads: i });
    }
    const svg = renderLineArea(container, points, { labelEvery: 10 });
    const tags = svg.children.map((c) => c.tagName);
    assert.ok(tags.includes('path')); // area + line
    assert.ok(tags.includes('text')); // labels
    // labelEvery=10 → labels at indices 0,10,20,30,40,50 (6 labels)
    const labelCount = svg.children.filter((c) => c.tagName === 'text').length;
    assert.equal(labelCount, 6);
  });

  it('skips area when options.area is false', () => {
    const container = new FakeEl('div');
    const points = [
      { date: '2026-01-01', downloads: 1 },
      { date: '2026-01-02', downloads: 2 },
    ];
    const svg = renderLineArea(container, points, { area: false });
    const tags = svg.children.map((c) => c.tagName);
    assert.ok(tags.includes('path'));
    assert.equal(tags.filter((t) => t === 'path').length, 1);
  });
});
