/**
 * Cross-platform update check.
 *
 * The desktop (Electron) build updates itself through `electron-updater` +
 * GitHub Releases. The web/PWA and mobile builds have no native updater, so they
 * use this module instead: it asks the public GitHub Releases API what the
 * latest version is, compares it to the running version, and surfaces the
 * release notes ("what's changed") plus a download link.
 *
 * This module is deliberately free of any DOM or Node specifics so it can be
 * unit-tested with an injected `fetch` implementation.
 */

export const UPDATE_RELEASE_REPO = { owner: 'sensei628', repo: 'Hypertroph-plus' } as const;

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface ReleaseInfo {
  /** Normalised version, e.g. "0.2.0" (leading "v" stripped). */
  version: string;
  /** Raw tag as published, e.g. "v0.2.0". */
  tag: string;
  /** Human name, falls back to the tag. */
  name: string;
  /** Release notes / changelog (markdown). Empty string when none. */
  notes: string;
  /** Public page for the release. */
  htmlUrl: string;
  assets: ReleaseAsset[];
}

export interface UpdateCheck {
  current: string;
  latest: string;
  hasUpdate: boolean;
  notes: string;
  htmlUrl: string;
  /** Best download link for an installed desktop app (.exe/.msi), if present. */
  installerUrl: string | null;
  /** Best download link for an Android sideload (.apk), if present. */
  apkUrl: string | null;
}

/** Strip a leading "v"/"V" and surrounding whitespace. */
export function normalizeVersion(v: string): string {
  return String(v ?? '').trim().replace(/^v/i, '');
}

/** Split a version into numeric components, ignoring any pre-release suffix. */
function parts(v: string): number[] {
  return normalizeVersion(v)
    .split('-')[0]
    .split('.')
    .map((p) => Number.parseInt(p, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
}

/**
 * Compare two versions. Returns -1 if `a` < `b`, 0 if equal, 1 if `a` > `b`.
 * Missing components count as 0 ("0.1" === "0.1.0").
 */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** True when `candidate` is strictly newer than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/** Parse the GitHub "latest release" payload into a normalised ReleaseInfo. */
export function parseRelease(json: unknown): ReleaseInfo {
  const r = (json ?? {}) as Record<string, unknown>;
  const tag = String(r.tag_name ?? r.name ?? '');
  const assetsRaw = Array.isArray(r.assets) ? (r.assets as Record<string, unknown>[]) : [];
  return {
    version: normalizeVersion(tag),
    tag,
    name: String(r.name ?? tag),
    notes: typeof r.body === 'string' ? r.body : '',
    htmlUrl: String(r.html_url ?? ''),
    assets: assetsRaw.map((a) => ({
      name: String(a.name ?? ''),
      url: String(a.browser_download_url ?? ''),
      size: Number(a.size ?? 0),
    })),
  };
}

/** Pick the Windows installer asset from a release, if present. */
export function findInstallerAsset(release: ReleaseInfo): ReleaseAsset | null {
  return (
    release.assets.find((a) => a.name.toLowerCase().endsWith('.exe')) ??
    release.assets.find((a) => a.name.toLowerCase().endsWith('.msi')) ??
    null
  );
}

/** Pick the Android sideload asset from a release, if present. */
export function findApkAsset(release: ReleaseInfo): ReleaseAsset | null {
  return release.assets.find((a) => a.name.toLowerCase().endsWith('.apk')) ?? null;
}

/**
 * Fetch the latest published release. Resolves to `null` when the repository has
 * no release yet, or when the request fails (offline, rate-limited, …) — an
 * update check must never break the app.
 */
export async function fetchLatestRelease(
  fetchImpl: typeof fetch = fetch,
  repo: { owner: string; repo: string } = UPDATE_RELEASE_REPO,
): Promise<ReleaseInfo | null> {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    return parseRelease(await res.json());
  } catch {
    return null;
  }
}

/**
 * Check whether a newer version than `current` has been published. Resolves to
 * `null` when the check could not be completed.
 */
export async function checkForUpdate(
  current: string,
  fetchImpl: typeof fetch = fetch,
  repo: { owner: string; repo: string } = UPDATE_RELEASE_REPO,
): Promise<UpdateCheck | null> {
  const release = await fetchLatestRelease(fetchImpl, repo);
  if (!release || !release.version) return null;
  return {
    current: normalizeVersion(current),
    latest: release.version,
    hasUpdate: isNewer(release.version, current),
    notes: release.notes,
    htmlUrl: release.htmlUrl,
    installerUrl: findInstallerAsset(release)?.url ?? null,
    apkUrl: findApkAsset(release)?.url ?? null,
  };
}
