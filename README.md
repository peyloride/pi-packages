# Pi Extension Dashboard

A dashboard for discovering trending, popular, and new pi extension packages.

## Features

- **Trending View**: See packages with the highest week-over-week download growth
- **Popular View**: Browse packages sorted by weekly downloads
- **New Packages**: Discover recently added pi extensions
- **Recently Updated**: Track the latest package updates
- **Search**: Filter packages by name or description
- **Period Toggle**: View download stats and growth by day, week, or month
- **Two-Tier Sync**: Frequent incremental syncs plus a daily full refresh from npm

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 22 (the database uses the built-in `node:sqlite`)
- [Nub](https://nubjs.com/) >= 0.1.0 (install: `curl -fsSL https://nubjs.com/install.sh | bash`)

### Development

```bash
# Install dependencies
nub install

# Run the sync to populate the database
nub run sync

# Start the development server
nub run dev
```

The dashboard will be available at http://localhost:3000

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/packages` | List packages with sorting (`trending`, `popular`, `new`, `updated`) |
| `GET /api/packages/:name` | Get package details with download history |
| `GET /api/stats` | Get ecosystem statistics |

#### Query Parameters

- `sort`: Sort order (`trending`, `popular`, `new`, `updated`)
- `period`: Download window for stats and growth (`daily`, `weekly`, `monthly`; default `weekly`)
- `search`: Filter by name or description
- `limit`: Results per page (default: 50, max: 100)
- `offset`: Pagination offset

Example:
```
GET /api/packages?sort=trending&period=weekly&limit=20&offset=0
```

## Docker Deployment

```bash
# Build the image
docker build -t pi-extension-dashboard .

# Run with Docker
docker run -p 3000:3000 -v pi-data:/app/data pi-extension-dashboard

# Or use docker-compose
docker-compose up -d
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `DB_PATH` | `./data/dashboard.db` | SQLite database path |
| `SYNC_CRON` | `0 */4 * * *` | Cron schedule for the incremental sync (every 4h) |
| `SYNC_FULL_CRON` | `0 3 * * *` | Cron schedule for the full sync (daily, 3 AM UTC) |

The Docker Compose file overrides `SYNC_CRON` to `0 * * * *` (hourly incremental).

## Architecture

```
pi-extension-dashboard/
├── backend/
│   ├── index.ts      # Hono server + API routes (app factory)
│   ├── sync.ts       # NPM data synchronization (incremental + full)
│   ├── cron.ts       # Scheduled job management
│   ├── db.ts         # SQLite setup + schema migrations
│   ├── growth.ts     # Materialized per-package growth percentages
│   ├── stats.ts      # Materialized ecosystem statistics
│   ├── assets.ts     # Version-stamped in-memory static asset cache
│   └── compress.ts   # Brotli/gzip response compression middleware
├── frontend/
│   ├── index.html    # Single-page dashboard
│   ├── app.js        # Dashboard interactions
│   ├── styles.css    # App layout
│   └── design-system/  # Shared components, tokens, and utilities
├── data/             # SQLite database files
├── Dockerfile
└── docker-compose.yml
```

## Data Sources

- **Package Discovery**: [npm registry search API](https://registry.npmjs.org/-/v1/search)
- **Download Counts**: [npm downloads API](https://api.npmjs.org/downloads/range)

Packages are filtered by the `pi-package` keyword.

## Sync & Rate Limiting

The sync service is designed to stay within npm's acceptable use policy:

- **Incremental sync** (default every 4h, `SYNC_CRON`): re-discovers the package
  list, upserts only new/changed metadata, and fetches a delta of download
  history for unchanged packages (full 30–60 day history for new/updated ones).
- **Full sync** (default daily at 3 AM UTC, `SYNC_FULL_CRON`): re-fetches all
  metadata and the full download window for every package.
- Download counts are fetched with up to 8 concurrent requests against npm's
  bulk `/range` endpoint (scoped packages are fetched individually), with a
  500ms delay between search pages.
- Transient failures (429 / 5xx) are retried up to 5 times with exponential
  backoff, honouring `Retry-After`.
- 60 days of per-package download history are retained so month-over-month
  growth has a baseline to compare against.

## Tech Stack

- **Runtime**: [Node.js](https://nodejs.org/) + [Nub](https://nubjs.com/) (TypeScript, watch mode, package management)
- **Framework**: [Hono](https://honojs.dev/)
- **Server**: [@hono/node-server](https://github.com/honojs/node-server)
- **Database**: SQLite (via `node:sqlite`)
- **Frontend**: Vanilla HTML/CSS/JS (no build step)

## License

MIT
