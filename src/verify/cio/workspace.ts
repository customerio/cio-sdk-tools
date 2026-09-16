import { promises as fs } from 'fs';
import * as path from 'path';
import { getCacheDir } from '../../doctor/utils/cache';
import { cioApi } from './cli';

export interface Workspace {
  id: string;
  name?: string;
}

export type Resolution =
  | 'explicit'
  | 'cached'
  | 'site_id'
  | 'only_environment'
  | 'ambiguous'
  | 'unresolved';

export interface WorkspaceResolution {
  workspace?: Workspace;
  how: Resolution;
  /** Offered to the user when the answer was not unique. */
  candidates: Workspace[];
  /** Environments swept looking for the device's siteId. */
  swept?: number;
  matchedSiteId?: string;
}

export async function listEnvironments(
  accountId: string
): Promise<Workspace[]> {
  const res = await cioApi<Record<string, unknown>>(
    '/v1/accounts/{account_id}/environments',
    { account_id: accountId }
  );
  if (!res.ok || !res.data) return [];
  const raw =
    (res.data.environments as unknown[]) ?? (res.data.data as unknown[]) ?? [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => entry as Record<string, unknown>)
    .filter((entry) => entry.id !== undefined)
    .map((entry) => ({ id: String(entry.id), name: entry.name as string }));
}

export async function siteIds(environmentId: string): Promise<string[]> {
  const res = await cioApi<{ site_ids?: string[] }>(
    '/v1/environments/{environment_id}/site_ids',
    { environment_id: environmentId }
  );
  const ids = res.data?.site_ids;
  return Array.isArray(ids) ? ids : [];
}

/**
 * Which workspace is this app talking to?
 *
 * The device knows, and nothing else does: the siteId the SDK received in its settings is
 * the one fact on the phone that ties the build to a workspace. So the siteId is swept
 * across the account's environments — around 7s for a dozen of them, which is why the
 * answer is cached per project afterwards.
 *
 * Uniqueness is observed, not guaranteed. Zero or several matches fall through to a named
 * picker rather than a guess, and `--workspace` always wins.
 */
export async function resolveWorkspace(options: {
  accountId?: string;
  explicit?: string;
  siteId?: string;
  cacheKey: string;
}): Promise<WorkspaceResolution> {
  if (options.explicit) {
    return {
      workspace: { id: options.explicit },
      how: 'explicit',
      candidates: [],
    };
  }

  if (options.siteId) {
    const cached = await readCache(options.cacheKey);
    if (cached && cached.siteId === options.siteId) {
      return {
        workspace: { id: cached.workspaceId, name: cached.name },
        how: 'cached',
        candidates: [],
        matchedSiteId: options.siteId,
      };
    }
  }

  if (!options.accountId) {
    return { how: 'unresolved', candidates: [] };
  }

  const environments = await listEnvironments(options.accountId);
  if (environments.length === 0) return { how: 'unresolved', candidates: [] };
  if (environments.length === 1) {
    return {
      workspace: environments[0],
      how: 'only_environment',
      candidates: environments,
    };
  }

  if (options.siteId) {
    const matches: Workspace[] = [];
    for (const environment of environments) {
      const ids = await siteIds(environment.id);
      if (ids.includes(options.siteId)) matches.push(environment);
    }
    if (matches.length === 1) {
      await writeCache(options.cacheKey, {
        workspaceId: matches[0].id,
        name: matches[0].name,
        siteId: options.siteId,
        resolvedAt: new Date().toISOString(),
      });
      return {
        workspace: matches[0],
        how: 'site_id',
        candidates: environments,
        swept: environments.length,
        matchedSiteId: options.siteId,
      };
    }
    return {
      how: matches.length > 1 ? 'ambiguous' : 'unresolved',
      candidates: matches.length > 1 ? matches : environments,
      swept: environments.length,
      matchedSiteId: options.siteId,
    };
  }

  return { how: 'ambiguous', candidates: environments };
}

interface CacheEntry {
  workspaceId: string;
  name?: string;
  siteId: string;
  resolvedAt: string;
}

function cachePath(): string {
  return path.join(getCacheDir(), 'verify-workspaces.json');
}

async function readCache(key: string): Promise<CacheEntry | undefined> {
  const text = await fs.readFile(cachePath(), 'utf8').catch(() => undefined);
  if (!text) return undefined;
  try {
    return (JSON.parse(text) as Record<string, CacheEntry>)[key];
  } catch {
    return undefined;
  }
}

async function writeCache(key: string, entry: CacheEntry): Promise<void> {
  const file = cachePath();
  const existing = await fs.readFile(file, 'utf8').catch(() => '{}');
  let all: Record<string, CacheEntry> = {};
  try {
    all = JSON.parse(existing) as Record<string, CacheEntry>;
  } catch {
    all = {};
  }
  all[key] = entry;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
}
