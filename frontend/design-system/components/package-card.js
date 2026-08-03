import { formatNumber, timeAgo, copyToClipboard, escapeHtml, sanitizeUrl } from '../js/utils.js';
import { getFreshness, formatStaleLabel } from '../js/freshness.js';

/**
 * PackageCard Component
 * 
 * A card component for displaying package information with stats,
 * install command, and copy-to-clipboard functionality.
 * 
 * Usage:
 *   const card = new PackageCard(packageData, {
 *     onNameClick: (pkg) => { ... }
 *   });
 *   container.appendChild(card.element);
 * 
 * ═══════════════════════════════════════════════════════════════════ */

export class PackageCard {
  /**
   * @param {Object} data - Package data
   * @param {Object} options - Configuration options
   */
  constructor(data, options = {}) {
    this.data = data;
    this.options = {
      showVersion: options.showVersion !== false,
      showTrend: options.showTrend !== false,
      onNameClick: options.onNameClick || null,
      onCopy: options.onCopy || null,
      // `<sourceType>:` is required so pi can resolve the source — see
      // `pi install npm:@foo/bar` and `pi install git:git@github.com:user/repo@ref`
      // in the pi packages docs. No space between the colon and the spec:
      // `npm:pkg` (not `npm: pkg`), `git:git@github.com:...` (not `git: git@...`).
      installPrefix: options.installPrefix || 'pi install',
      installSourceType: options.installSourceType || 'npm',
      // Freshness badges: NEW pill for recently first-seen packages, muted
      // stale chip for packages not updated in a while. Defaults on; pass
      // `showNewBadge: false` / `staleThresholdDays: N` to customize.
      showNewBadge: options.showNewBadge !== false,
      staleThresholdDays: options.staleThresholdDays !== undefined ? options.staleThresholdDays : 30,
      // GitHub star count next to the GitHub link when repo metadata exists.
      showStars: options.showStars !== false,
      ...options
    };

    this.element = this._createElement();
  }

