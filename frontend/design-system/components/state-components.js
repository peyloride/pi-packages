/**
 * State Components
 * 
 * Loading, empty, and error state components for consistent UI.
 * 
 * ═══════════════════════════════════════════════════════════════════ */

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
    <span>${message}</span>
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
    actionHtml = `<button class="empty-action">${action.label}</button>`;
  }

  container.innerHTML = `
    ${icon ? `<div class="empty-icon">${icon}</div>` : ''}
    <div class="empty-title">${title}</div>
    <p class="empty-message">${message}</p>
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
      <strong>${title}</strong>
      <p>${message}</p>
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