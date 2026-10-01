/**
 * State Components
 *
 * Loading, empty, and error state components for consistent UI.
 *
 * All string options are HTML-escaped before interpolation: these components
 * are the natural place to surface API error messages and dataset-derived
 * text, so the sinks defend themselves (defense-in-depth against stored XSS
 * from a future caller).
 *
 * ═══════════════════════════════════════════════════════════════════ */

import { escapeHtml } from '../js/utils.js';

/**
 * Loading State Component
 * @param {Object} options - Configuration options
 * @returns {HTMLElement} Loading element
 */
export function LoadingState(options = {}) {
  const {
    message = 'Loading...',
    showSpinner = true,
    size = 'md'
  } = options;

  const container = document.createElement('div');
  container.className = 'loading';

  let spinnerHtml = '';
  if (showSpinner) {
    spinnerHtml = `<div class="loading-spinner ${size !== 'md' ? `loading-spinner-${size}` : ''}"></div>`;
  }

  container.innerHTML = `
    ${spinnerHtml}
    <span>${escapeHtml(message)}</span>
  `;

  return container;
}

/**
 * Empty State Component
 * @param {Object} options - Configuration options
 * @returns {HTMLElement} Empty state element
 */
export function EmptyState(options = {}) {
  const {
    title = 'Nothing here',
    message = 'No items to display',
    icon = '',
    action = null
  } = options;

  const container = document.createElement('div');
  container.className = 'empty';

  let actionHtml = '';
  if (action) {
    actionHtml = `<button class="empty-action">${escapeHtml(action.label)}</button>`;
  }

  container.innerHTML = `
    ${icon ? `<div class="empty-icon">${escapeHtml(icon)}</div>` : ''}
    <div class="empty-title">${escapeHtml(title)}</div>
    <p class="empty-message">${escapeHtml(message)}</p>
    ${actionHtml}
  `;

  // Bind action if provided
  if (action && action.onClick) {
    const actionBtn = container.querySelector('.empty-action');
    actionBtn.addEventListener('click', action.onClick);
  }

  return container;
}

/**
 * Error State Component
 * @param {Object} options - Configuration options
 * @returns {HTMLElement} Error state element
 */
export function ErrorState(options = {}) {
  const {
    title = 'Something went wrong',
    message = 'An error occurred while loading',
    showRetry = true,
    onRetry = null
  } = options;

  const container = document.createElement('div');
  container.className = 'error';

  let retryHtml = '';
  if (showRetry) {
    retryHtml = `<button class="retry-btn">Retry</button>`;
  }

  container.innerHTML = `
    <div class="error-message">
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(message)}</p>
    </div>
    ${retryHtml}
  `;

  // Bind retry if provided
  if (showRetry && onRetry) {
    const retryBtn = container.querySelector('.retry-btn');
    retryBtn.addEventListener('click', onRetry);
  }

  return container;
}