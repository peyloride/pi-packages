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
      
      // Mock the fetch response
      mockFetch.mockResolvedValueOnce({
        ok: true,
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

    it('should handle fetch errors', async () => {
      const { fetchPiPackages } = await import('./sync');
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      });

      await expect(fetchPiPackages()).rejects.toThrow('npm search failed');
    });

    it('should construct correct npm search URL', async () => {
      const { fetchPiPackages } = await import('./sync');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ total: 0, objects: [] })
      });

      await fetchPiPackages();
      
      expect(mockFetch).toHaveBeenCalled();
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('text=keywords:pi-package');
    });

    it('should handle pagination with multiple pages', async () => {
      const { fetchPiPackages } = await import('./sync');
      
      // First page
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ 
          total: 500, 
          objects: Array(250).fill(null).map((_, i) => ({
            package: { name: `pkg-${i}`, version: '1.0.0', links: { npm: `https://npmjs.com/pkg-${i}` } },
            updated: '2024-01-01'
          }))
        })
      });
      
      // Second page  
      mockFetch.mockResolvedValueOnce({
        ok: true,
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
      
      // Mock weekly downloads response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          'pkg1': { downloads: 100, package: 'pkg1', start: '2024-01-01', end: '2024-01-07' },
          'pkg2': { downloads: 200, package: 'pkg2', start: '2024-01-01', end: '2024-01-07' }
        })
      });
      
      // Mock monthly downloads response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          'pkg1': { downloads: 400, package: 'pkg1' },
          'pkg2': { downloads: 800, package: 'pkg2' }
        })
      });
      
      // Mock last week downloads response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          'pkg1': { downloads: 90, package: 'pkg1' },
          'pkg2': { downloads: 180, package: 'pkg2' }
        })
      });

      const downloads = await fetchDownloadsBatched(['pkg1', 'pkg2']);
      
      expect(downloads.size).toBe(2);
      expect(downloads.get('pkg1')?.weekly).toBe(100);
      expect(downloads.get('pkg1')?.monthly).toBe(400);
    });

    it('should handle empty package list', async () => {
      const { fetchDownloadsBatched } = await import('./sync');
      
      const downloads = await fetchDownloadsBatched([]);
      expect(downloads.size).toBe(0);
    });

    it('should handle failed fetch gracefully', async () => {
      const { fetchDownloadsBatched } = await import('./sync');
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500
      });
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500
      });
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500
      });

      const downloads = await fetchDownloadsBatched(['pkg1']);
      // Should return empty map when all requests fail
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
      
      // Verify it was inserted
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
    it('should insert download data', async () => {
      const { upsertPackage, upsertDownloads } = await import('./sync');
      
      // First insert the package
      upsertPackage({
        package: {
          name: 'test-pkg3',
          version: '1.0.0',
          links: { npm: 'https://npmjs.com/test-pkg3' }
        }
      });
      
      // Insert downloads
      upsertDownloads('test-pkg3', 100, 400, 90);
      
      const { getDb } = await import('./db');
      const db = getDb();
      const downloads = db.prepare('SELECT * FROM daily_downloads WHERE package_name = ?').all('test-pkg3');
      
      expect(downloads.length).toBeGreaterThan(0);
    });

    it('should update existing download data', async () => {
      const { upsertPackage, upsertDownloads } = await import('./sync');
      
      // First insert
      upsertPackage({
        package: {
          name: 'test-pkg4',
          version: '1.0.0',
          links: { npm: 'https://npmjs.com/test-pkg4' }
        }
      });
      
      upsertDownloads('test-pkg4', 100, 400, 90);
      upsertDownloads('test-pkg4', 200, 800, 180); // Update with new values
      
      const { getDb } = await import('./db');
      const db = getDb();
      const weekly = db.prepare('SELECT downloads FROM daily_downloads WHERE package_name = ? AND date = ?').get('test-pkg4', 'weekly_total') as { downloads: number };
      
      expect(weekly.downloads).toBe(200);
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

  describe('upsertDownloads edge cases', () => {
    it('should handle zero downloads', async () => {
      const { upsertPackage, upsertDownloads } = await import('./sync');
      
      upsertPackage({
        package: {
          name: 'zero-dl-pkg',
          version: '1.0.0',
          links: { npm: 'https://npmjs.com/zero-dl-pkg' }
        }
      });
      
      // Should not throw with zero downloads
      upsertDownloads('zero-dl-pkg', 0, 0, 0);
      
      const { getDb } = await import('./db');
      const db = getDb();
      const downloads = db.prepare('SELECT * FROM daily_downloads WHERE package_name = ?').all('zero-dl-pkg');
      expect(downloads.length).toBeGreaterThan(0);
    });
  });
});