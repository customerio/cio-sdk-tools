import { CioContext } from '../../../platform/cio/cli';
import {
  IdentityHit,
  Profile,
  findIdentityElsewhere,
  findProfile,
} from '../../../platform/cio/profile';
import { Workspace } from '../../../platform/cio/workspace';
import { fail, pass, warn } from '../../../core/report/ladder';
import { Rung } from '../../../core/report/types';
import { NotificationAuthorization, RUNG_TITLES } from '../types';

/**
 * How long a login or a new device may take to reach Customer.io. Read straight after a
 * login on an Android emulator, the profile was missing at 5s and there by 80s; on an iOS
 * simulator it was there within 10s.
 */
export const SETTLE = { maxMs: 90_000, pollMs: 5_000 };

export interface ProfileInput {
  cio: CioContext;
  environmentId?: string;
  userId?: string;
  anonymousId?: string;
  token?: string;
  bundleId?: string;
  /**
   * The other workspaces this login can read. Only used when the chosen one disappoints:
   * an identity or a device found elsewhere turns "no profile here" into "here is where
   * your app is actually reporting", which is the whole point of choosing a workspace
   * rather than inferring one.
   */
  candidates?: Workspace[];
  onSweep?: (workspace: Workspace) => void;
  /** Said while waiting for a login or a device to reach Customer.io. */
  onWait?: (text: string) => void;
  find?: typeof findProfile;
  settle?: Partial<typeof SETTLE>;
}

/**
 * The last thing that can be wrong before a send: the token is real, the profile is real,
 * and they are not attached to each other.
 *
 * That combination is the one this rung exists for. The dashboard shows an addressable
 * profile, the phone shows a registered token, and a campaign send reaches a device that is
 * no longer in anyone's hand.
 */
export async function profileLinked(input: ProfileInput): Promise<Rung> {
  const rung: Rung = {
    id: 'profile_linked',
    title: RUNG_TITLES.profile_linked,
    checks: [],
  };

  if (!input.cio.authenticated) {
    rung.skipped = input.cio.reason ?? 'the cio CLI is unavailable';
    return rung;
  }
  if (!input.environmentId) {
    rung.skipped = 'no workspace was resolved';
    return rung;
  }
  // Push goes only to identified profiles; an anonymous device already stopped the climb.
  const identifier = input.userId;
  if (!identifier) {
    rung.skipped = 'no identified user could be read off the device';
    return rung;
  }
  if (!input.token) {
    rung.skipped = 'the SDK holds no push token to match';
    return rung;
  }

  const find = input.find ?? findProfile;
  const environmentId = input.environmentId;
  const holds = (found: Profile | null) =>
    Boolean(found?.devices.some((device) => device.id === input.token));
  let profile = await find(environmentId, identifier);
  let linked = holds(profile);

  // Sweep only when the chosen workspace has not answered the question.
  const hits = !profile || !linked ? await sweep(input, identifier) : [];
  const elsewhere = describeHits(hits);

  // A login seconds old, or the device it just registered, may not have reached Customer.io
  // yet: read straight after a login, a check failed a profile that turned up a minute
  // later. So the chosen workspace is read again for a while before anything is called
  // missing, unless another workspace already holds the device, which explains it.
  const waited: string[] = [];
  if ((!profile || !linked) && !hits.some((hit) => hit.hasToken)) {
    const settle = { ...SETTLE, ...input.settle };
    const startedAt = Date.now();
    while (Date.now() - startedAt + settle.pollMs <= settle.maxMs) {
      input.onWait?.(
        `waiting for ${
          profile ? 'this device' : identifier
        } to reach Customer.io (${Math.round(
          (Date.now() - startedAt) / 1000
        )}s of ${settle.maxMs / 1000}s)`
      );
      await new Promise((resolve) => setTimeout(resolve, settle.pollMs));
      profile = await find(environmentId, identifier);
      linked = holds(profile);
      if (profile && linked) break;
    }
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    waited.push(
      profile && linked
        ? `there after ${seconds}s: a new login or device takes a while to reach Customer.io`
        : `read again for ${seconds}s, in case a new login had not reached Customer.io yet`
    );
  }

  if (!profile) {
    rung.checks.push(
      fail(
        'profile_found',
        `Profile exists for ${identifier}`,
        hits.length > 0
          ? hits[0].hasToken
            ? 'profile.device_in_other_workspace'
            : 'profile.identity_in_other_workspace'
          : 'profile.not_found',
        [
          `exact match on id and email in environment ${input.environmentId}`,
          ...elsewhere,
          ...waited,
        ],
        elsewhere[0]
      )
    );
    rung.summary =
      hits.length > 0
        ? `found in ${hits[0].workspace.name ?? hits[0].workspace.id}`
        : 'no profile';
    return rung;
  }

  rung.checks.push(
    pass('profile_found', `Profile exists for ${identifier}`, [
      `cio_id ${profile.cioId}`,
      `${profile.devices.length} device${
        profile.devices.length === 1 ? '' : 's'
      } linked`,
      ...waited,
    ])
  );

  rung.checks.push(...deviceLinkChecks(profile, input));

  // The profile is here and the device is not. If the device is on the same identity in
  // another workspace, that is the explanation, and it outranks "the token is stale".
  const holder = hits.find((hit) => hit.hasToken);
  if (!linked && holder) {
    rung.checks.push(
      fail(
        'device_elsewhere',
        'This device belongs to the chosen workspace',
        'profile.device_in_other_workspace',
        describeHits(hits),
        describeHits(hits)[0]
      )
    );
  } else if (!linked && hits.length > 0) {
    rung.checks.push(
      warn(
        'identity_elsewhere',
        'This identity exists only in the chosen workspace',
        'profile.identity_in_other_workspace',
        describeHits(hits),
        describeHits(hits)[0]
      )
    );
  }

  const devices = profile?.devices?.length ?? 0;
  rung.summary = holder
    ? `device is in ${holder.workspace.name ?? holder.workspace.id}`
    : `${devices} device${devices === 1 ? '' : 's'}`;
  return rung;
}

