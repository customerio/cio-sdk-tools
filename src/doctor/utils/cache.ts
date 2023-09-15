import os from 'os';
import path from 'path';
import { env } from 'process';
import { fetchLatestGitHubRelease } from './version';
import { readFileWithStats } from './file';
import * as logger from './logger';
import { mkdir, writeFile } from 'fs/promises';

export function getCacheDir(): string {
  return path.join(
    env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
    'cio-sdk-tools'
  );
}

// to avoid hitting GitHub api rate limits, we'll cache the latest version for an hour
export async function fetchCachedLatestVersion(
  packageName: string
): Promise<string | undefined> {
  const cacheDir = getCacheDir();
  const cacheKey = `${packageName}.latest`;
  const cachePath = path.join(cacheDir, cacheKey);

  const results = readFileWithStats([cachePath]);
  if (results) {
    const r = results[0];
    const cacheDurationMs = 60 * 60 * 1000;
    if (r.lastUpdated && r.lastUpdated >= Date.now() - cacheDurationMs) {
      return r.content;
    }
  }

  try {
    const latestVersion = await fetchLatestGitHubRelease(packageName);
    if (!latestVersion) {
      return undefined;
    }
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cachePath, latestVersion);
    return latestVersion;
  } catch (err) {
    logger.debug(
      `Unable to cache latest version for ${packageName}.  Error: ${err}`
    );
    return undefined;
  }
}
