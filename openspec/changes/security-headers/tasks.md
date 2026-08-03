## 1. Middleware

- [ ] 1.1 Add `securityHeaders()` middleware in `backend/index.ts`: a function returning a Hono middleware that, after `next()`, sets on the response:
  - all responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`
  - HTML responses (content-type starts with `text/html`): `Content-Security-Policy` with the exact policy from D3, and `X-Frame-Options: DENY`
- [ ] 1.2 Register it in `createApp()` as `app.use('/*', securityHeaders())` placed after the `cors()` middleware and before `compress()`.
- [ ] 1.3 Keep it dependency-free (no `@hono/secure-headers`); document rationale in a comment.

## 2. Tests

- [ ] 2.1 Add tests in `backend/index.test.ts`:
  - `GET /` → has CSP containing `script-src 'self'` and `'unsafe-inline'` + `X-Frame-Options: DENY` + nosniff + referrer-policy
  - `GET /styles.css` → has nosniff + referrer-policy (no CSP requirement asserted)
  - `GET /api/stats` → has nosniff + referrer-policy
  - `GET /nonexistent` (SPA fallback, HTML) → has CSP + XFO
  - Assert no test asserts a conflicting absence (each header asserted by exact expected value)
- [ ] 2.2 Verify existing suite still passes untouched (full `nub run test`).

## 3. Frontend audit (no-change expected)

- [ ] 3.1 Confirm no inline `<script>` or `on*` handlers exist (grep `frontend/` for `onclick=`, `onerror=`, `<script>` inline) — if any found, flag in report; do not silently weaken CSP.
- [ ] 3.2 Confirm Google Fonts `<link>` origins are covered by the CSP (`fonts.googleapis.com` style, `fonts.gstatic.com` font).

## 4. Verification

- [ ] 4.1 Run `nub run typecheck` — passes.
- [ ] 4.2 Run `nub run test` — all pass (existing + new header tests).
- [ ] 4.3 Run `openspec validate security-headers` — valid.
- [ ] 4.4 Mark all task checkboxes complete in `tasks.md`.
