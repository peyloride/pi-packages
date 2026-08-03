## Context

The Hono app (`backend/index.ts`) sets per-route headers today: `cache-control` on API JSON and static assets, `content-type`, etc. — but no security headers. The frontend is vanilla JS with module scripts served from `/app.js` and the design-system, plus an external Google Fonts `<link>` in `index.html`. There are no inline `on*` handlers; the only inline style is a static `style="cursor: default"` ellipsis in `pagination.js`. All npm-sourced data is escaped render-side (`escapeHtml`, `sanitizeUrl`), so the CSP is defense-in-depth, not the primary control.

## Goals / Non-Goals

**Goals:**
- Strict CSP that blocks inline scripts and foreign script origins, keeping the UI fully functional.
- nosniff + referrer-policy on everything; XFO on HTML.
- Automated tests locking the header contract.

**Non-Goals:**
- No `report-uri`/`report-to` wiring (no CSP reporting endpoint exists; revisit when there's a collector).
- No HSTS (HTTPS termination is the proxy's job — Coolify proxy; HSTS belongs at the edge, and adding it server-side risks breaking plain-HTTP local dev).
- No `Permissions-Policy` (low value here; out of scope).
- No changes to the frontend beyond what the audit finds necessary.

## Decisions

**D1: Hono middleware function `securityHeaders()` applied before routes.** One function sets the headers on `c.res` via a small middleware that runs for every request. Simple, testable, no per-route duplication. Alternative (hono's built-in `secureHeaders()` from `hono/secure-headers`) rejected: pulls in `@hono/secure-headers` dep and its default CSP needs overriding anyway; a 10-line local helper keeps the zero-dep spirit.

**D2: Header application strategy.** For HTML-family responses (content-type `text/html`) add CSP + XFO; add `nosniff` + `Referrer-Policy` universally. Simplest correct rule: set all four on HTML (CSP only makes sense there), and nosniff + referrer on everything else. `X-Content-Type-Options` and `Referrer-Policy` are safe on all response types.

**D3: CSP value.** `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`. Rationale:
- `script-src 'self'` — all JS is served from the same origin with `?v=` stamps. No `unsafe-inline`, no `unsafe-eval`. The modal component uses only `addEventListener`, no eval.
- `style-src 'unsafe-inline'` — required by the static `style="cursor: default"` in `pagination.js` (and future dynamic style mutations); scoped to styles only.
- `fonts.googleapis.com` / `fonts.gstatic.com` — the existing `<link>` + `@font-face` fetches.
- `img-src data:` — future-proof for inline SVG favicons/sparkline data URIs.
- `form-action 'self'`, `base-uri 'self'`, `frame-ancestors 'none'` — cheap hardening.
- Alternative considered: `'nonce'`-based script CSP — overkill for a static SPA with zero inline scripts.

**D4: Where headers are set.** In `createApp()` before `compress()`, after `cors()`. Middleware order matters only for reading `c.res`; since headers are set without touching the body, position is safe. Use a plain `app.use('/*', securityHeaders())` that wraps `next()` and sets headers on the response.

**D5: Tests** in `backend/index.test.ts` (existing app-factory test pattern): request `/`, `/styles.css`, `/api/stats`, and `/nonexistent`; assert header values. Test count expectation: existing suite stays green; add ~4-6 assertions.

## Risks / Trade-offs

- **CSP blocks legit inline scripts** if any are added later without the header being updated — that's the point; devtools will surface it loudly.
- **`'unsafe-inline'` in style-src** weakens style blocking slightly, but it's required for the pagination ellipsis style; acceptable (styles are low-risk vs scripts).
- **Google Fonts is now a CSP-listed dependency** — if the fonts `<link>` is ever removed, the CSP entries become harmless dead weight (no action needed).
- **XFO `DENY` + `frame-ancestors 'none'` are redundant-but-complementary** (modern browsers honor frame-ancestors; XFO covers legacy). No conflict; both set.
