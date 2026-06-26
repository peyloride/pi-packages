import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { getDb, initializeSchema, closeDb } from './db';

describe('db.ts', () => {
  let testDb: DatabaseSync;

  beforeEach(() => {
    // Create in-memory database for testing
    testDb = new DatabaseSync(':memory:');
    initializeSchema(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  describe('initializeSchema', () => {
    it('should create packages table', () => {
      const result = testDb.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='packages'
      `).get() as { name: string } | undefined;
      assert.equal(result?.name, 'packages');
    });

    it('should create daily_downloads table', () => {
      const result = testDb.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='daily_downloads'
      `).get() as { name: string } | undefined;
      assert.equal(result?.name, 'daily_downloads');
    });

    it('should create indexes', () => {
      const indexes = testDb.prepare(`
        SELECT name FROM sqlite_master WHERE type='index'
      `).all() as Array<{ name: string }>;
      const indexNames = indexes.map(i => i.name);
      assert.ok(indexNames.includes('idx_downloads_package'));
      assert.ok(indexNames.includes('idx_downloads_date'));
      assert.ok(indexNames.includes('idx_packages_first_seen'));
      assert.ok(indexNames.includes('idx_packages_last_publish'));
    });

    it('should have correct columns in packages table', () => {
      const columns = testDb.prepare('PRAGMA table_info(packages)').all() as Array<{ name: string }>;
      const columnNames = columns.map(c => c.name);
      assert.ok(columnNames.includes('name'));
      assert.ok(columnNames.includes('description'));
      assert.ok(columnNames.includes('version'));
      assert.ok(columnNames.includes('keywords'));
      assert.ok(columnNames.includes('publisher'));
      assert.ok(columnNames.includes('github_url'));
      assert.ok(columnNames.includes('npm_url'));
      assert.ok(columnNames.includes('first_seen'));
      assert.ok(columnNames.includes('last_publish'));
    });

    it('should have correct columns in daily_downloads table', () => {
      const columns = testDb.prepare('PRAGMA table_info(daily_downloads)').all() as Array<{ name: string }>;
      const columnNames = columns.map(c => c.name);
      assert.ok(columnNames.includes('package_name'));
      assert.ok(columnNames.includes('date'));
      assert.ok(columnNames.includes('downloads'));
    });

    it('should create sync_meta table', () => {
      const result = testDb.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='sync_meta'
      `).get() as { name: string } | undefined;
      assert.equal(result?.name, 'sync_meta');
    });

    it('should have correct columns in sync_meta table', () => {
      const columns = testDb.prepare('PRAGMA table_info(sync_meta)').all() as Array<{ name: string }>;
      const columnNames = columns.map(c => c.name);
      assert.ok(columnNames.includes('key'));
      assert.ok(columnNames.includes('value'));
    });

    it('should add materialized growth columns via idempotent migration', () => {
      const columns = testDb.prepare('PRAGMA table_info(packages)').all() as Array<{ name: string }>;
      const columnNames = columns.map(c => c.name);
      assert.ok(columnNames.includes('daily_growth'));
      assert.ok(columnNames.includes('weekly_growth'));
      assert.ok(columnNames.includes('monthly_growth'));

      // Re-running initializeSchema on an already-migrated DB must be a no-op
      // (no "duplicate column" error). This mirrors db.ts's runtime behavior
      // where initializeSchema runs on every getDb() call.
      assert.doesNotThrow(() => initializeSchema(testDb));
    });
  });

  describe('packages CRUD', () => {
    it('should insert a package', () => {
      testDb.prepare(`
        INSERT INTO packages (name, description, version, publisher, first_seen, last_publish)
        VALUES ($name, $description, $version, $publisher, $first_seen, $last_publish)
      `).run({
        $name: 'test-package',
        $description: 'A test package',
        $version: '1.0.0',
        $publisher: 'testuser',
        $first_seen: '2024-01-01',
        $last_publish: '2024-01-15',
      });

      const pkg = testDb.prepare('SELECT * FROM packages WHERE name = $name').get({ $name: 'test-package' });
      assert.ok(pkg);
      assert.equal((pkg as { description: string }).description, 'A test package');
    });

    it('should update a package on conflict', () => {
      // Insert first
      testDb.prepare(`
        INSERT INTO packages (name, description, version, publisher)
        VALUES ($name, $description, $version, $publisher)
      `).run({
        $name: 'test-package',
        $description: 'Original',
        $version: '1.0.0',
        $publisher: 'user1',
      });

      // Update via conflict
      testDb.prepare(`
        INSERT INTO packages (name, description, version, publisher)
        VALUES ($name, $description, $version, $publisher)
        ON CONFLICT(name) DO UPDATE SET description = excluded.description
      `).run({
        $name: 'test-package',
        $description: 'Updated',
        $version: '1.0.1',
        $publisher: 'user2',
      });

      const pkg = testDb.prepare('SELECT * FROM packages WHERE name = $name').get({ $name: 'test-package' });
      assert.equal((pkg as { description: string }).description, 'Updated');
    });

    it('should delete a package', () => {
      testDb.prepare(`
        INSERT INTO packages (name, version) VALUES ($name, $version)
      `).run({ $name: 'to-delete', $version: '1.0.0' });

      testDb.prepare('DELETE FROM packages WHERE name = $name').run({ $name: 'to-delete' });

      const pkg = testDb.prepare('SELECT * FROM packages WHERE name = $name').get({ $name: 'to-delete' });
      // node:sqlite's Statement.get() returns undefined when no row matches
      // (bun:sqlite returned null). Either "no row" answer is acceptable.
      assert.equal(pkg, undefined);
    });
  });

  describe('daily_downloads CRUD', () => {
    beforeEach(() => {
      // Insert a package first
      testDb.prepare(`
        INSERT INTO packages (name, version) VALUES ($name, $version)
      `).run({ $name: 'test-pkg', $version: '1.0.0' });
    });

    it('should insert download data', () => {
      testDb.prepare(`
        INSERT INTO daily_downloads (package_name, date, downloads)
        VALUES ($package_name, $date, $downloads)
      `).run({
        $package_name: 'test-pkg',
        $date: '2024-01-01',
        $downloads: 100,
      });

      const downloads = testDb.prepare('SELECT * FROM daily_downloads WHERE package_name = $name').all({ $name: 'test-pkg' });
      assert.equal(downloads.length, 1);
      assert.equal((downloads[0] as { downloads: number }).downloads, 100);
    });

    it('should aggregate downloads correctly', () => {
      // Insert multiple days
      for (let i = 0; i < 7; i++) {
        const date = new Date(2024, 0, i + 1).toISOString().split('T')[0];
        testDb.prepare(`
          INSERT INTO daily_downloads (package_name, date, downloads)
          VALUES ($package_name, $date, $downloads)
        `).run({ $package_name: 'test-pkg', $date: date, $downloads: 10 + i });
      }

      const total = testDb.prepare(`
        SELECT SUM(downloads) as total FROM daily_downloads
        WHERE package_name = $name AND date GLOB '[0-9][0-9][0-9][0-9]*'
      `).get({ $name: 'test-pkg' }) as { total: number };
      assert.equal(total.total, 91); // 10+11+12+13+14+15+16
    });
  });

  describe('closeDb', () => {
    it('should close the database connection', () => {
      // Get a database connection first
      const database = getDb();
      assert.ok(database);

      // Close it
      closeDb();

      // After closing, getDb should create a new connection
      const database2 = getDb();
      assert.ok(database2);
    });

    it('should handle multiple close calls', () => {
      // Close when already closed should not throw
      closeDb();
      closeDb();
      assert.ok(true);
    });
  });
});
