import { cioApi } from '../../../platform/cio/cli';
import { stopwatch } from '../../../core/clock';
import { Reporter } from '../../../core/report/render';
import { MatrixCell } from '../types';
import { AppState } from '../../../platform/app_state';

export const RATE_LIMITED_CAUSE = 'send.provider_rate_limited';
export const API_FAILED_CAUSE = 'send.api_failed';

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
  /**
   * Where Customer.io keeps its record of this push, once it keeps test pushes. A refused
   * send can carry one too: the record then says why the provider refused it.
   */
  deliveryId?: string;
  error?: string;
  /** Refused for sending too often: every send after it would be refused the same way. */
  rateLimited?: boolean;
  /** Customer.io's API failed (a 5xx), which says nothing about the token or the app. */
  serverError?: boolean;
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

  const res = await cioApi<SendBody>(
    '/v1/environments/{environment_id}/verify/push',
    { environment_id: request.environmentId },
    { method: 'POST', body: payload }
  );
  return sendResultOf(res);
}

type SendError = string | { detail?: string; meta?: { delivery_id?: string } };

interface SendBody {
  delivery_id?: string;
  errors?: SendError[] | null;
}

/**
 * What the send's answer says. Accepted, it carries `delivery_id` when Customer.io kept a
 * record; refused (a 400 naming the provider's error), the id is in the error's `meta`.
 */
export function sendResultOf(res: {
  ok: boolean;
  data?: SendBody;
  error?: string;
  errorBody?: unknown;
}): SendResult {
  if (!res.ok) {
    return {
      accepted: false,
      error: res.error,
      rateLimited: isRateLimited(res.error),
      serverError: isServerError(res.error),
      deliveryId: idIn((res.errorBody as SendBody | undefined)?.errors),
    };
  }
  const errors = res.data?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const error = errors
      .map((entry) => (typeof entry === 'string' ? entry : entry.detail))
      .filter(Boolean)
      .join('; ');
    return {
      accepted: false,
      error: error || 'refused',
      rateLimited: isRateLimited(error),
      deliveryId: idIn(errors),
    };
  }
  return { accepted: true, deliveryId: res.data?.delivery_id || undefined };
}

function idIn(errors?: SendError[] | null): string | undefined {
  if (!Array.isArray(errors)) return undefined;
  for (const entry of errors) {
    if (typeof entry === 'object' && entry?.meta?.delivery_id) {
      return entry.meta.delivery_id;
    }
  }
  return undefined;
}

/**
 * Why no push can be sent, naming each missing piece and, for the workspace, why it is
 * missing. "A target, a workspace and a registered token are all needed" left the reader
 * to work out which one was absent, when the run usually already knew — `cio` not
 * installed, say. `undefined` means everything a send needs is there.
 */
export function whyNoSend(inputs: {
  target?: unknown;
  app?: string;
  workspaceId?: string;
  workspaceReason?: string;
  token?: string;
}): string | undefined {
  const missing: string[] = [];
  if (!inputs.target) missing.push('no target');
  if (!inputs.app) missing.push('no app id');
  if (!inputs.workspaceId) {
    missing.push(
      inputs.workspaceReason
        ? `no workspace (${inputs.workspaceReason})`
        : 'no workspace'
    );
  }
  if (!inputs.token) missing.push('no push token registered on the target');
  return missing.length > 0
    ? `no push was sent: ${missing.join('; ')}`
    : undefined;
}

/**
 * Apple allows one APNs auth-token change per 20 minutes, and on a workspace with more than
 * one app this route asks Apple for a new token on every send, so sends a minute apart come
 * back `429 TooManyProviderTokenUpdates`. Apple's reason is matched by name, and a bare 429
 * as well: whoever said it, the fix is the same — stop, wait, send less.
 */
export function isRateLimited(error?: string): boolean {
  if (!error) return false;
  return /TooManyProviderTokenUpdates/i.test(error) || /\b429\b/.test(error);
}

/**
 * A 5xx from Customer.io's API: its own failure. Blamed on the token as a refusal once, on
 * the iPhone 16 simulator (2026-10-16), and ended the run as a broken integration.
 */
export function isServerError(error?: string): boolean {
  return Boolean(error && /\bAPI error 5\d\d\b/.test(error));
}

/**
 * The cell for a send that was not accepted. A rate-limited send is inconclusive rather
 * than a conviction: the provider refused it before looking at the token or the app. So is
 * one Customer.io's API failed on.
 */
