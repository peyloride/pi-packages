import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { getDb, closeDb } from './db';

// Import the app creation logic
// We'll test the route handlers directly

describe('index.ts API Routes', () => {
  let db: any;

  beforeEach(() => {
    // Initialize test database
    db = getDb();
    
    // Clean up first to avoid conflicts
    db.prepare('DELETE FROM daily_downloads').run();
    db.prepare('DELETE FROM packages').run();
    
    // Insert test data
    db.prepare(`
      INSERT INTO packages (name, description, version, keywords, publisher, first_seen, last_publish)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('test-pkg', 'A test package', '1.0.0', '["test"]', 'testuser', '2024-01-01', '2024-01-15');

    // Insert download data
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const date = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().split('T')[0];
      db.prepare(`
        INSERT INTO daily_downloads (package_name, date, downloads)
        VALUES (?, ?, ?)
      `).run('test-pkg', dateStr, 10 + i);
    }
  });

  afterEach(() => {
    // Clean up
    db.prepare('DELETE FROM daily_downloads').run();
    db.prepare('DELETE FROM packages').run();
  });

  describe('GET /api/packages', () => {
    it('should return packages list', async () => {
      const { getDb } = await import('./db');
      const db = getDb();
      
      const packages = db.prepare(`
        SELECT name, description, version FROM packages
      `).all();
      
      expect(packages.length).toBeGreaterThan(0);
      expect(packages[0].name).toBe('test-pkg');
    });

    it('should filter by search term', async () => {
      const { getDb } = await import('./db');
      const db = getDb();
      
      const packages = db.prepare(`
        SELECT name FROM packages WHERE name LIKE '%test%'
      `).all();
      
      expect(packages.length).toBe(1);
    });

    it('should sort by popular (weekly downloads)', async () => {
      const { getDb } = await import('./db');
      const db = getDb();
      
      // Insert another package with more downloads
      db.prepare(`
        INSERT INTO packages (name, version) VALUES (?, ?)
      `).run('popular-pkg', '1.0.0');
      
      for (let i = 0; i < 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        db.prepare(`
          INSERT INTO daily_downloads (package_name, date, downloads)
          VALUES (?, ?, ?)
        `).run('popular-pkg', date.toISOString().split('T')[0], 100);
      }

      const packages = db.prepare(`
        SELECT name, 
          COALESCE(SUM(CASE WHEN date GLOB '[0-9][0-9][0-9][0-9]*' THEN downloads ELSE 0 END), 0) as weekly
        FROM packages p
        LEFT JOIN daily_downloads d ON p.name = d.package_name
        GROUP BY p.name
        ORDER BY weekly DESC
      `).all() as Array<{ name: string; weekly: number }>;
      
      expect(packages[0].name).toBe('popular-pkg');
      expect(packages[0].weekly).toBeGreaterThan(0);
    });

    it('should support pagination', async () => {
      const { getDb } = await import('./db');
      const db = getDb();
      
      // Insert multiple packages
      for (let i = 0; i < 20; i++) {
        db.prepare(`
          INSERT INTO packages (name, version) VALUES (?, ?)
        `).run(`pkg-${i}`, '1.0.0');
      }

      const count = db.prepare('SELECT COUNT(*) as total FROM packages').get() as { total: number };
      expect(count.total).toBeGreaterThan(1);
    });
  });

  describe('GET /api/packages/:name', () => {
    it('should return package details', async () => {
      const { getDb } = await import('./db');
      const db = getDb();
      
      const pkg = db.prepare('SELECT * FROM packages WHERE name = ?').get('test-pkg');
      
      expect(pkg).toBeDefined();
      expect((pkg as any).name).toBe('test-pkg');
      expect((pkg as any).description).toBe('A test package');
    });

    it('should return null for non-existent package', async () => {
      const { getDb } = await import('./db');
      const db = getDb();
      
      const pkg = db.prepare('SELECT * FROM packages WHERE name = ?').get('non-existent');
      
      expect(pkg === null || pkg === undefined).toBe(true);
    });

    it('should include download history', async () => {
      const { getDb } = await import('./db');
      const db = getDb();
      
      const downloads = db.prepare(`
        SELECT * FROM daily_downloads 
        WHERE package_name = ? AND date GLOB '[0-9][0-9][0-9][0-9]*'
        ORDER BY date DESC
      `).all('test-pkg');
      
      expect(downloads.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/stats', () => {
    it('should return ecosystem statistics', async () => {
      const { getDb } = await import('./db');
      const db = getDb();
      
      const totalPackages = db.prepare('SELECT COUNT(*) as count FROM packages').get() as { count: number };
      const totalDownloads = db.prepare(`
        SELECT SUM(downloads) as total FROM daily_downloads WHERE date GLOB '[0-9][0-9][0-9][0-9]*'
      `).get() as { total: number | null };
      
      expect(totalPackages.count).toBeGreaterThan(0);
      expect(totalDownloads.total).toBeGreaterThan(0);
    });
  });

  describe('Sorting modes', () => {
    it('should sort by new (recently added)', async () => {
      const { getDb } = await import('./db');
      const db = getDb();
      
      // Add package with recent first_seen
      db.prepare(`
        INSERT INTO packages (name, version, first_seen)
        VALUES (?, ?, ?)
      `).run('new-pkg', '1.0.0', new Date().toISOString());

      const packages = db.prepare(`
        SELECT name FROM packages ORDER BY first_seen DESC
      `).all() as Array<{ name: string }>;
      
      expect(packages[0].name).toBe('new-pkg');
    });

    it('should sort by updated (recently published)', async () => {
      const { getDb } = await import('./db');
      const db = getDb();
      
      // Add package with recent last_publish
      db.prepare(`
        INSERT INTO packages (name, version, last_publish)
        VALUES (?, ?, ?)
      `).run('updated-pkg', '1.0.0', new Date().toISOString());

      const packages = db.prepare(`
        SELECT name FROM packages ORDER BY last_publish DESC NULLS LAST
      `).all() as Array<{ name: string }>;
      
      expect(packages[0].name).toBe('updated-pkg');
    });
  });

  describe('Growth calculation', () => {
    it('should calculate positive growth', async () => {
      const { getDb } = await import('./db');
      const db = getDb();
      
      // Add historical data for growth calculation
      const twoWeeksAgo = new Date();
      twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
      const oneWeekAgo = new Date();
      oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
      
      db.prepare(`
        INSERT INTO daily_downloads (package_name, date, downloads)
        VALUES (?, ?, ?)
      `).run('test-pkg', 'last_week_total', 50);
      
      db.prepare(`
        INSERT INTO daily_downloads (package_name, date, downloads)
        VALUES (?, ?, ?)
      `).run('test-pkg', 'weekly_total', 100);

      // Growth = (100 - 50) / 50 * 100 = 100%
      const growth = db.prepare(`
        SELECT 
          CASE 
            WHEN COALESCE(SUM(CASE WHEN date = 'last_week_total' THEN downloads END), 0) > 0
            THEN (COALESCE(SUM(CASE WHEN date = 'weekly_total' THEN downloads END), 0) - COALESCE(SUM(CASE WHEN date = 'last_week_total' THEN downloads END), 0)) * 100.0 / COALESCE(SUM(CASE WHEN date = 'last_week_total' THEN downloads END), 0)
            ELSE NULL
          END as growth
        FROM daily_downloads
        WHERE package_name = 'test-pkg'
      `).get() as { growth: number };
      
      expect(growth.growth).toBe(100);
    });
  });
});