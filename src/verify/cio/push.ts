import { cioApi } from './cli';

export interface ApnsCredential {
  /** `sandbox` or `production` — the half of the pair that has to match the build. */
  config?: string;
  /** The uploaded key's filename, which is all the API returns of it. */
  username?: string;
  updated?: number;
}

export async function apnsCredential(
  environmentId: string
): Promise<{ ok: boolean; credential?: ApnsCredential; error?: string }> {
  const res = await cioApi<{ credential?: ApnsCredential | null }>(
    '/v1/environments/{environment_id}/credentials/{action_type}',
    { environment_id: environmentId, action_type: 'push_apns' }
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, credential: res.data?.credential ?? undefined };
}

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
