import { debounce } from '../js/utils.js';

/**
 * Search Component
 * 
 * A search input with keyboard shortcut hint and debounced input handling.
 * 
 * Usage:
 *   const search = new Search('#search-input', {
 *     placeholder: 'Search packages...',
 *     onSearch: (value) => { console.log(value); }
 *   });
 * 
 * ═══════════════════════════════════════════════════════════════════ */

export class Search {
  /**
   * @param {string|HTMLElement} selector - Input element or selector
   * @param {Object} options - Configuration options
   */
  constructor(selector, options = {}) {
    this.input = typeof selector === 'string' 
      ? document.querySelector(selector) 
      : selector;
    
    if (!this.input) {
      console.error('Search: Input element not found');
      return;
    }

    this.options = {
      placeholder: options.placeholder || 'Search...',
      debounceDelay: options.debounceDelay || 250,
      onSearch: options.onSearch || (() => {}),
      shortcutKey: options.shortcutKey || '/',
      ...options
    };

    this.container = this.input.closest('.search') || this.input.parentElement;
    this._init();
  }

  _init() {
    // Set placeholder
    this.input.placeholder = this.options.placeholder;
    
    // Create keyboard shortcut hint if not exists
    if (!this.container.querySelector('.search-kbd')) {
      const kbd = document.createElement('kbd');
      kbd.className = 'search-kbd';
      kbd.textContent = this.options.shortcutKey;
      this.container.appendChild(kbd);
    }
    
    // Bind events
    this._handleInput = debounce(this._handleInput.bind(this), this.options.debounceDelay);
    this.input.addEventListener('input', this._handleInput);
    
    // Track input state
    this.input.addEventListener('input', () => {
      const hasInput = this.input.value.trim().length > 0;
      this.container.dataset.hasInput = hasInput;
    });
    
    // Global keyboard shortcut
    this._handleKeydown = this._handleKeydown.bind(this);
    document.addEventListener('keydown', this._handleKeydown);
  }

  _handleInput(e) {
    const value = e.target.value.trim();
    this.options.onSearch(value);
  }

  _handleKeydown(e) {
    // Focus search on shortcut key (if not already focused)
    if (e.key === this.options.shortcutKey && document.activeElement !== this.input) {
      e.preventDefault();
      this.input.focus();
    }
  }

  /**
   * Get current search value
   * @returns {string} Current value
   */
  getValue() {
    return this.input.value.trim();
  }

  /**
   * Set search value
   * @param {string} value - Value to set
   */
  setValue(value) {
    this.input.value = value;
    this.container.dataset.hasInput = value.trim().length > 0;
  }

  /**
   * Clear search input
   */
  clear() {
    this.input.value = '';
    this.container.dataset.hasInput = 'false';
    this.options.onSearch('');
  }

  /**
   * Focus the search input
   */
  focus() {
    this.input.focus();
  }

  /**
   * Destroy the component
   */
  destroy() {
    this.input.removeEventListener('input', this._handleInput);
    document.removeEventListener('keydown', this._handleKeydown);
  }
}