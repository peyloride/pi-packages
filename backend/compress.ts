/**
 * Content-encoding middleware — brotli (preferred), gzip, deflate.
 *
 * Hono's built-in `compress` only supports gzip/deflate because the WHATWG
 * CompressionStream enum doesn't include 'br'. Node's `node:zlib`, however,
 * has a real brotli implementation, so we use it directly. Brotli gives ~15–20%
 * better compression than gzip on text (JS/CSS/JSON), which is the bulk of our
 * traffic.
 *
 * Bodies are buffered (we only encode when there is a complete body and the
 * content type is compressible). This is fine here because every response is
 * already small and in-memory (cached JSON or stamped static assets); there are
 * no streamed bodies to worry about.
 *
 * ETag interaction: this middleware runs OUTSIDE the etag middleware (see
 * registration order in index.ts), so ETag is computed on the raw body first.
 * If the client's If-None-Match matches, etag returns 304 before we get here.
 * When we do encode, we weaken any strong ETag to W/... per RFC 7232 §2.3
 * (the same representation, differently encoded, must not share a strong
 * validator).
 */

import { brotliCompressSync, gzipSync, deflateSync } from 'node:zlib';

// Order of preference: best ratio first.
const PREFERENCE = ['br', 'gzip', 'deflate'] as const;
type Encoding = (typeof PREFERENCE)[number];

const ENCODERS: Record<Encoding, (buf: Buffer) => Buffer> = {
  br: (buf) => brotliCompressSync(buf),
  gzip: (buf) => gzipSync(buf),
  deflate: (buf) => deflateSync(buf),
};

// Mirrors hono/utils/compress.ts — text-ish types are worth compressing.
const COMPRESSIBLE = /^\s*(?:text\/[^;\s]+|application\/(?:javascript|json|xml|ecmascript|x-javascript|wasm)|image\/(?:svg\+z|svg\+xml|x-icon|vnd\.microsoft\.icon)|font\/(?:otf|ttf|woff2?)|message\/rfc822|[^;\s]+?\+(?:json|text|xml|yaml))(?:[;\s]|$)/i;

const NO_TRANSFORM = /(?:^|,)\s*?no-transform\s*?(?:,|$)/i;
const MIN_BYTES = 1024; // skip tiny responses (overhead > savings)

interface Accepted {
  enc: string;
  q: number;
}

/** Parse Accept-Encoding with q-values. */
function parseAcceptEncoding(header?: string | null): Accepted[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const [enc, ...params] = part.trim().split(';');
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam ? parseFloat(qParam.split('=')[1]) : 1;
      return { enc: enc.trim().toLowerCase(), q: isNaN(q) ? 0 : q };
    })
    .filter((a) => a.q > 0);
}

/** Pick the best encoding the client accepts, honouring our preference. */
function selectEncoding(header?: string | null): Encoding | null {
  const accepted = parseAcceptEncoding(header);
  if (accepted.length === 0) return null;
  for (const pref of PREFERENCE) {
    const explicit = accepted.find((a) => a.enc === pref);
    if (explicit) return pref;
    const wildcard = accepted.find((a) => a.enc === '*');
    if (wildcard) return pref;
  }
  return null;
}

export function compress() {
  return async (c: any, next: () => Promise<void>) => {
    await next();

    const res = c.res as Response;
    const headers = res.headers;

    // Already encoded, chunked, or a HEAD — leave alone.
    if (headers.has('Content-Encoding') || headers.has('Transfer-Encoding')) return;
    if (c.req.method === 'HEAD') return;

    // Only compress text-ish content types.
    const contentType = headers.get('Content-Type') ?? '';
    if (!COMPRESSIBLE.test(contentType)) return;

    // Honour Cache-Control: no-transform.
    const cacheControl = headers.get('Cache-Control');
    if (cacheControl && NO_TRANSFORM.test(cacheControl)) return;

    // Skip bodies below the threshold (overhead would exceed savings).
    const contentLength = Number(headers.get('Content-Length') ?? 0);
    if (contentLength && contentLength < MIN_BYTES) return;

    const encoding = selectEncoding(c.req.header('Accept-Encoding'));
    if (!encoding) return;

    const body = res.body;
    if (!body) return;

    // Read the body via a clone so the original response's stream stays
    // undisturbed for downstream consumers (and for etag, which may have
    // already tee'd the stream via its own clone()).
    let buf: Buffer;
    try {
      buf = Buffer.from(await res.clone().arrayBuffer());
    } catch {
      return; // body not consumible here — leave the response as-is
    }
    if (buf.length < MIN_BYTES) return;

    const encoded = ENCODERS[encoding](buf);
    const newHeaders = new Headers(headers);
    newHeaders.delete('Content-Length');
    newHeaders.set('Content-Encoding', encoding);
    // NOTE: Vary is added via c.header() below, not here. Appending it to
    // newHeaders as well produced a duplicate `Vary: Accept-Encoding,
    // Accept-Encoding` — Hono leaves newHeaders' Vary intact (the original
    // response had none to clobber it) AND applies the c.header() value.
    // Encoding changes the byte representation → strong ETag must become weak.
    const etag = newHeaders.get('ETag');
    if (etag && !etag.startsWith('W/')) {
      newHeaders.set('ETag', `W/${etag}`);
    }

    c.res = new Response(encoded, { status: res.status, headers: newHeaders });
    // Hono's c.res setter re-applies headers from the original response onto
    // the new one, so any header that existed before (like ETag) overwrites
    // the value we set on newHeaders. Route the weak ETag + Vary through
    // c.header() instead — it writes to the context layer, which Hono
    // applies AFTER middleware and so actually takes effect.
    if (etag && !etag.startsWith('W/')) {
      c.header('ETag', `W/${etag}`, { append: false });
    }
    c.header('Vary', 'Accept-Encoding', { append: true });
  };
}
