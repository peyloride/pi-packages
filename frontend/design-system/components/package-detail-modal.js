/**
 * Package Detail Modal Component
 *
 * A dependency-free accessible modal dialog showing a package's full metadata
 * and 60-day download history, fetched from the existing detail API.
 *
 * Usage:
 *   const modal = openPackageDetailModal({
 *     name: 'pi-dgoal',
 *     fetchFn: window.fetch,          // injectable for tests
 *     onClose: () => { ... }         // called after the modal is removed
 *   });
 *   // modal.close()  — programmatic close (same as Escape/X/backdrop)
 *
 * Accessibility:
 *   - focus moves into the dialog on open
 *   - Tab is trapped inside the dialog while open
 *   - Escape / backdrop click / X close it
 *   - focus returns to the previously focused element on close
 *
 * ═══════════════════════════════════════════════════════════════════ */

import { escapeHtml, sanitizeUrl, formatNumber, timeAgo, copyToClipboard, renderBars } from '../js/utils.js';

const DETAIL_ENDPOINT = (name) => `/api/packages/${encodeURIComponent(name)}`;

/**
 * Open a package detail modal.
 *
 * @param {Object} options
 * @param {string} options.name - Package name to load
 * @param {Function} [options.fetchFn] - fetch implementation (defaults to global fetch)
 * @param {Function} [options.onClose] - Called (with no args) after modal removal
 * @returns {{element: HTMLElement, close: Function}} Modal handle
 */
