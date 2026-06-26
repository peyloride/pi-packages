import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeAssetVersion, buildAssetCache } from './assets';

describe('assets.ts', () => {
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'assets-test-'));
    writeFileSync(join(tempDir, 'index.html'), '<html><script src="/app.js"></script><link href="/styles.css"></html>');
    writeFileSync(join(tempDir, 'app.js'), 'import { x } from "./utils.js";\nexport { x };');
    writeFileSync(join(tempDir, 'styles.css'), '@import "./base.css";\nbody { background: url("./bg.png"); }');
    writeFileSync(join(tempDir, 'utils.js'), 'export const x = 1;');
    writeFileSync(join(tempDir, 'base.css'), 'body { margin: 0; }');
    writeFileSync(join(tempDir, 'bg.png'), 'fake-png-data');
    writeFileSync(join(tempDir, 'data.json'), '{"key":"value"}');
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('computeAssetVersion', () => {
    it('returns a 10-character hex string', () => {
      const v = computeAssetVersion(tempDir);
      assert.equal(v.length, 10);
      assert.match(v, /^[0-9a-f]+$/);
    });

    it('is deterministic for unchanged files', () => {
      const v1 = computeAssetVersion(tempDir);
      const v2 = computeAssetVersion(tempDir);
      assert.equal(v1, v2);
    });

    it('changes when a file mtime is updated', () => {
      const v1 = computeAssetVersion(tempDir);
      const newTime = new Date(Date.now() + 10000);
      utimesSync(join(tempDir, 'app.js'), newTime, newTime);
      const v2 = computeAssetVersion(tempDir);
      assert.notEqual(v1, v2);
    });

    it('is stable when no files change between calls', () => {
      // Run several times; all should return the same value.
      const results = new Set<string>();
      for (let i = 0; i < 5; i++) results.add(computeAssetVersion(tempDir));
      assert.equal(results.size, 1);
    });
  });

  describe('buildAssetCache', () => {
    it('returns a map keyed by URL path for every file', () => {
      const cache = buildAssetCache(tempDir, 'v1');
      assert.ok(cache.has('/index.html'));
      assert.ok(cache.has('/app.js'));
      assert.ok(cache.has('/styles.css'));
      assert.ok(cache.has('/utils.js'));
      assert.ok(cache.has('/base.css'));
      assert.ok(cache.has('/bg.png'));
      assert.ok(cache.has('/data.json'));
    });

    it('sets correct content types by extension', () => {
      const cache = buildAssetCache(tempDir, 'v1');
      assert.equal(cache.get('/index.html')?.contentType, 'text/html; charset=utf-8');
      assert.equal(cache.get('/app.js')?.contentType, 'application/javascript; charset=utf-8');
      assert.equal(cache.get('/styles.css')?.contentType, 'text/css; charset=utf-8');
      assert.equal(cache.get('/bg.png')?.contentType, 'image/png');
      assert.equal(cache.get('/data.json')?.contentType, 'application/json; charset=utf-8');
    });

    it('stamps href/src references in HTML with ?v=', () => {
      const cache = buildAssetCache(tempDir, 'v123');
      const html = cache.get('/index.html')!.content;
      assert.ok(html.includes('/app.js?v=v123'), `expected stamped src, got: ${html}`);
      assert.ok(html.includes('/styles.css?v=v123'), `expected stamped href, got: ${html}`);
    });

    it('stamps import/from specifiers in JS with ?v=', () => {
      const cache = buildAssetCache(tempDir, 'v123');
      const js = cache.get('/app.js')!.content;
      assert.ok(js.includes('./utils.js?v=v123'), `expected stamped import, got: ${js}`);
    });

    it('stamps @import and url() in CSS with ?v=', () => {
      const cache = buildAssetCache(tempDir, 'v123');
      const css = cache.get('/styles.css')!.content;
      assert.ok(css.includes('@import "./base.css?v=v123"'), `expected stamped @import, got: ${css}`);
      assert.ok(css.includes('url("./bg.png?v=v123")'), `expected stamped url(), got: ${css}`);
    });

    it('serves non-text assets (images) as-is without stamping', () => {
      const cache = buildAssetCache(tempDir, 'v123');
      assert.equal(cache.get('/bg.png')!.content, 'fake-png-data');
    });

    it('leaves explicit query strings alone (does not double-stamp)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'assets-query-'));
      try {
        writeFileSync(join(dir, 'page.html'), '<script src="/app.js?existing=1"></script>');
        const cache = buildAssetCache(dir, 'v1');
        const html = cache.get('/page.html')!.content;
        // Existing query is preserved without a second ?v= appended
        assert.ok(html.includes('/app.js?existing=1'));
        assert.ok(!html.includes('?v=v1'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('handles nested directories with correct URL paths', () => {
      mkdirSync(join(tempDir, 'sub'), { recursive: true });
      writeFileSync(join(tempDir, 'sub', 'module.js'), 'export const y = 2;');
      writeFileSync(join(tempDir, 'sub', 'page.html'), '<link href="/app.js">');
      const cache = buildAssetCache(tempDir, 'v');
      assert.ok(cache.has('/sub/module.js'));
      assert.equal(cache.get('/sub/module.js')?.contentType, 'application/javascript; charset=utf-8');
      assert.ok(cache.has('/sub/page.html'));
    });

    it('does NOT stamp dynamic import() specifiers (known limitation)', () => {
      // The stamping regex targets `from '...'` and bare `import '...'`, not
      // `import('...')` (parenthesized dynamic import). This test documents
      // that limitation so a future fix is intentional rather than accidental.
      const dir = mkdtempSync(join(tmpdir(), 'assets-dynimport-'));
      try {
        writeFileSync(join(dir, 'loader.js'), "const m = await import('./lazy.js');");
        const cache = buildAssetCache(dir, 'v9');
        const js = cache.get('/loader.js')!.content;
        assert.ok(!js.includes('?v=v9'), `dynamic import should not be stamped, got: ${js}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not stamp absolute http(s) URLs in JS', () => {
      const dir = mkdtempSync(join(tmpdir(), 'assets-abs-'));
      try {
        writeFileSync(join(dir, 'remote.js'), "import 'https://example.com/lib.js';");
        const cache = buildAssetCache(dir, 'v1');
        const js = cache.get('/remote.js')!.content;
        assert.ok(js.includes('https://example.com/lib.js'));
        assert.ok(!js.includes('?v='));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('uses application/octet-stream for unknown extensions', () => {
      writeFileSync(join(tempDir, 'file.xyz'), 'unknown');
      const cache = buildAssetCache(tempDir, 'v');
      assert.equal(cache.get('/file.xyz')?.contentType, 'application/octet-stream');
    });
  });
});
