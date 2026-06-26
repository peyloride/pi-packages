import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.DB_PATH || './data/dashboard.db';

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL;');
    initializeSchema(db);
  }
  return db;
}

export function initializeSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS packages (
      name TEXT PRIMARY KEY,
      description TEXT,
      version TEXT,
      keywords TEXT,
      publisher TEXT,
      github_url TEXT,
      npm_url TEXT,
      first_seen TEXT,
      last_publish TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_downloads (
      package_name TEXT,
      date TEXT,
      downloads INTEGER,
      PRIMARY KEY (package_name, date),
      FOREIGN KEY (package_name) REFERENCES packages(name)
    );

    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_downloads_package ON daily_downloads(package_name);
    CREATE INDEX IF NOT EXISTS idx_downloads_date ON daily_downloads(date);
    CREATE INDEX IF NOT EXISTS idx_packages_first_seen ON packages(first_seen);
    CREATE INDEX IF NOT EXISTS idx_packages_last_publish ON packages(last_publish);
  `);

  // Materialized growth columns. Populated by recomputeGrowthCache() at sync
  // time so /api/packages reads them directly instead of recomputing the
  // 5+ SUM(CASE) aggregates per request (~5ms / 33% of every cold-miss query).
  // Nullable: NULL until the first sync after this migration runs.
  addColumnIfMissing(database, 'packages', 'daily_growth', 'REAL');
  addColumnIfMissing(database, 'packages', 'weekly_growth', 'REAL');
  addColumnIfMissing(database, 'packages', 'monthly_growth', 'REAL');
}

/**
 * SQLite has no ADD COLUMN IF NOT EXISTS. Probe PRAGMA table_info and ALTER
 * only when the column is absent. Safe to call on every boot.
 */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
