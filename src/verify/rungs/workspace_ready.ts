import { CioContext } from '../cio/cli';
import { PushCredential, PushProvider, pushCredential } from '../cio/push';
import { WorkspaceResolution, resolveWorkspace } from '../cio/workspace';
import { fail, pass, warn } from '../ladder';
import { Check, RUNG_TITLES, Rung } from '../types';

export interface WorkspaceFacts {
  cio: CioContext;
  provider: PushProvider;
  resolution?: WorkspaceResolution;
  credential?: PushCredential;
  credentialError?: string;
}

/**
 * The credential half of the pipeline, which the project on disk cannot see and the device
 * cannot see either. A workspace with no APNs key accepts every send and delivers none.
 */
export async function gatherWorkspace(options: {
  cio: CioContext;
  provider: PushProvider;
  explicit?: string;
  siteId?: string;
  cacheKey: string;
}): Promise<WorkspaceFacts> {
  if (!options.cio.authenticated) {
    return { cio: options.cio, provider: options.provider };
  }

  const resolution = await resolveWorkspace({
    accountId: options.cio.accountId,
    explicit: options.explicit,
    siteId: options.siteId,
    cacheKey: options.cacheKey,
  });

  if (!resolution.workspace) {
    return { cio: options.cio, provider: options.provider, resolution };
  }

  const credential = await pushCredential(
    resolution.workspace.id,
    options.provider
  );
  return {
    cio: options.cio,
    provider: options.provider,
    resolution,
    credential: credential.credential,
    credentialError: credential.ok ? undefined : credential.error,
  };
}

export function workspaceReady(
  facts: WorkspaceFacts,
  apsEnvironment?: string
): Rung {
  const rung: Rung = {
    id: 'workspace_ready',
    title: RUNG_TITLES.workspace_ready,
    checks: [],
  };

  // Without the CLI there is no workspace half at all. That is a skip, never a pass: the
  // run degrades to what can be seen locally and says so.
  if (!facts.cio.authenticated) {
    rung.skipped = facts.cio.reason ?? 'the cio CLI is unavailable';
    return rung;
  }

  const resolution = facts.resolution;
  if (!resolution?.workspace) {
    rung.skipped = describeUnresolved(resolution);
    return rung;
  }

  rung.checks.push(
    pass(
      'workspace_selected',
      `Workspace: ${resolution.workspace.name ?? resolution.workspace.id} (${
        resolution.workspace.id
      })`,
      workspaceEvidence(resolution)
    )
  );

  rung.checks.push(credentialCheck(facts));
  rung.summary = `${
    resolution.workspace?.name ?? resolution.workspace?.id ?? 'unresolved'
  } · ${facts.provider === 'fcm' ? 'FCM' : 'APNs'}`;
  const environment = environmentCheck(facts, apsEnvironment);
  if (environment) rung.checks.push(environment);

  return rung;
}

function workspaceEvidence(resolution: WorkspaceResolution): string[] {
  switch (resolution.how) {
    case 'explicit':
      return ['chosen with --workspace'];
    case 'cached':
      return [`cached for this project, siteId ${resolution.matchedSiteId}`];
    case 'site_id':
      return [
        `matched the siteId the SDK stored on the device: ${resolution.matchedSiteId}`,
        `swept ${resolution.swept} environments`,
      ];
    case 'only_environment':
      return ['the account has one environment'];
    default:
      return [];
  }
}

function describeUnresolved(resolution?: WorkspaceResolution): string {
  if (!resolution) return 'no account id in the cio CLI config';
  if (resolution.how === 'ambiguous') {
    const names = resolution.candidates
      .slice(0, 8)
      .map((w) => `${w.name ?? w.id} (${w.id})`)
      .join(', ');
    return `could not tell which workspace this app talks to; pass --workspace <id>. Candidates: ${names}`;
  }
  return resolution.matchedSiteId
    ? `siteId ${resolution.matchedSiteId} matched none of the ${resolution.swept} environments; pass --workspace <id>`
    : 'no siteId could be read off the device; pass --workspace <id>';
}

function credentialCheck(facts: WorkspaceFacts): Check {
  const label =
    facts.provider === 'fcm'
      ? 'Workspace has an FCM push credential'
      : 'Workspace has an APNs push credential';

  if (facts.credentialError) {
    return warn('push_credential', label, 'workspace.lookup_failed', [
      facts.credentialError,
    ]);
  }
  if (!facts.credential) {
    return fail(
      'push_credential',
      label,
      facts.provider === 'fcm'
        ? 'workspace.fcm_credential_missing'
        : 'workspace.apns_credential_missing',
      [`no push_${facts.provider} credential on this environment`]
    );
  }
  return pass('push_credential', label, [
    facts.credential.username
      ? `key: ${facts.credential.username}`
      : 'key uploaded',
  ]);
}

/**
 * A sandbox credential cannot deliver to a production build and the reverse is equally
 * silent, so the pair is compared rather than each side reported on its own.
 */
function environmentCheck(
  facts: WorkspaceFacts,
  apsEnvironment?: string
): Check | undefined {
  // FCM has no sandbox and production split, so there is no pair to compare. Inventing a
  // check here would mean inventing a distinction Firebase does not make.
  if (facts.provider === 'fcm') return undefined;
  if (!facts.credential) return undefined;

  // An empty `config` is what the API returns for a credential whose environment was never
  // recorded. Silently skipping the comparison would leave the developer believing it was
  // checked, so the gap is named instead.
  const config = facts.credential.config;
  if (!config) {
    return warn(
      'credential_environment',
      "Credential environment matches the build's",
      'workspace.credential_config_unknown',
      [
        'the workspace credential declares no environment',
        apsEnvironment
          ? `build aps-environment: ${apsEnvironment}`
          : 'the build declares no aps-environment either',
      ]
    );
  }

  if (!apsEnvironment) {
    return warn(
      'credential_environment',
      "Credential environment matches the build's",
      'workspace.lookup_failed',
      [
        `credential is ${config}`,
        'the build declares no aps-environment, so there is nothing to compare',
      ]
    );
  }

  const expected = apsEnvironment === 'production' ? 'production' : 'sandbox';
  const evidence = [
    `credential: ${config}`,
    `build aps-environment: ${apsEnvironment}`,
  ];

  return config === expected
    ? pass(
        'credential_environment',
        "Credential environment matches the build's",
        evidence
      )
    : fail(
        'credential_environment',
        "Credential environment matches the build's",
        'workspace.env_mismatch',
        [
          ...evidence,
          `a ${apsEnvironment} build needs a ${expected} credential`,
        ]
      );
}
