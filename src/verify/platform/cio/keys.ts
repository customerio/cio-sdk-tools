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
  const answers = await Promise.all(
    sources.map((source) =>
      api<{ api_keys?: { api_key?: string }[] }>(
        '/cdp/api/workspaces/{workspace_id}/sources/{source_id}/api_keys',
        { workspace_id: environmentId, source_id: String(source.id) }
      )
    )
  );
  const failed = answers.find((answer) => !answer.ok);
  if (failed) {
    return {
      keys: [],
      error: shortError(failed.error ?? 'no answer from the cio CLI'),
    };
  }
  return {
    keys: answers.flatMap((answer, index) =>
      (answer.data?.api_keys ?? [])
        .filter((entry) => entry.api_key)
        .map((entry) => ({
          key: entry.api_key as string,
          source: sources[index].name ?? String(sources[index].id),
        }))
    ),
  };
}

/**
 * A key is not secret, but it is not worth printing whole either. A placeholder such as
 * `test-cdp-api-key` is printed as it is, since seeing it is the point.
 */
export function shortKey(key: string): string {
  return /^[0-9a-f]{16,}$/i.test(key) ? `${key.slice(0, 6)}…` : key;
}
