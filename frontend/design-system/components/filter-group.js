/**
 * FilterGroup Component
 * 
 * A group of filter buttons with active state management.
 * 
 * Usage:
 *   const filters = new FilterGroup('.filters', {
 *     onChange: (activeFilter) => { console.log(activeFilter); }
 *   });
 * 
 * ═══════════════════════════════════════════════════════════════════ */

export class FilterGroup {
  /**
   * @param {string|HTMLElement} selector - Container element or selector
   * @param {Object} options - Configuration options
   */
  constructor(selector, options = {}) {
    this.container = typeof selector === 'string' 
      ? document.querySelector(selector) 
      : selector;
    
    if (!this.container) {
      console.error('FilterGroup: Container element not found');
      return;
    }

    this.options = {
      activeClass: options.activeClass || 'active',
      dataAttribute: options.dataAttribute || 'data-sort',
      onChange: options.onChange || (() => {}),
      allowDeselect: options.allowDeselect || false,
      ...options
    };

    this.buttons = this.container.querySelectorAll('.filter');
    this._activeFilter = this._getActiveFilter();
    this._init();
  }

  _init() {
    this.buttons.forEach(button => {
      button.addEventListener('click', () => this._handleClick(button));
    });
  }

  _getActiveFilter() {
    const active = this.container.querySelector(`.${this.options.activeClass}`);
    return active ? active.dataset.sort : null;
  }

  _handleClick(clickedButton) {
    const filterValue = clickedButton.dataset.sort;
    
    // Check if clicking the already active filter
    if (filterValue === this._activeFilter && !this.options.allowDeselect) {
      return;
    }
    
    // Update active state
    this.buttons.forEach(button => {
      button.classList.remove(this.options.activeClass);
    });
    
    if (filterValue === this._activeFilter && this.options.allowDeselect) {
      // Deselect
      this._activeFilter = null;
    } else {
      // Select new filter
      clickedButton.classList.add(this.options.activeClass);
      this._activeFilter = filterValue;
    }
    
    // Callback
    this.options.onChange(this._activeFilter);
  }

  /**
   * Get the currently active filter
   * @returns {string|null} Active filter value
   */
  getActive() {
    return this._activeFilter;
  }

  /**
   * Set active filter programmatically
   * @param {string} filterValue - Filter value to set
   */
  setActive(filterValue) {
    this.buttons.forEach(button => {
      const isActive = button.dataset.sort === filterValue;
      button.classList.toggle(this.options.activeClass, isActive);
      if (isActive) this._activeFilter = filterValue;
    });
    this.options.onChange(this._activeFilter);
  }

  /**
   * Clear active filter
   */
  clear() {
    this.buttons.forEach(button => {
      button.classList.remove(this.options.activeClass);
    });
    this._activeFilter = null;
    this.options.onChange(null);
  }

  /**
   * Update filter options dynamically
   * @param {Array} filters - Array of { value, label, icon } objects
   */
  setFilters(filters) {
    this.container.innerHTML = filters.map(f => `
      <button class="filter" data-sort="${f.value}">
        ${f.icon ? `<span class="filter-icon">${f.icon}</span>` : ''}
        ${f.label}
      </button>
    `).join('');
    
    this.buttons = this.container.querySelectorAll('.filter');
    this._init();
  }

  /**
   * Destroy the component
   */
  destroy() {
    this.buttons.forEach(button => {
      button.replaceWith(button.cloneNode(true));
    });
  }
}