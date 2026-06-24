import { describe, it, expect, beforeEach, spyOn, mock } from 'bun:test';

// Mock fetch globally
const mockFetch = mock(() => Promise.resolve({
  ok: true,
  json: async () => ({ objects: [], total: 0 })
}));

global.fetch = mockFetch as any;

describe('sync.ts', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  describe('fetchPiPackages', () => {
    it('should fetch packages from npm registry', async () => {
      const { fetchPiPackages } = await import('./sync');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          total: 1,
          objects: [{
            package: {
              name: 'test-pkg',
              version: '1.0.0',
              description: 'Test package',
              links: { npm: 'https://npmjs.com/test-pkg' }
            },
            updated: '2024-01-01'
          }]
        })
      });

      const packages = await fetchPiPackages();
      expect(packages).toHaveLength(1);
      expect(packages[0].package.name).toBe('test-pkg');
    });

    it('should handle fetch errors without retries on 4xx', async () => {
      const { fetchPiPackages } = await import('./sync');
      
      // 403 doesn't trigger retries
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: { get: () => null },
      });

      await expect(fetchPiPackages()).rejects.toThrow('npm search failed');
    });

    it('should construct correct npm search URL', async () => {
      const { fetchPiPackages } = await import('./sync');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({ total: 0, objects: [] })
      });

      await fetchPiPackages();
      
      expect(mockFetch).toHaveBeenCalled();
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('text=keywords:pi-package');
    });

    it('should handle pagination with multiple pages', async () => {
      const { fetchPiPackages } = await import('./sync');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({ 
          total: 500, 
          objects: Array(250).fill(null).map((_, i) => ({
            package: { name: `pkg-${i}`, version: '1.0.0', links: { npm: `https://npmjs.com/pkg-${i}` } },
            updated: '2024-01-01'
          }))
        })
      });
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({ 
          total: 500, 
          objects: Array(250).fill(null).map((_, i) => ({
            package: { name: `pkg2-${i}`, version: '1.0.0', links: { npm: `https://npmjs.com/pkg2-${i}` } },
            updated: '2024-01-01'
          }))
        })
      });

      const packages = await fetchPiPackages();
      expect(packages.length).toBe(500);
    });
  });

  describe('fetchDownloadsBatched', () => {
    it('should fetch downloads for multiple packages', async () => {
      const { fetchDownloadsBatched } = await import('./sync');
      
      const day1 = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const day2 = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          'pkg1': { 
            downloads: [{ day: day1, downloads: 50 }, { day: day2, downloads: 50 }],
            package: 'pkg1', 
            start: day2, 
            end: day1 
          },
          'pkg2': { 
            downloads: [{ day: day1, downloads: 100 }, { day: day2, downloads: 100 }],
            package: 'pkg2', 
            start: day2, 
            end: day1 
          }
        })
      });
      
      const downloads = await fetchDownloadsBatched(['pkg1', 'pkg2']);
      
      expect(downloads.size).toBe(2);
    });

    it('should handle empty package list', async () => {
      const { fetchDownloadsBatched } = await import('./sync');
      
      const downloads = await fetchDownloadsBatched([]);
      expect(downloads.size).toBe(0);
    });

    it('should handle failed fetch gracefully', async () => {
      const { fetchDownloadsBatched } = await import('./sync');
      
      // 403 doesn't trigger retries
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: { get: () => null },
      });
      
      const downloads = await fetchDownloadsBatched(['pkg1']);
      expect(downloads.size).toBe(0);
    });
  });

  describe('upsertPackage', () => {
    it('should insert package into database', async () => {
      const { upsertPackage } = await import('./sync');
      
      const pkgResult = {
        package: {
          name: 'test-pkg',
          version: '1.0.0',
          description: 'Test package',
          keywords: ['test', 'pi'],
          publisher: { username: 'testuser' },
          links: {
            npm: 'https://npmjs.com/test-pkg',
            repository: 'https://github.com/test/test-pkg'
          },
          date: '2024-01-01'
        },
        updated: '2024-01-15'
      };

      upsertPackage(pkgResult);
      
      const { getDb } = await import('./db');
      const db = getDb();
      const pkg = db.prepare('SELECT * FROM packages WHERE name = ?').get('test-pkg');
      
      expect(pkg).toBeDefined();
      expect((pkg as any).version).toBe('1.0.0');
      expect((pkg as any).description).toBe('Test package');
    });

    it('should clean GitHub URL (remove git+ prefix and .git suffix)', async () => {
      const { upsertPackage } = await import('./sync');
      
      const pkgResult = {
        package: {
          name: 'test-pkg2',
          version: '1.0.0',
          links: {
            repository: 'git+https://github.com/test/repo.git'
          }
        }
      };

      upsertPackage(pkgResult);
      
      const { getDb } = await import('./db');
      const db = getDb();
      const pkg = db.prepare('SELECT github_url FROM packages WHERE name = ?').get('test-pkg2') as { github_url: string };
      
      expect(pkg.github_url).toBe('https://github.com/test/repo');
    });
  });

  describe('upsertDownloads', () => {
    it('should insert download data with daily map', async () => {
      const { upsertPackage, upsertDownloads } = await import('./sync');
      
      upsertPackage({
        package: {
          name: 'test-pkg3',
          version: '1.0.0',
          links: { npm: 'https://npmjs.com/test-pkg3' }
        }
      });
      
      const today = new Date().toISOString().split('T')[0];
      const daily = new Map<string, number>();
      daily.set(today, 42);
      daily.set(new Date(Date.now() - 86400000).toISOString().split('T')[0], 10);
      
      upsertDownloads('test-pkg3', { 
        daily, 
        weekly: 52, 
        monthly: 52, 
        lastWeek: 10 
      });
      
      const { getDb } = await import('./db');
      const db = getDb();
      const downloads = db.prepare('SELECT * FROM daily_downloads WHERE package_name = ?').all('test-pkg3');
      
      expect(downloads.length).toBe(2);
    });

    it('should update existing download data by replacing', async () => {
      const { upsertPackage, upsertDownloads } = await import('./sync');
      
      upsertPackage({
        package: {
          name: 'test-pkg4',
          version: '1.0.0',
          links: { npm: 'https://npmjs.com/test-pkg4' }
        }
      });
      
      const today = new Date().toISOString().split('T')[0];
      
      // First insert
      upsertDownloads('test-pkg4', { 
        daily: new Map([[today, 100]]), 
        weekly: 100, 
        monthly: 100, 
        lastWeek: 0 
      });
      
      // Replace with new values
      upsertDownloads('test-pkg4', { 
        daily: new Map([[today, 200]]), 
        weekly: 200, 
        monthly: 200, 
        lastWeek: 0 
      });
      
      const { getDb } = await import('./db');
      const db = getDb();
      const row = db.prepare('SELECT downloads FROM daily_downloads WHERE package_name = ? AND date = ?').get('test-pkg4', today) as { downloads: number };
      
      expect(row.downloads).toBe(200);
    });
  });

  describe('diffPackages', () => {
    it('should identify new, updated, and unchanged packages', async () => {
      const { diffPackages, upsertPackage } = await import('./sync');
      
      // Pre-populate DB with existing packages
      upsertPackage({
        package: { name: 'existing-pkg', version: '1.0.0', links: { npm: 'https://npmjs.com/existing-pkg' } },
        updated: '2024-01-01T00:00:00.000Z',
      });
      
      upsertPackage({
        package: { name: 'unchanged-pkg', version: '2.0.0', links: { npm: 'https://npmjs.com/unchanged-pkg' } },
        updated: '2024-06-01T00:00:00.000Z',
      });
      
      const fetchedPackages = [
        // New — not in DB
        { package: { name: 'brand-new-pkg', version: '0.1.0', links: { npm: 'https://npmjs.com/brand-new-pkg' } }, updated: '2024-07-01T00:00:00.000Z' },
        // Updated — version changed
        { package: { name: 'existing-pkg', version: '2.0.0', links: { npm: 'https://npmjs.com/existing-pkg' } }, updated: '2024-07-01T00:00:00.000Z' },
        // Unchanged
        { package: { name: 'unchanged-pkg', version: '2.0.0', links: { npm: 'https://npmjs.com/unchanged-pkg' } }, updated: '2024-06-01T00:00:00.000Z' },
      ];
      
      const diff = diffPackages(fetchedPackages);
      expect(diff.newPackages.length).toBe(1);
      expect(diff.newPackages[0].package.name).toBe('brand-new-pkg');
      expect(diff.updatedPackages.length).toBe(1);
      expect(diff.updatedPackages[0].package.name).toBe('existing-pkg');
      expect(diff.unchangedPackages.length).toBe(1);
      expect(diff.unchangedPackages[0].package.name).toBe('unchanged-pkg');
    });
  });

  describe('runSync', () => {
    it('should be a function that can be called', async () => {
      const { runSync } = await import('./sync');
      expect(typeof runSync).toBe('function');
    });
  });

  describe('edge cases', () => {
    it('should handle packages with null description', async () => {
      const { upsertPackage } = await import('./sync');
      
      upsertPackage({
        package: {
          name: 'no-desc-pkg',
          version: '1.0.0',
          links: { npm: 'https://npmjs.com/no-desc-pkg' }
        }
      });
      
      const { getDb } = await import('./db');
      const db = getDb();
      const pkg = db.prepare('SELECT * FROM packages WHERE name = ?').get('no-desc-pkg');
      
      expect(pkg).toBeDefined();
      expect((pkg as any).description).toBeNull();
    });

    it('should handle packages with no keywords', async () => {
      const { upsertPackage } = await import('./sync');
      
      upsertPackage({
        package: {
          name: 'no-keywords-pkg',
          version: '1.0.0',
          description: 'Test',
          links: { npm: 'https://npmjs.com/no-keywords-pkg' }
        }
      });
      
      const { getDb } = await import('./db');
      const db = getDb();
      const pkg = db.prepare('SELECT keywords FROM packages WHERE name = ?').get('no-keywords-pkg') as { keywords: string | null };
      
      expect(pkg.keywords).toBeNull();
    });

    it('should handle packages with no publisher', async () => {
      const { upsertPackage } = await import('./sync');
      
      upsertPackage({
        package: {
          name: 'no-publisher-pkg',
          version: '1.0.0',
          description: 'Test',
          links: { npm: 'https://npmjs.com/no-publisher-pkg' }
        }
      });
      
      const { getDb } = await import('./db');
      const db = getDb();
      const pkg = db.prepare('SELECT publisher FROM packages WHERE name = ?').get('no-publisher-pkg') as { publisher: string | null };
      
      expect(pkg.publisher).toBeNull();
    });

    it('should handle packages with no repository link', async () => {
      const { upsertPackage } = await import('./sync');
      
      upsertPackage({
        package: {
          name: 'no-repo-pkg',
          version: '1.0.0',
          description: 'Test',
          links: { npm: 'https://npmjs.com/no-repo-pkg' }
        }
      });
      
      const { getDb } = await import('./db');
      const db = getDb();
      const pkg = db.prepare('SELECT github_url FROM packages WHERE name = ?').get('no-repo-pkg') as { github_url: string | null };
      
      expect(pkg.github_url).toBeNull();
    });
  });
});
