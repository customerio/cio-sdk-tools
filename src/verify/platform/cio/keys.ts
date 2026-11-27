import { cioApi, shortError } from './cli';

/** A key the SDK can be initialized with, and the source in the workspace that issued it. */
export interface SourceKey {
  key: string;
  source: string;
}

/**
 * Every key the workspace's sources have issued.
 *
 * The key an app is initialized with decides where everything it reports goes. A dead key
 * reports nowhere, and a key from another workspace reports there, and both still get a
 * push sent to the device's token. Without this the run reads either as a device that was
 * never linked to the profile.
 *
 * Only the chosen workspace is read. Finding which workspace a stray key belongs to means
 * reading every source of every workspace, and one workspace can hold a hundred sources.
 */
export async function workspaceKeys(
  environmentId: string,
  api: typeof cioApi = cioApi
): Promise<{ keys: SourceKey[]; error?: string }> {
  const listed = await api<{ sources?: { id?: number; name?: string }[] }>(
    '/cdp/api/workspaces/{workspace_id}/sources',
    { workspace_id: environmentId }
  );
  if (!listed.ok || !listed.data) {
    return {
      keys: [],
      error: shortError(listed.error ?? 'no answer from the cio CLI'),
    };
  }
  const sources = (listed.data.sources ?? []).filter(
    (source) => source.id !== undefined
  );
  // A few at a time: a large workspace has many sources, and a burst of calls is what gets
  // throttled. A source that still fails leaves the keys that did load, with the error beside
  // them, so a key found among them is still found.
  const answers = await inBatches(sources, KEY_LOOKUPS_AT_ONCE, (source) =>
    api<{ api_keys?: { api_key?: string }[] }>(
      '/cdp/api/workspaces/{workspace_id}/sources/{source_id}/api_keys',
      { workspace_id: environmentId, source_id: String(source.id) }
    )
  );
  const failed = answers.find((answer) => !answer.ok);
  return {
    keys: answers.flatMap((answer, index) =>
      (answer.ok ? answer.data?.api_keys ?? [] : [])
        .filter((entry) => entry.api_key)
        .map((entry) => ({
          key: entry.api_key as string,
          source: sources[index].name ?? String(sources[index].id),
        }))
    ),
    ...(failed
      ? { error: shortError(failed.error ?? 'no answer from the cio CLI') }
      : {}),
  };
}

const KEY_LOOKUPS_AT_ONCE = 4;

async function inBatches<T, R>(
  items: T[],
  size: number,
  each: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    results.push(
      ...(await Promise.all(items.slice(start, start + size).map(each)))
    );
  }
  return results;
}

/**
 * A key is not secret, but it is not worth printing whole either. A placeholder such as
 * `test-cdp-api-key` is printed as it is, since seeing it is the point.
 */
export function shortKey(key: string): string {
  return /^[0-9a-f]{16,}$/i.test(key) ? `${key.slice(0, 6)}…` : key;
}
