# PI Design System

A shared design system for pi coding agent extensions. Built with a technical/utilitarian aesthetic—information-dense, performance-conscious, and distinctly memorable.

## Philosophy

- **Data over decoration** — Every visual element serves a functional purpose
- **High information density** — Show meaningful metrics without clutter
- **OKLCH colors** — Perceptually uniform palette with subtle violet tinting
- **4px spacing scale** — Consistent rhythm throughout

## Installation

```bash
# Copy the design-system folder to your project
cp -r design-system/ your-project/
```

## Usage

### CSS

Import tokens and components:

```css
/* In your main CSS file */
@import './design-system/css/tokens.css';
@import './design-system/css/components.css';

/* Your component styles */
.my-app {
  background: var(--bg-deep);
  color: var(--text-primary);
}
```

### JavaScript

Import utilities and components:

```javascript
// Import individual utilities
import { formatNumber, timeAgo, debounce, copyToClipboard } from './design-system/js/utils.js';

// Import individual components
import { Search } from './design-system/components/search.js';
import { FilterGroup } from './design-system/components/filter-group.js';
import { PackageCard, renderPackageList } from './design-system/components/package-card.js';
import { Pagination } from './design-system/components/pagination.js';
import { LoadingState, EmptyState, ErrorState } from './design-system/components/state-components.js';

// Or import everything
import { Search, PackageCard, Pagination, formatNumber } from './design-system/index.js';
```

## Design Tokens

### Colors

```css
/* Backgrounds */
--bg-deep      /* Deepest background */
--bg-raised    /* Elevated surfaces */
--bg-surface   /* Cards, inputs */
--bg-hover     /* Hover states */

/* Text */
--text-primary   /* Main text */
--text-secondary /* Supporting text */
--text-tertiary  /* Hints, metadata */

/* Accent */
--accent        /* Primary accent */
--accent-dim    /* Dimmed accent */
--accent-bright /* Bright accent */

/* Semantic */
--success       /* Positive states */
--danger        /* Error, negative */
--warning       /* Caution states */
```

### Typography

```css
/* Fonts */
--font-ui    /* UI text (Uncut Sans) */
--font-mono  /* Code (JetBrains Mono) */

/* Sizes */
--text-xs   /* 12px */
--text-sm   /* 14px */
--text-base /* 16px */
--text-lg   /* 18px */
--text-xl   /* 24px */

/* Weights */
--font-normal   /* 400 */
--font-medium   /* 500 */
--font-semibold /* 600 */
--font-bold     /* 700 */
```

### Spacing

```css
/* Semantic names */
--space-xs  /* 4px */
--space-sm  /* 8px */
--space-md  /* 16px */
--space-lg  /* 24px */
--space-xl  /* 32px */
--space-2xl /* 48px */
```

### Layout

```css
/* Container widths */
--max-width-sm  /* 640px */
--max-width-md  /* 900px */
--max-width-lg  /* 1200px */

/* Heights */
--height-sm  /* 32px */
--height-md  /* 40px */
--height-lg  /* 48px */

/* Radius */
--radius-sm  /* 4px */
--radius-md  /* 6px */
--radius-lg  /* 8px */
--radius-xl  /* 12px */
```

## Components

### Search

```javascript
const search = new Search('#search-input', {
  placeholder: 'Search packages...',
  debounceDelay: 250,
  shortcutKey: '/',
  onSearch: (value) => {
    console.log('Search:', value);
  }
});

// Methods
search.getValue();
search.setValue('react');
search.clear();
search.focus();
search.destroy();
```

### FilterGroup

```javascript
const filters = new FilterGroup('.filters', {
  onChange: (activeFilter) => {
    console.log('Active filter:', activeFilter);
  }
});

// Methods
filters.getActive();
filters.setActive('trending');
filters.clear();
```

### PackageCard

```javascript
const card = new PackageCard({
  name: '@pi-extensions/react',
  version: '1.2.0',
  description: 'React bindings for pi',
  weekly_downloads: 15000,
  total_downloads: 150000,
  growth: 12.5,
  github_url: 'https://github.com/...',
  npm_url: 'https://npmjs.com/...',
  last_publish: '2024-01-15',
  publisher: 'pi-team'
}, {
  onNameClick: (pkg) => { /* ... */ },
  onCopy: (cmd) => { /* ... */ }
});

// Or render multiple
const fragment = renderPackageList(packages, { showTrend: true });
container.appendChild(fragment);
```

### Pagination

```javascript
const pagination = new Pagination('#pagination', {
  total: 100,
  limit: 20,
  current: 1,
  onChange: (page) => {
    console.log('Page:', page);
  }
});

// Methods
pagination.goToPage(3);
pagination.next();
pagination.prev();
pagination.first();
pagination.last();
pagination.update({ total: 200 });
pagination.destroy();
```

### State Components

```javascript
// Loading
const loading = LoadingState({ message: 'Loading packages...' });
container.appendChild(loading);

// Empty
const empty = EmptyState({
  title: 'No packages found',
  message: 'Try adjusting your search',
  action: {
    label: 'Clear filters',
    onClick: () => { /* ... */ }
  }
});

// Error
const error = ErrorState({
  message: 'Failed to load packages',
  onRetry: () => { loadPackages(); }
});
```

## Utilities

```javascript
// Number formatting
formatNumber(1500000);     // "1.5M"
formatNumber(1500);        // "1.5K"
formatNumber(150);         // "150"

// Relative time
timeAgo('2024-01-15T10:00:00Z'); // "2h ago"

// Debounce
const debouncedSearch = debounce((query) => {
  // search logic
}, 300);

// Throttle
const throttledScroll = throttle(() => {
  // scroll logic
}, 100);

// Clipboard
await copyToClipboard('pi install package');

// Other utilities
generateId();        // "id-123456-abc123"
parseQuery('?q=test&page=2'); // { q: 'test', page: '2' }
buildQuery({ q: 'test', page: 2 }); // "q=test&page=2"
clamp(150, 0, 100);  // 100
prefersReducedMotion(); // boolean
truncate('long text...', 10); // "long tex..."
```

## Browser Support

- Modern browsers (Chrome, Firefox, Safari, Edge)
- ES2020+ for JavaScript modules
- CSS custom properties (no IE11 support)

## License

MIT