async function sweep(
  input: ProfileInput,
  identifier: string
): Promise<IdentityHit[]> {
  if (!input.candidates || input.candidates.length <= 1) return [];
  return findIdentityElsewhere({
    identifier,
    token: input.token,
    candidates: input.candidates,
    skip: input.environmentId,
    onProgress: input.onSweep,
  });
}

/** Exported for tests: turning hits into evidence is the part worth pinning. */
export function describeHits(hits: IdentityHit[]): string[] {
  if (hits.length === 0) return [];
  return hits.map(
    (hit) =>
      `${hit.hasToken ? 'this device is' : 'this identity is'} in ${
        hit.workspace.name ?? hit.workspace.id
      } (${hit.workspace.id})${
        hit.hasToken
          ? ''
          : ` · ${hit.devices} device${hit.devices === 1 ? '' : 's'}`
      }`
  );
}

/** Exported for tests: the linking judgement is pure, the lookup around it is not. */
export function deviceLinkChecks(profile: Profile, input: ProfileInput) {
  const token = input.token as string;
  const linked = profile.devices.find((device) => device.id === token);

  if (profile.devices.length === 0) {
    return [
      fail(
        'device_linked',
        'This device is linked to the profile',
        'profile.no_device_linked',
        [`token ${token.slice(0, 12)}… is registered on the target`]
      ),
    ];
  }

  if (!linked) {
    return [
      fail(
        'device_linked',
        'This device is linked to the profile',
        'profile.token_not_linked',
        [
          `target token: ${token.slice(0, 12)}… (${token.length} chars)`,
          ...profile.devices.map(
            (device) =>
              `profile token: ${device.id.slice(0, 12)}… ${
                device.platform ?? ''
              } ${device.appIdentifier ?? ''} sdk ${device.sdkVersion ?? '?'}`
          ),
        ]
      ),
    ];
  }

  const checks = [
    pass('device_linked', 'This device is linked to the profile', [
      `${linked.platform ?? 'ios'} · sdk ${linked.sdkVersion ?? 'unknown'}`,
      linked.lastUsed
        ? `last used ${new Date(linked.lastUsed * 1000).toISOString()}`
        : 'never used',
      // Recorded, never judged: see judgeNotificationPermission.
      ...(linked.pushEnabled !== undefined
        ? [
            `push_enabled ${linked.pushEnabled} in Customer.io, its copy of the permission, which lags the device`,
          ]
        : []),
    ]),
  ];

  if (
    input.bundleId &&
    linked.appIdentifier &&
    linked.appIdentifier !== input.bundleId
  ) {
    checks.push(
      warn(
        'device_app_identifier',
        'Linked device belongs to this app',
        'profile.app_identifier_mismatch',
        [`profile says ${linked.appIdentifier}`, `verifying ${input.bundleId}`],
        `the profile's device is ${linked.appIdentifier}; this app is ${input.bundleId}`
      )
    );
  }

  return checks;
}

/**
 * Whether iOS lets the app's notifications show, from iOS's own answer as the SDK logged it
 * during the run. Customer.io's push_enabled is a copy that reached the profile 30-60s after
 * the app reported it, and read wrong both ways on an iPhone and a simulator, so it is never
 * judged. Without the SDK's line nothing is claimed either way.
 */
export function judgeNotificationPermission(
  ladder: { rungs: Rung[] },
  said?: NotificationAuthorization
): void {
  if (said?.allowed === undefined) return;
  const label = 'iOS allows notifications for the app';
  const evidence = [`iOS says ${said.status}, as the SDK logged at ${said.at}`];
  ladder.rungs
    .find((rung) => rung.id === 'device_ready')
    ?.checks.push(
      said.allowed
        ? pass('notifications_allowed', label, evidence)
        : warn(
            'notifications_allowed',
            label,
            'device.notifications_not_allowed',
            evidence
          )
    );
}
