import { formatNumber, timeAgo, copyToClipboard } from '../js/utils.js';

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
      ...options
    };

    this.element = this._createElement();
  }

  _createElement() {
    const article = document.createElement('article');
    article.className = 'package';
    
    const { data, options } = this;
    
    // Build stats HTML
    const downloadsLabel = data.downloads_label || '/week';
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
      metaItems.push(`<span class="meta-item updated-at">${timeAgo(data.last_publish)}</span>`);
    }
    if (data.publisher) {
      metaItems.push(`<span class="meta-item author">${data.publisher}</span>`);
    }
    if (data.github_url || data.npm_url) {
      const link = data.github_url || data.npm_url;
      const label = data.github_url ? 'GitHub' : 'npm';
      metaItems.push(`<a class="meta-item link-github" href="${link}" target="_blank" rel="noopener">${label}</a>`);
    }

    // Build version HTML
    const versionHtml = options.showVersion && data.version 
      ? `<span class="package-version">v${data.version}</span>` 
      : '';

    // Build install command: `pi install <sourceType>:<spec>` with no space
    // between the colon and the spec.
    const installCmd = `${options.installPrefix} ${options.installSourceType}:${data.name}`;

    article.innerHTML = `
      <div class="package-head">
        <div class="package-title">
          <a class="package-name" href="${data.github_url || data.npm_url || '#'}" target="_blank" rel="noopener">${data.name}</a>
          ${versionHtml}
        </div>
        <div class="package-stats">
          ${statsHtml}
        </div>
      </div>
      <p class="package-description">${data.description || 'No description available'}</p>
      <div class="package-foot">
        <div class="package-meta">
          ${metaItems.join('')}
        </div>
        <div class="package-install">
          <code class="install-cmd">${installCmd}</code>
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