export function openPackageDetailModal(options = {}) {
  const { name, fetchFn = globalThis.fetch, onClose = () => {} } = options;
  const state = { loading: true, error: null, notFound: false, data: null };
  const handle = { close: null, element: null };

  // ── Structure ──────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('data-open', 'true');

  const dialog = document.createElement('div');
  dialog.className = 'modal-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'modal-title');
  dialog.setAttribute('tabindex', '-1');

  // Header (rendered once, safe static strings only)
  const header = document.createElement('header');
  header.className = 'modal-header';
  const title = document.createElement('h2');
  title.id = 'modal-title';
  title.className = 'modal-title';
  title.textContent = name; // textContent — safe
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.setAttribute('aria-label', 'Close details');
  closeBtn.textContent = '×';
  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'modal-body';

  dialog.appendChild(header);
  dialog.appendChild(body);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // ── Focus management ───────────────────────────────────────────────
  const previousFocus = document.activeElement;

  function trapFocus(event) {
    if (event.key !== 'Tab') return;
    const focusables = dialog.querySelectorAll(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      handle.close();
    }
    trapFocus(event);
  }

  document.addEventListener('keydown', onKeyDown, true);

  // ── Close ──────────────────────────────────────────────────────────
  function close() {
    if (overlay.getAttribute('data-open') !== 'true') return; // already closed
    overlay.setAttribute('data-open', 'false');
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
    onClose();
  }
  handle.close = close;
  handle.element = overlay;

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close(); // backdrop only
  });

  // ── Render state ───────────────────────────────────────────────────
  function render() {
    body.innerHTML = '';
    if (state.notFound) {
      body.appendChild(stateMessage({
        className: 'modal-empty',
        title: 'Package not found',
        message: `No package named "${escapeHtml(name)}" exists in the registry index.`,
      }));
      return;
    }
    if (state.loading) {
      body.appendChild(stateMessage({ className: 'modal-loading', title: 'Loading…', message: 'Fetching package details' }));
    } else if (state.error) {
      body.appendChild(errorMessage(state.error, load));
    } else if (state.data) {
      body.appendChild(renderDetail(state.data));
    }
  }

  function stateMessage({ className, title: t, message }) {
    const el = document.createElement('div');
    el.className = `modal-state ${className}`;
    const strong = document.createElement('strong');
    strong.textContent = t;
    const p = document.createElement('p');
    p.textContent = message;
    el.appendChild(strong);
    el.appendChild(p);
    return el;
  }

  function errorMessage(err, retry) {
    const el = stateMessage({ className: 'modal-error', title: 'Failed to load package', message: err && err.message ? err.message : 'Something went wrong while loading this package.' });
    const retryBtn = document.createElement('button');
    retryBtn.className = 'retry-btn';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', retry);
    el.appendChild(retryBtn);
    return el;
  }

  /**
   * GitHub stats strip shown in the modal when the package has repo metadata.
   * All values are GitHub-sourced (untrusted) — rendered as textContent only.
   */
  function renderGithubStrip(github) {
    const strip = document.createElement('div');
    strip.className = 'github-strip';

    const stat = (label, value) => {
      const s = document.createElement('span');
      s.className = 'gh-stat';
      const v = document.createElement('span');
      v.className = 'gh-stat-value';
      v.textContent = value;
      const l = document.createElement('span');
      l.className = 'gh-stat-label';
      l.textContent = label;
      s.appendChild(v);
      s.appendChild(l);
      return s;
    };

    if (typeof github.stars === 'number') strip.appendChild(stat('★ stars', formatNumber(github.stars)));
    if (typeof github.forks === 'number') strip.appendChild(stat('⑂ forks', formatNumber(github.forks)));
    if (typeof github.open_issues === 'number') strip.appendChild(stat('⚠ issues', formatNumber(github.open_issues)));
    if (github.license) {
      const chip = document.createElement('span');
      chip.className = 'license-chip';
      chip.textContent = escapeHtml(github.license);
      strip.appendChild(chip);
    }
    if (github.archived) {
      const warn = document.createElement('span');
      warn.className = 'archived-badge';
      warn.textContent = 'ARCHIVED';
      strip.appendChild(warn);
    }

    if (strip.children.length === 0) return null;
    return strip;
  }

  /**
   * Build the detail view. ALL npm-sourced fields are escaped text or
   * sanitized URLs — the registry is untrusted input (see package-card.js).
   */
  function renderDetail(d) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-detail';

    // Description
    if (d.description) {
      const desc = document.createElement('p');
      desc.className = 'modal-description';
      desc.innerHTML = escapeHtml(d.description);
      wrap.appendChild(desc);
    }

    // Meta grid
    const meta = document.createElement('dl');
    meta.className = 'modal-meta-grid';

    const addMeta = (label, valueFn) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      valueFn(dd);
      meta.appendChild(dt);
      meta.appendChild(dd);
    };

    if (d.version) addMeta('Version', (dd) => { dd.textContent = `v${escapeHtml(d.version)}`; });
    if (d.publisher) addMeta('Publisher', (dd) => {
      const raw = d.publisher_raw || d.publisher;
      if (raw && /^https?:\/\//i.test(String(raw))) {
        const a = document.createElement('a');
        a.href = sanitizeUrl(raw);
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = d.publisher;
        dd.appendChild(a);
      } else {
        dd.textContent = d.publisher;
      }
    });
    addMeta('First seen', (dd) => { dd.textContent = d.first_seen ? timeAgo(d.first_seen) : '—'; });
    addMeta('Last publish', (dd) => { dd.textContent = d.last_publish ? timeAgo(d.last_publish) : '—'; });

    // GitHub stat strip (present only when the API returned non-null github)
    if (d.github && typeof d.github === 'object') {
      const strip = renderGithubStrip(d.github);
      if (strip) wrap.appendChild(strip);
    }

    // Links
    const githubHref = sanitizeUrl(d.github_url);
    const npmHref = sanitizeUrl(d.npm_url);
    if (githubHref !== '#' || npmHref !== '#') {
      addMeta('Links', (dd) => {
        const linksBox = document.createElement('span');
        linksBox.className = 'modal-links';
        if (githubHref !== '#') {
          const a = document.createElement('a');
          a.href = githubHref;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = 'GitHub ↗';
          linksBox.appendChild(a);
        }
        if (npmHref !== '#') {
          const a = document.createElement('a');
          a.href = npmHref;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = 'npm ↗';
          linksBox.appendChild(a);
        }
        dd.appendChild(linksBox);
      });
    }
    wrap.appendChild(meta);

    // Stats row
    const statsRow = document.createElement('div');
    statsRow.className = 'modal-stats';
    const stat = (label, value) => {
      const s = document.createElement('div');
      s.className = 'modal-stat';
      const v = document.createElement('span');
      v.className = 'modal-stat-value';
      v.textContent = value;
      const l = document.createElement('span');
      l.className = 'modal-stat-label';
      l.textContent = label;
      s.appendChild(v);
      s.appendChild(l);
      return s;
    };
    statsRow.appendChild(stat('Daily', formatNumber(d.daily_downloads)));
    statsRow.appendChild(stat('Weekly', formatNumber(d.weekly_downloads)));
    statsRow.appendChild(stat('Monthly', formatNumber(d.monthly_downloads)));
    if (d.growth !== null && d.growth !== undefined) {
      const growth = stat('Growth', `${d.growth > 0 ? '+' : ''}${d.growth}%`);
      growth.className += d.growth >= 0 ? ' positive' : ' negative';
      statsRow.appendChild(growth);
    }
    wrap.appendChild(statsRow);

    // Keywords as tags
    if (Array.isArray(d.keywords) && d.keywords.length) {
      const tags = document.createElement('div');
      tags.className = 'modal-tags';
      d.keywords.forEach((kw) => {
        const tag = document.createElement('span');
        tag.className = 'modal-tag';
        tag.textContent = escapeHtml(kw);
        tags.appendChild(tag);
      });
      wrap.appendChild(tags);
    }

    // Chart
    if (Array.isArray(d.download_history) && d.download_history.length) {
      const chartWrap = document.createElement('div');
      chartWrap.className = 'modal-chart';
      const chartTitle = document.createElement('h3');
      chartTitle.className = 'modal-chart-title';
      chartTitle.textContent = 'Downloads (60 days)';
      chartWrap.appendChild(chartTitle);
      renderBars(chartWrap, d.download_history.map((p) => ({
        date: p.date,
        downloads: p.downloads,
      })));
      wrap.appendChild(chartWrap);
    }

    // Install command + copy
    const installWrap = document.createElement('div');    installWrap.className = 'modal-install';
    const code = document.createElement('code');
    code.className = 'install-cmd';
    code.textContent = `pi install npm:${d.name}`;
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.setAttribute('aria-label', 'Copy install command');
    copyBtn.addEventListener('click', async () => {
      const ok = await copyToClipboard(`pi install npm:${d.name}`);
      if (ok) {
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 1500);
      }
    });
    installWrap.appendChild(code);
    installWrap.appendChild(copyBtn);
    wrap.appendChild(installWrap);

    return wrap;
  }

  // ── Load ───────────────────────────────────────────────────────────
  async function load() {
    state.loading = true;
    state.error = null;
    state.notFound = false;
    render();
    try {
      const res = await fetchFn(DETAIL_ENDPOINT(name));
      if (res.status === 404) {
        state.notFound = true;
        state.loading = false;
      } else if (!res.ok) {
        state.error = new Error(`HTTP ${res.status}`);
        state.loading = false;
      } else {
        state.data = await res.json();
        state.loading = false;
      }
    } catch (err) {
      state.error = err instanceof Error ? err : new Error('Network error');
      state.loading = false;
    }
    render();
  }

  // Initial focus after paint
  requestAnimationFrame(() => { closeBtn.focus({ preventScroll: true }); });
  load();

  return handle;
}
