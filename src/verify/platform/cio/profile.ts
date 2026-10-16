import { cioApi } from './cli';
import { Workspace } from './workspace';

export interface ProfileDevice {
  /** The device token itself: what a send is actually addressed to. */
  id: string;
  platform?: string;
  appIdentifier?: string;
  /** The SDK's own record of notification authorization, as of the last sync. */
  pushEnabled?: string;
  sdkVersion?: string;
  lastUsed?: number;
}

export interface Profile {
  cioId: string;
  identifiers: Record<string, string | null>;
  devices: ProfileDevice[];
}

/**
 * Find the profile an identifier resolves to, exactly.
 *
 * The `email` query parameter is a *search*, and universal search indexes no device tokens
 * at all, so neither can answer "is this token on this profile?". A condition filter can:
 * it is an equality match on one attribute, the same thing a campaign audience is built
 * from, so a hit here means what a campaign would mean by it.
 */
export async function findProfile(
  environmentId: string,
  identifier: string
): Promise<Profile | null> {
  // Workspaces are keyed by email or by id, and the identifier's own shape is the only hint
  // the device gives — so try the likely field first and fall back to the other.
  const fields = identifier.includes('@') ? ['email', 'id'] : ['id', 'email'];

  for (const field of fields) {
    const condition = JSON.stringify({
      attribute: { field, operator: 'eq', value: identifier },
    });
    const filters = Buffer.from(condition).toString('base64');
    const res = await cioApi<{ customers?: Record<string, unknown>[] }>(
      '/v1/environments/{environment_id}/customers',
      { environment_id: environmentId, filters }
    );
    const found = res.data?.customers?.[0];
    if (!found) continue;

    const devices = Array.isArray(found.devices)
      ? (found.devices as Record<string, unknown>[])
      : [];

    return {
      cioId: String(found.id ?? ''),
      identifiers: (found.identifiers ?? {}) as Record<string, string | null>,
      devices: devices.map((device) => {
        const attributes = (device.attributes ?? {}) as Record<string, string>;
        return {
          id: String(device.id ?? ''),
          platform: attributes.platform,
          appIdentifier: attributes.app_identifier,
          pushEnabled: attributes.push_enabled,
          sdkVersion: attributes.cio_sdk_version,
          lastUsed: device.last_used as number | undefined,
        };
      }),
    };
  }

  return null;
}

export interface IdentityHit {
  workspace: Workspace;
  cioId: string;
  /** True when that workspace's profile carries the exact token this target holds. */
  hasToken: boolean;
  devices: number;
}

/**
 * Where is this app's data actually landing?
 *
 * The one sentence worth printing when a chosen workspace turns out not to contain the
 * device, and the reason picking a workspace beats inferring one: inference could only
 * ever tell you which workspace the app talks to, never that it is the wrong one. Paid for
 * strictly on the failure path — a lookup per workspace, and only once something has
 * already gone wrong.
 */
export async function findIdentityElsewhere(options: {
  identifier: string;
  token?: string;
  candidates: Workspace[];
  skip?: string;
  onProgress?: (workspace: Workspace) => void;
}): Promise<IdentityHit[]> {
  const queue = options.candidates.filter(
    (workspace) => workspace.id !== options.skip
  );
  const hits: IdentityHit[] = [];

  // A few at a time: one lookup spawns a `cio` process, and a dozen in series turned a
  // failure into a twenty-second wait. Four keeps it under five seconds without becoming
  // the reason a workspace starts rate-limiting us.
  const workers = Array.from(
    { length: Math.min(4, queue.length) },
    async () => {
      for (;;) {
        const workspace = queue.shift();
        if (!workspace) return;
        options.onProgress?.(workspace);
        const profile = await findProfile(workspace.id, options.identifier);
        if (!profile) continue;
        hits.push({
          workspace,
          cioId: profile.cioId,
          hasToken: Boolean(
            options.token &&
              profile.devices.some((device) => device.id === options.token)
          ),
          devices: profile.devices.length,
        });
      }
    }
  );
  await Promise.all(workers);
  // A workspace holding the actual device explains more than one holding only the name.
  return hits.sort((a, b) => Number(b.hasToken) - Number(a.hasToken));
}
