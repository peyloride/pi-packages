import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { compress } from './compress';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

// Helper: create a body larger than the compress middleware's MIN_BYTES
// threshold (1024 bytes), so compression actually triggers.
const BIG = 'x'.repeat(2000);

function makeApp(): Hono {
  const app = new Hono();
  app.use('/*', compress());
  app.get('/text', (c) => c.text(BIG));
  app.get('/json', (c) => c.json({ data: BIG }));
  app.get('/small', (c) => c.text('tiny'));
  app.get('/image', (c) =>
    new Response(Buffer.alloc(2000, 0), { headers: { 'Content-Type': 'image/png' } }),
  );
  app.get('/no-transform', (c) =>
    c.text(BIG, 200, { 'Cache-Control': 'no-transform' }),
  );
  app.get('/etag', (c) => {
    c.header('ETag', '"abc123"');
    return c.text(BIG);
  });
  return app;
}

describe('compress.ts', () => {
  let app: Hono;

  beforeEach(() => {
    app = makeApp();
  });

  it('compresses with brotli when Accept-Encoding: br', async () => {
    const res = await app.request('/text', { headers: { 'Accept-Encoding': 'br' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Encoding'), 'br');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(brotliDecompressSync(buf).toString('utf-8'), BIG);
  });

  it('compresses with gzip when only gzip accepted', async () => {
    const res = await app.request('/text', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.headers.get('Content-Encoding'), 'gzip');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(gunzipSync(buf).toString('utf-8'), BIG);
  });

  it('compresses with deflate when only deflate accepted', async () => {
    const res = await app.request('/text', { headers: { 'Accept-Encoding': 'deflate' } });
    assert.equal(res.headers.get('Content-Encoding'), 'deflate');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(inflateSync(buf).toString('utf-8'), BIG);
  });

  it('prefers brotli over gzip when both are accepted', async () => {
    const res = await app.request('/text', { headers: { 'Accept-Encoding': 'gzip, br' } });
    assert.equal(res.headers.get('Content-Encoding'), 'br');
  });

  it('does not compress when no Accept-Encoding header is present', async () => {
    const res = await app.request('/text');
    assert.equal(res.headers.get('Content-Encoding'), null);
  });

  it('does not compress when only unsupported encodings are accepted', async () => {
    const res = await app.request('/text', { headers: { 'Accept-Encoding': 'sdch' } });
    assert.equal(res.headers.get('Content-Encoding'), null);
  });

  it('does not compress bodies below the MIN_BYTES threshold', async () => {
    const res = await app.request('/small', { headers: { 'Accept-Encoding': 'br' } });
    assert.equal(res.headers.get('Content-Encoding'), null);
  });

  it('does not compress non-compressible content types (image/png)', async () => {
    const res = await app.request('/image', { headers: { 'Accept-Encoding': 'br' } });
    assert.equal(res.headers.get('Content-Encoding'), null);
  });

  it('honours Cache-Control: no-transform', async () => {
    const res = await app.request('/no-transform', { headers: { 'Accept-Encoding': 'br' } });
    assert.equal(res.headers.get('Content-Encoding'), null);
  });

  it('weakens a strong ETag to W/... when compressing', async () => {
    const res = await app.request('/etag', { headers: { 'Accept-Encoding': 'br' } });
    assert.equal(res.headers.get('Content-Encoding'), 'br');
    const etag = res.headers.get('ETag');
    assert.ok(etag, 'expected an ETag header');
    assert.ok(etag!.startsWith('W/'), `expected weak ETag, got ${etag}`);
  });

  it('compresses JSON responses', async () => {
    const res = await app.request('/json', { headers: { 'Accept-Encoding': 'br' } });
    assert.equal(res.headers.get('Content-Encoding'), 'br');
    const buf = Buffer.from(await res.arrayBuffer());
    const decompressed = brotliDecompressSync(buf).toString('utf-8');
    assert.ok(decompressed.includes('"data"'));
  });

  it('adds Vary: Accept-Encoding when compressing', async () => {
    const res = await app.request('/text', { headers: { 'Accept-Encoding': 'br' } });
    const vary = res.headers.get('Vary');
    assert.ok(vary?.includes('Accept-Encoding'), `expected Vary to include Accept-Encoding, got ${vary}`);
  });

  it('respects q=0 to reject a preferred encoding and fall back', async () => {
    // br;q=0 rejects brotli → should fall back to gzip
    const res = await app.request('/text', { headers: { 'Accept-Encoding': 'br;q=0, gzip' } });
    assert.equal(res.headers.get('Content-Encoding'), 'gzip');
  });

  it('supports wildcard Accept-Encoding (*) and prefers brotli', async () => {
    const res = await app.request('/text', { headers: { 'Accept-Encoding': '*' } });
    assert.equal(res.headers.get('Content-Encoding'), 'br');
  });

  it('removes Content-Length and sets Content-Encoding when compressing', async () => {
    const res = await app.request('/text', { headers: { 'Accept-Encoding': 'br' } });
    assert.equal(res.headers.get('Content-Encoding'), 'br');
    // Content-Length is deleted because the encoded body has a different length
    assert.equal(res.headers.get('Content-Length'), null);
  });

  it('parses complex Accept-Encoding with q-values', async () => {
    // gzip at q=0.9, deflate at q=0.8, no br → should pick gzip
    const res = await app.request('/text', {
      headers: { 'Accept-Encoding': 'deflate;q=0.8, gzip;q=0.9' },
    });
    assert.equal(res.headers.get('Content-Encoding'), 'gzip');
  });
});
