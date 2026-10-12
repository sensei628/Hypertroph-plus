import { describe, it, expect, vi } from 'vitest';
import {
  normalizeVersion,
  compareVersions,
  isNewer,
  parseRelease,
  findInstallerAsset,
  findApkAsset,
  fetchLatestRelease,
  checkForUpdate,
} from '../src/domain/updates';

describe('version parsing & comparison', () => {
  it('strips a leading v', () => {
    expect(normalizeVersion('v0.2.0')).toBe('0.2.0');
    expect(normalizeVersion(' 1.0.0 ')).toBe('1.0.0');
  });

  it('orders numeric components', () => {
    expect(compareVersions('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('treats missing components as zero', () => {
    expect(compareVersions('0.1', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.1', '0.1')).toBe(1);
  });

  it('ignores pre-release suffixes', () => {
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBe(0);
  });

  it('isNewer only for strictly greater', () => {
    expect(isNewer('v0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.0.9', '0.1.0')).toBe(false);
  });
});

describe('parseRelease', () => {
  it('normalises a GitHub release payload', () => {
    const info = parseRelease({
      tag_name: 'v0.2.0',
      name: '0.2.0',
      body: '- Added things',
      html_url: 'https://example/rel',
      assets: [{ name: 'x-setup.exe', browser_download_url: 'https://example/x.exe', size: 10 }],
    });
    expect(info.version).toBe('0.2.0');
    expect(info.tag).toBe('v0.2.0');
    expect(info.notes).toBe('- Added things');
    expect(info.htmlUrl).toBe('https://example/rel');
    expect(info.assets[0].url).toBe('https://example/x.exe');
  });

  it('tolerates a sparse payload', () => {
    const info = parseRelease({});
    expect(info.version).toBe('');
    expect(info.notes).toBe('');
    expect(info.assets).toEqual([]);
  });
});

describe('findInstallerAsset', () => {
  it('prefers the Windows .exe', () => {
    const info = parseRelease({
      tag_name: 'v0.2.0',
      assets: [
        { name: 'app.apk', browser_download_url: 'https://x/app.apk' },
        { name: 'app-setup.exe', browser_download_url: 'https://x/app.exe' },
      ],
    });
    expect(findInstallerAsset(info)?.name).toBe('app-setup.exe');
  });

  it('returns null when there is no installer', () => {
    expect(findInstallerAsset(parseRelease({ assets: [{ name: 'app.apk' }] }))).toBeNull();
  });
});

describe('findApkAsset', () => {
  it('picks the Android .apk, ignoring other assets', () => {
    const info = parseRelease({
      tag_name: 'v0.2.0',
      assets: [
        { name: 'hypertrophplus-0.2.0-setup.exe', browser_download_url: 'https://x/app.exe' },
        { name: 'latest.yml', browser_download_url: 'https://x/latest.yml' },
        { name: 'app-debug.apk', browser_download_url: 'https://x/app-debug.apk' },
      ],
    });
    expect(findApkAsset(info)?.url).toBe('https://x/app-debug.apk');
  });

  it('returns null when there is no apk', () => {
    expect(findApkAsset(parseRelease({ assets: [{ name: 'app-setup.exe' }] }))).toBeNull();
  });
});

describe('fetchLatestRelease / checkForUpdate', () => {
  const release = {
    tag_name: 'v0.3.0',
    name: '0.3.0',
    body: 'New stuff',
    html_url: 'https://example/rel',
    assets: [
      { name: 'hypertrophplus-0.3.0-setup.exe', browser_download_url: 'https://x/setup.exe' },
      { name: 'app-debug.apk', browser_download_url: 'https://x/app-debug.apk' },
    ],
  };

  it('reports an available update with notes, installer and apk', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(release), { status: 200 })) as unknown as typeof fetch;
    const r = await checkForUpdate('0.1.0', fetchImpl);
    expect(r).not.toBeNull();
    expect(r!.hasUpdate).toBe(true);
    expect(r!.latest).toBe('0.3.0');
    expect(r!.notes).toBe('New stuff');
    expect(r!.installerUrl).toBe('https://x/setup.exe');
    expect(r!.apkUrl).toBe('https://x/app-debug.apk');
  });

  it('reports no update when running the latest', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(release), { status: 200 })) as unknown as typeof fetch;
    const r = await checkForUpdate('0.3.0', fetchImpl);
    expect(r!.hasUpdate).toBe(false);
  });

  it('returns null when there is no release (404)', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
    expect(await fetchLatestRelease(fetchImpl)).toBeNull();
    expect(await checkForUpdate('0.1.0', fetchImpl)).toBeNull();
  });

  it('swallows network errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await checkForUpdate('0.1.0', fetchImpl)).toBeNull();
  });
});
