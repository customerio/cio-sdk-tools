import { cioApi } from '../../platform/cio/cli';

/** The workspace's push credential: the one thing a send needs that the app cannot supply. */
export interface PushCredential {
  /**
   * `sandbox` or `production` on APNs — the half of the pair that has to match the build.
   * FCM has no such split, and the field comes back empty there.
   */
  config?: string;
  /** The uploaded key's filename, which is all the API returns of it. */
  username?: string;
  updated?: number;
}

export type PushProvider = 'apns' | 'fcm';

export async function pushCredential(
  environmentId: string,
  provider: PushProvider
): Promise<{ ok: boolean; credential?: PushCredential; error?: string }> {
  const res = await cioApi<{ credential?: PushCredential | null }>(
    '/v1/environments/{environment_id}/credentials/{action_type}',
    {
      environment_id: environmentId,
      action_type: provider === 'fcm' ? 'push_fcm' : 'push_apns',
    }
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, credential: res.data?.credential ?? undefined };
}