export function rejectedCell(
  state: AppState,
  sent: SendResult,
  evidence: string[],
  label = 'send rejected'
): MatrixCell {
  const inconclusive = sent.rateLimited || sent.serverError;
  return {
    state,
    verdict: inconclusive ? 'skip' : 'fail',
    cause: sent.rateLimited
      ? RATE_LIMITED_CAUSE
      : sent.serverError
      ? API_FAILED_CAUSE
      : 'send.provider_rejected',
    evidence: [
      ...evidence,
      `${label}: ${sent.error ?? 'unknown error'}${
        sent.deliveryId ? ` (delivery ${sent.deliveryId})` : ''
      }`,
    ],
    detail: `${label}: ${sent.error ?? 'unknown error'}`,
  };
}

/**
 * The loop every matrix shares: one cell per state, in order, with a pause between them —
 * until the provider refuses a send for coming too often. Every later send would be refused
 * the same way and push the provider's window further out, so the states after it are
 * recorded as not sent instead of attempted.
 */
export async function eachState(
  states: AppState[],
  run: (state: AppState) => Promise<MatrixCell>,
  options: { pauseMs: number; reporter?: Reporter }
): Promise<MatrixCell[]> {
  const cells: MatrixCell[] = [];
  for (const state of states) {
    if (cells.some((cell) => cell.cause === RATE_LIMITED_CAUSE)) {
      const skipped: MatrixCell = {
        state,
        verdict: 'skip',
        summary: 'not sent — the provider is refusing sends',
        evidence: [
          'an earlier send was rate limited, and another would only extend the wait',
        ],
      };
      options.reporter?.cell(state).done(skipped);
      cells.push(skipped);
      continue;
    }
    const cellTimer = stopwatch();
    const cell = await run(state);
    cell.durationMs = cellTimer();
    cells.push(cell);
    if (cell.cause !== RATE_LIMITED_CAUSE) await sleep(options.pauseMs);
  }
  return cells;
}

/**
 * A state the app could not be put in gets no push. Sent anyway, the row claimed a state the
 * app was never in: a background push "received" by an app that never launched.
 */
export function unstagedCell(
  state: MatrixCell['state'],
  evidence: string[],
  error?: string
): { cell: MatrixCell; noPush: string } {
  return {
    cell: {
      state,
      verdict: 'skip',
      cause: 'runtime.app_state_not_set',
      evidence: [...evidence, 'no push was sent for this state'],
      detail: error,
    },
    noPush:
      'the app could not be put in this state, so no push was sent to tap',
  };
}

/** Causes that mean a push was not seen to arrive within its cell's window. */
const NOT_SEEN = [
  'runtime.push_never_arrived',
  'runtime.no_evidence',
  'device.apns_offline',
];

/**
 * A push that missed its window but is on the target when the run ends was slow, not lost.
 *
 * An emulator resumed from a snapshot held three pushes for about four minutes and then
 * delivered them together, and the run called two of them "never arrived". Each push's title
 * is unique, so after the last cell the target is asked whether a "not seen" cell's push is
 * there after all; if it is, the cell is re-judged as late — a warning, because delivery
 * works and the slowness belongs to the target. Re-judged cells are printed again, so the
 * line streamed earlier is not the last word.
 */
export async function markLateArrivals(
  cells: MatrixCell[],
  arrivedLate: (title: string) => Promise<boolean>,
  reporter?: Reporter
): Promise<MatrixCell[]> {
  const out: MatrixCell[] = [];
  for (const cell of cells) {
    // A push the store already held during its cell was on time; what went wrong is
    // something else, and calling it late hid that.
    if (
      !cell.title ||
      !cell.cause ||
      !NOT_SEEN.includes(cell.cause) ||
      cell.arrived
    ) {
      out.push(cell);
      continue;
    }
    if (!(await arrivedLate(cell.title))) {
      out.push(cell);
      continue;
    }
    const late: MatrixCell = {
      ...cell,
      verdict: 'warn',
      cause: 'runtime.push_arrived_late',
      summary: undefined,
      evidence: [
        ...cell.evidence,
        `"${cell.title}" was on the target when the run ended, so it arrived after this cell stopped waiting (was: ${cell.cause})`,
      ],
    };
    reporter?.cell(`${cell.state}, late`).done(late);
    out.push(late);
  }
  return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