  _createElement() {
    const article = document.createElement('article');
    article.className = 'package';
    
    const { data, options } = this;

    // All npm-sourced strings (name, description, publisher, version, URLs) are
    // UNTRUSTED — anyone can `npm publish` a pi-package. Escape text before
    // interpolating into innerHTML and allowlist URLs before using them as
    // hrefs, otherwise a malicious description like `<img src=x onerror=...>`
    // becomes a stored XSS that fires for every dashboard visitor.
    const safeName = escapeHtml(data.name);
    const safeDescription = escapeHtml(data.description) || 'No description available';
    const safePublisher = escapeHtml(data.publisher);
    const safeVersion = escapeHtml(data.version);
    const githubLink = sanitizeUrl(data.github_url);
    const npmLink = sanitizeUrl(data.npm_url);
    // Prefer a usable GitHub link, fall back to npm, else no link at all
    // (e.g. an `ssh://` repo URL is neutralized to '#' and dropped).
    const profileLink = githubLink !== '#' ? { href: githubLink, label: 'GitHub' }
      : npmLink !== '#' ? { href: npmLink, label: 'npm' }
      : null;
    // Escape the href for the attribute context too (a URL may contain `"`).
    const profileHref = profileLink ? escapeHtml(profileLink.href) : '#';

    // Freshness (pure classification, see js/freshness.js). NEW badge shows
    // for packages first seen within NEW_DAYS (inclusive); the stale chip
    // replaces the plain updated label for packages not published in
    // staleThresholdDays+ days. Badge labels are static trusted strings.
    const { isNew, isStale, updatedLabel } = getFreshness(
      Date.now(),
      data.first_seen,
      data.last_publish,
      timeAgo,
      { staleDays: options.staleThresholdDays },
    );
    const newBadgeHtml = options.showNewBadge && isNew
      ? `<span class="badge badge-new">NEW</span>`
      : '';

    // Build stats HTML
    const downloadsLabel = escapeHtml(data.downloads_label || '/week');
    const statsHtml = `
      <div class="stat">
        <span class="stat-value weekly-downloads">${formatNumber(data.downloads)}</span>
        <span class="stat-label">${downloadsLabel}</span>
      </div>
      ${options.showTrend ? `
      <div class="stat trend">
        <span class="stat-value trend-value ${this._getTrendClass(data.growth)}">${this._formatTrend(data.growth)}</span>
      </div>
      ` : ''}
    `;

    // Build meta HTML
    const metaItems = [];
    if (data.last_publish) {
      if (isStale) {
        metaItems.push(`<span class="meta-item updated-at stale" title="Last published ${escapeHtml(timeAgo(data.last_publish))}">${escapeHtml(formatStaleLabel(data.last_publish, timeAgo))}</span>`);
      } else {
        metaItems.push(`<span class="meta-item updated-at">${timeAgo(data.last_publish)}</span>`);
      }
    }
    if (data.publisher) {
      metaItems.push(`<span class="meta-item author">${safePublisher}</span>`);
    }
    if (profileLink) {
      metaItems.push(`<a class="meta-item link-github" href="${profileHref}" target="_blank" rel="noopener">${profileLink.label}</a>`);
    }
    // GitHub star count when repo metadata exists (github is GitHub-sourced =
    // untrusted; the number is formatted, never interpolated raw).
    if (options.showStars && data.github && typeof data.github === 'object' && typeof data.github.stars === 'number' && data.github.stars > 0) {
      metaItems.push(`<span class="meta-item card-stars" title="GitHub stars">★ ${formatNumber(data.github.stars)}</span>`);
    }

    // Build version HTML
    const versionHtml = options.showVersion && data.version
      ? `<span class="package-version">v${safeVersion}</span>`
      : '';

    // Build install command: `pi install <sourceType>:<spec>` with no space
    // between the colon and the spec. The displayed command is HTML-escaped;
    // the copy button reads `.textContent`, which decodes back to the raw
    // command, so copying still yields a correct `pi install npm:<name>`.
    const installCmd = `${options.installPrefix} ${options.installSourceType}:${data.name}`;
    const safeInstallCmd = escapeHtml(installCmd);

    article.innerHTML = `
      <div class="package-head">
        <div class="package-title">
          <a class="package-name" href="${profileHref}" target="_blank" rel="noopener">${safeName}</a>
          ${newBadgeHtml}
          ${versionHtml}
        </div>
        <div class="package-stats">
          ${statsHtml}
        </div>
      </div>
      <p class="package-description">${safeDescription}</p>
      <div class="package-foot">
        <div class="package-meta">
          ${metaItems.join('')}
        </div>
        <div class="package-install">
          <code class="install-cmd">${safeInstallCmd}</code>
          <button class="copy-btn" aria-label="Copy install command" title="Copy to clipboard">Copy</button>
        </div>
      </div>
    `;

    // Bind events
    this._bindEvents(article);

    return article;
  }

  _bindEvents(article) {
    // Copy button
    const copyBtn = article.querySelector('.copy-btn');
    const installCmd = article.querySelector('.install-cmd').textContent;
    
    copyBtn.addEventListener('click', async () => {
      const success = await copyToClipboard(installCmd);
      if (success) {
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('copied');
        }, 1500);
        if (this.options.onCopy) this.options.onCopy(installCmd);
      }
    });

    // Name click callback
    if (this.options.onNameClick) {
      const nameLink = article.querySelector('.package-name');
      nameLink.addEventListener('click', (e) => {
        this.options.onNameClick(this.data, e);
      });
    }
  }

  _getTrendClass(growth) {
    if (growth > 0) return 'positive';
    if (growth < 0) return 'negative';
    return '';
  }

  _formatTrend(growth) {
    if (growth === null || growth === undefined) return '—';
    if (growth > 0) return `+${growth.toFixed(1)}%`;
    if (growth < 0) return `${growth.toFixed(1)}%`;
    return '—';
  }

  /**
   * Update card data
   * @param {Object} newData - New package data
   */
  update(newData) {
    this.data = { ...this.data, ...newData };
    const newElement = this._createElement();
    this.element.replaceWith(newElement);
    this.element = newElement;
  }

  /**
   * Add custom CSS classes
   * @param {string} classes - CSS classes to add
   */
  addClass(classes) {
    this.element.classList.add(...classes.split(' '));
  }

  /**
   * Remove the card from DOM
   */
  remove() {
    this.element.remove();
  }
}

/**
 * Render multiple package cards
 * @param {Array} packages - Array of package data
 * @param {Object} options - Component options
 * @returns {DocumentFragment} Fragment containing all cards
 */
export function renderPackageList(packages, options = {}) {
  const fragment = document.createDocumentFragment();
  packages.forEach(pkg => {
    const card = new PackageCard(pkg, options);
    fragment.appendChild(card.element);
  });
  return fragment;
}