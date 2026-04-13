/**
 * Pagination Component
 * 
 * A pagination control with page numbers, navigation, and ellipsis.
 * 
 * Usage:
 *   const pagination = new Pagination('#pagination', {
 *     total: 100,
 *     limit: 20,
 *     current: 1,
 *     onChange: (page) => { console.log(page); }
 *   });
 * 
 * ═══════════════════════════════════════════════════════════════════ */

export class Pagination {
  /**
   * @param {string|HTMLElement} selector - Container element or selector
   * @param {Object} options - Configuration options
   */
  constructor(selector, options = {}) {
    this.container = typeof selector === 'string' 
      ? document.querySelector(selector) 
      : selector;
    
    if (!this.container) {
      console.error('Pagination: Container element not found');
      return;
    }

    this.options = {
      total: options.total || 0,
      limit: options.limit || 20,
      current: options.current || 1,
      maxVisible: options.maxVisible || 5,
      onChange: options.onChange || (() => {}),
      scrollToTop: options.scrollToTop !== false,
      ...options
    };

    this._init();
  }

  _init() {
    this.render();
  }

  get totalPages() {
    return Math.ceil(this.options.total / this.options.limit);
  }

  get currentPage() {
    return this.options.current;
  }

  render() {
    const { total, limit, current, maxVisible } = this.options;
    const totalPages = this.totalPages;

    if (totalPages <= 1) {
      this.container.innerHTML = '';
      return;
    }

    const buttons = [];

    // Context label
    const contextLabel = `<span class="pagination-context">Page ${current} of ${totalPages}</span>`;

    // Previous button
    buttons.push(`
      <button class="page-btn nav" aria-label="Previous page" ${current === 1 ? 'disabled' : ''} data-page="${current - 1}">
        ←
      </button>
    `);

    // Page numbers with ellipsis
    let startPage = Math.max(1, current - Math.floor(maxVisible / 2));
    let endPage = Math.min(totalPages, startPage + maxVisible - 1);

    if (endPage - startPage < maxVisible - 1) {
      startPage = Math.max(1, endPage - maxVisible + 1);
    }

    // First page and ellipsis
    if (startPage > 1) {
      buttons.push(`<button class="page-btn" data-page="1">1</button>`);
      if (startPage > 2) {
        buttons.push(`<span class="page-btn" style="cursor: default;">…</span>`);
      }
    }

    // Page range
    for (let i = startPage; i <= endPage; i++) {
      buttons.push(`
        <button class="page-btn ${i === current ? 'active' : ''}" data-page="${i}">
          ${i}
        </button>
      `);
    }

    // Last page and ellipsis
    if (endPage < totalPages) {
      if (endPage < totalPages - 1) {
        buttons.push(`<span class="page-btn" style="cursor: default;">…</span>`);
      }
      buttons.push(`<button class="page-btn" data-page="${totalPages}">${totalPages}</button>`);
    }

    // Next button
    buttons.push(`
      <button class="page-btn nav" aria-label="Next page" ${current === totalPages ? 'disabled' : ''} data-page="${current + 1}">
        →
      </button>
    `);

    this.container.innerHTML = contextLabel + buttons.join('');
    this._bindEvents();
  }

  _bindEvents() {
    const buttons = this.container.querySelectorAll('.page-btn[data-page]');
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        const page = parseInt(btn.dataset.page, 10);
        if (page >= 1 && page <= this.totalPages && page !== this.options.current) {
          this.goToPage(page);
        }
      });
    });
  }

  /**
   * Navigate to a specific page
   * @param {number} page - Page number
   */
  goToPage(page) {
    this.options.current = page;
    this.render();
    this.options.onChange(page);
    
    if (this.options.scrollToTop) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  /**
   * Go to next page
   */
  next() {
    if (this.options.current < this.totalPages) {
      this.goToPage(this.options.current + 1);
    }
  }

  /**
   * Go to previous page
   */
  prev() {
    if (this.options.current > 1) {
      this.goToPage(this.options.current - 1);
    }
  }

  /**
   * Go to first page
   */
  first() {
    this.goToPage(1);
  }

  /**
   * Go to last page
   */
  last() {
    this.goToPage(this.totalPages);
  }

  /**
   * Update pagination state
   * @param {Object} options - Options to update
   */
  update(options) {
    this.options = { ...this.options, ...options };
    this.render();
  }

  /**
   * Reset to first page
   */
  reset() {
    this.options.current = 1;
    this.render();
  }

  /**
   * Destroy the component
   */
  destroy() {
    this.container.innerHTML = '';
  }
}