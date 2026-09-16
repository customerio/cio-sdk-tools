import { cioApi } from '../cio/cli';

export interface SendRequest {
  /** Print the request and send nothing, so the orchestration can be exercised safely. */
  dryRun?: boolean;
  environmentId: string;
  platform?: 'ios' | 'android';
  provider?: 'apns' | 'fcm';
  token: string;
  /** Per-request, which is why this route is preferred: verifying a debug build must never
   * mean flipping the workspace's shared credential to sandbox and breaking production. */
  sandbox: boolean;
  title: string;
  body: string;
  link?: string;
  imageUrl?: string;
}

export interface SendResult {
  accepted: boolean;
  deliveryId?: string;
  error?: string;
  /** Set on a dry run: the payload that would have gone out, minus the token. */
  wouldSend?: Record<string, unknown>;
}

const DEFAULT_IMAGE = 'https://customer.io/docs/images/push-image-control.jpg';

/**
 * Send one push to one token.
 *
 * `is_rich` is not cosmetic: the backend gates the *entire* `CIO` payload block — deep link
 * and image alike — behind it. Sending without it and then reading the SDK's correct "deep
 * link was not handled" is a false failure that looks exactly like a broken integration.
 */
export async function sendVerifyPush(
  request: SendRequest
): Promise<SendResult> {
  const payload: Record<string, unknown> = {
    to: request.token,
    platform: request.platform ?? 'ios',
    provider: request.provider ?? 'apns',
    sandbox: request.sandbox,
    title: request.title,
    body: request.body,
    is_rich: true,
    image_url: request.imageUrl ?? DEFAULT_IMAGE,
  };
  if (request.link) payload.link = request.link;

  if (request.dryRun) {
    return {
      accepted: false,
      wouldSend: { ...payload, to: `${request.token.slice(0, 12)}…` },
    };
  }

  const res = await cioApi<{ delivery_id?: string; errors?: string[] }>(
    '/v1/environments/{environment_id}/verify/push',
    { environment_id: request.environmentId },
    { method: 'POST', body: payload }
  );

  if (!res.ok) return { accepted: false, error: res.error };
  const errors = res.data?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return { accepted: false, error: errors.join('; ') };
  }
  return { accepted: true, deliveryId: res.data?.delivery_id };
}
