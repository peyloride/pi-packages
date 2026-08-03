/**
 * Shared publisher display-name resolution.
 *
 * npm records the trusted-publisher OIDC user as `"GitHub Actions"` for
 * packages published keyless from a GitHub Actions workflow. That's not a
 * human author, so fall back to the GitHub repo owner parsed from
 * `github_url` (e.g. `https://github.com/MattDevy/pi-extensions` -> `MattDevy`).
 *
 * Returns the chosen display name, or the raw publisher as a fallback.
 * The raw npm username is preserved separately as `publisher_raw`.
 *
 * Lives in its own module so both /api/packages (index.ts) and the ecosystem
 * aggregation (ecosystem.ts) use the exact same mapping — the ecosystem
 * "top publishers" rankings must match what users see on package cards.
 */

export function resolvePublisher(
  publisher: string | null,
  githubUrl: string | null,
): { publisher: string | null; publisher_raw: string | null } {
  const raw = publisher;
  if (publisher && publisher !== 'GitHub Actions') {
    return { publisher, publisher_raw: raw };
  }
  if (githubUrl) {
    const cleaned = githubUrl.replace(/^git\+/, '').replace(/\.git$/, '');
    const m = cleaned.match(/github\.com\/([^/]+)/i);
    if (m && m[1] && m[1].toLowerCase() !== 'github') {
      return { publisher: m[1], publisher_raw: raw };
    }
  }
  return { publisher: publisher || null, publisher_raw: raw };
}

export default resolvePublisher;
