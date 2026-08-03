# Proposal: security-headers

## Why

The dashboard surfaces untrusted npm-sourced data (anyone can publish a `pi-package` with a malicious description or URL). The app already escapes HTML and sanitizes URLs render-side, but defense-in-depth is missing: the server sends no `Content-Security-Policy`, no `X-Content-Type-Options`, and no `Referrer-Policy`. A CSP would contain any future rendering bug (e.g. an unescaped field) by blocking inline script execution and external origins outright.

## What Changes

- **CSP header** served on HTML responses from the Hono app: `default-src 'self'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'` (one existing inline `style="cursor:default"` in pagination + future dynamic styles), `img-src 'self' data:`, `font-src 'self' https://fonts.gstatic.com`, `connect-src 'self'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`. Google Fonts CSS import stays allowed via `style-src … https://fonts.googleapis.com` (the `<link>` loads stylesheet CSS from that origin — verify and include).
- **`X-Content-Type-Options: nosniff`** on all responses.
- **`Referrer-Policy: strict-origin-when-cross-origin`** on all responses.
- **`X-Frame-Options: DENY`** as a legacy fallback for frame-ancestors.
- No inline scripts currently exist; the CSP MUST be strict enough that adding one later fails loudly in devtools.
- Server-side headers only; no HTML template changes beyond the (optional) CSP meta equivalent if the header is the single source of truth.

## Capabilities

### New Capabilities
- `security-headers`: CSP + nosniff + referrer-policy + XFO headers on all dashboard responses, tested.

## Impact

- `backend/index.ts` (header middleware — a `securityHeaders()` helper applied to all responses, or hono middleware)
- `backend/index.test.ts` (header assertions)
- No frontend changes unless a CSP-relevant inline blocker is found (audit first; `style="cursor:default"` in `pagination.js` is the known one — needs `'unsafe-inline'` for style-src, not script).
- Google Fonts `<link>` in `index.html` — CSP must allow `https://fonts.googleapis.com` (style) and `https://fonts.gstatic.com` (font).
