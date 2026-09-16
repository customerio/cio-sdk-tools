import { CioContext } from '../cio/cli';
import { Profile, findProfile } from '../cio/push';
import { fail, pass, warn } from '../ladder';
import { Rung } from '../types';

export interface ProfileInput {
  cio: CioContext;
  environmentId?: string;
  userId?: string;
  anonymousId?: string;
  token?: string;
  bundleId?: string;
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
    title: 'Profile linked to this device',
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
  const identifier = input.userId ?? input.anonymousId;
  if (!identifier) {
    rung.skipped = 'no identity could be read off the device';
    return rung;
  }
  if (!input.token) {
    rung.skipped = 'the SDK holds no push token to match';
    return rung;
  }

  const profile = await findProfile(input.environmentId, identifier);
  if (!profile) {
    rung.checks.push(
      fail(
        'profile_found',
        `Profile exists for ${identifier}`,
        'profile.not_found',
        [
          `exact match on id and email in environment ${input.environmentId}`,
          'profile sync runs on a cycle, so a login seconds old may not be there yet',
        ]
      )
    );
    return rung;
  }

  rung.checks.push(
    pass('profile_found', `Profile exists for ${identifier}`, [
      `cio_id ${profile.cioId}`,
      `${profile.devices.length} device${
        profile.devices.length === 1 ? '' : 's'
      } linked`,
    ])
  );

  rung.checks.push(...deviceLinkChecks(profile, input));
  return rung;
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
        [`profile says ${linked.appIdentifier}`, `verifying ${input.bundleId}`]
      )
    );
  }

  // Deliberately a warning: this field has read false while permission was granted, and a
  // later identify flipped it true. The token is the stronger evidence, and it is present.
  if (linked.pushEnabled === 'false') {
    checks.push(
      warn(
        'device_push_enabled',
        'Linked device reports push enabled',
        'profile.push_disabled',
        ['push_enabled: false']
      )
    );
  }

  return checks;
}
