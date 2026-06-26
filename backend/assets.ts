/**
 * Stamped static-asset cache for the frontend.
 *
 * Goal: serve every frontend file with `Cache-Control: public, max-age=31536000,
 * immutable` and still be able to bust the browser cache after a deploy. With
 * no build step there are no content-hashed filenames, so we stamp a `?v=`
 * query onto every asset URL instead. The version is derived from the mtimes
 * of all frontend files at boot — it rotates the moment any file changes
 * (typically because a deploy restarted the process).
 *
 * index.html is the only entry that is short-cached (`no-cache`): its stamped
 * asset references change with the version, so a returning visitor always
 * picks up the new `?v=` and re-fetches any changed asset.
 *
 * ES-module imports are the subtle case. When the browser resolves
 *   import { x } from './design-system/js/utils.js'
 * it fetches `/design-system/js/utils.js` (no query), which would defeat
 * immutable caching for that module. To keep it safe, every relative reference
 * inside every .js/.css file is also stamped with `?v=`, and the stamped bytes
 * are served from memory.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, posix as posixPath } from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface StampedAsset {
  content: string;
  contentType: string;
}

/**
 * Compute a short version string from the mtimes of every file under `root`.
 * Changes whenever any frontend file is modified, re-saved, or a new file is
 * added — i.e. on every deploy that restarts the process.
 */
export function computeAssetVersion(root: string): string {
  const hash = createHash('sha1');
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const mtimeMs = statSync(full).mtimeMs;
        hash.update(full);
        hash.update('\0');
        hash.update(String(mtimeMs));
        hash.update('\0');
      }
    }
  };
  walk(root);
  return hash.digest('hex').slice(0, 10);
}

/** Append `?v=<version>` to a URL fragment that doesn't already hold a query. */
function appendVersion(spec: string, version: string): string {
  if (spec.includes('?')) return spec; // leave explicit queries alone
  return `${spec}?v=${version}`;
}

/**
 * Stamp `?version=` onto every relative module/@import reference inside a
 * file's content. Absolute URLs (http(s)://, data:, blob:) are left alone.
 *
 * Targets:
 *   - JS:        `from './x.js'` and `import('...')`
 *   - CSS:       `@import './x.css';` and `url('./x.png')`
 */
function stampInternalReferences(content: string, version: string): string {
  // JS import / re-export specifiers. Capture the specifier without quotes,
  // only relative ones (start with `.`). Leaves absolute URLs untouched.
  content = content.replace(
    /(\b(?:from|import)\s*)(["'])(\.\S+?)\2/g,
    (_m, kw, q, spec) => `${kw}${q}${appendVersion(spec, version)}${q}`,
  );

  // CSS @import and url(). Match optional quotes around the URL.
  content = content.replace(
    /(url\(\s*)(["']?)([^"'\s)]+)(\2\s*\))/g,
    (_m, pre, q, spec, post) => isRelative(spec) ? `${pre}${q}${appendVersion(spec, version)}${post}` : _m,
  );
  content = content.replace(
    /(@import\s+)(["'])(\.\S+?)\2/g,
    (_m, kw, q, spec) => `${kw}${q}${appendVersion(spec, version)}${q}`,
  );

  return content;
}

function isRelative(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('/');
}

/**
 * Pre-index a frontend directory. Returns a map of URL-path -> stamped asset.
 * Keyed by the URL path the browser will request (e.g. `/styles.css`).
 */
export function buildAssetCache(root: string, version: string): Map<string, StampedAsset> {
  const cache = new Map<string, StampedAsset>();

  const stripHtml = (raw: string, version: string): string =>
    raw.replace(
      /((?:href|src)=)(["'])(\/[^"'?#]+?\.(?:css|js|mjs|svg|png|jpe?g|gif|webp|ico|woff2?))\2/g,
      (_m, attr, q, path) => `${attr}${q}${appendVersion(path, version)}${q}`,
    );

  const walk = (absDir: string, urlPrefix: string) => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, entry.name);
      const urlPath = posixPath.join(urlPrefix, entry.name);
      if (entry.isDirectory()) {
        walk(abs, urlPath);
        continue;
      }
      const raw = readFileSync(abs, 'utf-8');
      const ext = extname(entry.name).toLowerCase();
      let stamped: string;
      if (ext === '.html') {
        stamped = stripHtml(raw, version);
      } else if (ext === '.js' || ext === '.mjs' || ext === '.css') {
        stamped = stampInternalReferences(raw, version);
      } else {
        // Non-text assets (images, fonts) — stamp not needed, served as-is.
        stamped = raw;
      }
      cache.set(urlPath, {
        content: stamped,
        contentType: MIME_TYPES[ext] || 'application/octet-stream',
      });
    }
  };
  walk(root, '/');
  return cache;
}
