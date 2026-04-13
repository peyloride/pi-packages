# Pi Extension Dashboard

A dashboard for discovering trending, popular, and new pi extension packages.

## Features

- **Trending View**: See packages with the highest week-over-week download growth
- **Popular View**: Browse packages sorted by weekly downloads
- **New Packages**: Discover recently added pi extensions
- **Recently Updated**: Track the latest package updates
- **Search**: Filter packages by name or description
- **Daily Sync**: Automatic data collection from npm at 3 AM UTC

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0

### Development

```bash
# Install dependencies
bun install

# Run the sync to populate the database
bun run sync

# Start the development server
bun run dev
```

The dashboard will be available at http://localhost:3000

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/packages` | List packages with sorting (`trending`, `popular`, `new`, `updated`) |
| `GET /api/packages/:name` | Get package details with download history |
| `GET /api/stats` | Get ecosystem statistics |
| `POST /api/sync` | Manually trigger package sync |

#### Query Parameters

- `sort`: Sort order (`trending`, `popular`, `new`, `updated`)
- `search`: Filter by name or description
- `limit`: Results per page (default: 50, max: 100)
- `offset`: Pagination offset

Example:
```
GET /api/packages?sort=trending&limit=20&offset=0
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
| `SYNC_CRON` | `0 3 * * *` | Cron schedule for daily sync |

## Architecture

```
pi-extension-dashboard/
├── backend/
│   ├── index.ts      # Hono server + API routes
│   ├── sync.ts       # NPM data synchronization
│   ├── cron.ts       # Scheduled job management
│   └── db.ts         # SQLite database setup
├── frontend/
│   ├── index.html    # Single-page dashboard
│   ├── styles.css    # Responsive styling
│   └── app.js        # Dashboard interactions
├── data/             # SQLite database files
├── Dockerfile
└── docker-compose.yml
```

## Data Sources

- **Package Discovery**: [npm registry search API](https://registry.npmjs.org/-/v1/search)
- **Download Counts**: [npm downloads API](https://api.npmjs.org/downloads/range)

Packages are filtered by the `pi-package` keyword.

## Rate Limiting

The sync service respects npm's acceptable use policy:
- Maximum 10 requests/second
- 100ms delay between requests
- Runs daily at 3 AM UTC to avoid peak hours

## Tech Stack

- **Runtime**: [Bun](https://bun.sh/)
- **Framework**: [Hono](https://honojs.dev/)
- **Database**: SQLite (via `bun:sqlite`)
- **Frontend**: Vanilla HTML/CSS/JS (no build step)

## License

MIT
