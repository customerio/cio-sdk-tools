import { CioContext } from '../../../platform/cio/cli';
import { PushCredential, PushProvider, pushCredential } from '../credentials';
import {
  Workspace,
  WorkspaceResolution,
} from '../../../platform/cio/workspace';
import { SourceKey, shortKey, workspaceKeys } from '../../../platform/cio/keys';
import { KeyLiteral } from '../../../platform/ios/source';
import { fail, pass, skipped, warn } from '../../../core/report/ladder';
import { Check, Rung } from '../../../core/report/types';
import { RUNG_TITLES } from '../types';

export interface WorkspaceFacts {
  cio: CioContext;
  platform: 'ios' | 'android';
  provider: PushProvider;
  resolution?: WorkspaceResolution;
  credential?: PushCredential;
  credentialError?: string;
  keys?: KeyFacts;
}

/** The keys the app and its extension run with, and whose they are. */
export interface KeyFacts {
  /** Read from the SDK's store on the device. */
  sdkKey?: string;
  /** Read from the extension's sources. */
  extensionKey?: KeyLiteral;
  workspaceKeys: SourceKey[];
  error?: string;
}

/**
 * The credential half of the pipeline, which the project on disk cannot see and the device
 * cannot see either. A workspace with no APNs key accepts every send and delivers none.
 */
export async function gatherWorkspace(options: {
  cio: CioContext;
  platform: 'ios' | 'android';
  provider: PushProvider;
  /** Settled by the selection phase — this rung checks the choice, it does not make it. */
  resolution: WorkspaceResolution;
  sdkKey?: string;
  extensionKey?: KeyLiteral;
}): Promise<WorkspaceFacts> {
  const base = {
    cio: options.cio,
    platform: options.platform,
    provider: options.provider,
  };
  if (!options.cio.authenticated) return base;

  const resolution = options.resolution;
  const workspace = resolution.workspace;
  if (!workspace) return { ...base, resolution };

  const [credential, keys] = await Promise.all([
    pushCredential(workspace.id, options.provider),
    gatherKeys(workspace, options),
  ]);
  return {
    ...base,
    resolution,
    credential: credential.credential,
    credentialError: credential.ok ? undefined : credential.error,
    keys,
  };
}

async function gatherKeys(
  workspace: Workspace,
  options: { sdkKey?: string; extensionKey?: KeyLiteral }
): Promise<KeyFacts | undefined> {
  if (!options.sdkKey && !options.extensionKey) return undefined;
  const listed = await workspaceKeys(workspace.id);
  return {
    sdkKey: options.sdkKey,
    extensionKey: options.extensionKey,
    workspaceKeys: listed.keys,
    error: listed.error,
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
  rung.checks.push(...keyChecks(facts));

  return rung;
}

/**
 * The keys decide where the app and its extension report, which nothing else in the run can
 * see: a push sent to the device's token arrives whichever workspace the app talks to.
 */
function keyChecks(facts: WorkspaceFacts): Check[] {
  const keys = facts.keys;
  if (!keys) return [];
  const checks: Check[] = [];
  const name = facts.resolution?.workspace?.name ?? 'this workspace';

  if (keys.sdkKey) {
    const label = `App reports to ${name}`;
    checks.push(
      keys.error
        ? skipped(
            'sdk_key',
            label,
            `the workspace's keys could not be read: ${keys.error}`
          )
        : keyCheck(keys, keys.sdkKey, {
            id: 'sdk_key',
            label,
            where: 'the SDK on the device',
            cause: 'workspace.sdk_key_foreign',
          })
    );
  }
  if (keys.extensionKey) {
    const label = `Extension reports to ${name}`;
    checks.push(
      keys.error
        ? skipped(
            'extension_key',
            label,
            `the workspace's keys could not be read: ${keys.error}`
          )
        : keyCheck(keys, keys.extensionKey.value, {
            id: 'extension_key',
            label,
            where: `the extension, at ${keys.extensionKey.site}`,
            cause: 'workspace.extension_key_foreign',
          })
    );
  }
  return checks;
}

function keyCheck(
  keys: KeyFacts,
  key: string,
  check: { id: string; label: string; where: string; cause: string }
): Check {
  const held = keys.workspaceKeys.find((entry) => entry.key === key);
  if (held) {
    return pass(check.id, check.label, [
      `key ${shortKey(key)}, from source "${held.source}"`,
    ]);
  }
  const foreign = `${check.where} runs with key ${shortKey(
    key
  )}, which no source in this workspace issued`;
  return fail(check.id, check.label, check.cause, [foreign], foreign);
}

function workspaceEvidence(resolution: WorkspaceResolution): string[] {
  switch (resolution.how) {
    case 'explicit':
      return ['chosen with --workspace'];
    case 'chosen':
      return [`chosen from ${resolution.candidates.length} workspaces`];
    case 'only_environment':
      return ['the account has one workspace'];
    default:
      return [];
  }
}

function describeUnresolved(resolution?: WorkspaceResolution): string {
  return resolution?.unresolvedReason ?? 'no account id in the cio CLI config';
}

function credentialCheck(facts: WorkspaceFacts): Check {
  const label =
    facts.provider === 'fcm'
      ? 'Workspace has an FCM push credential'
      : 'Workspace has an APNs push credential';

  if (facts.credentialError) {
    return warn(
      'push_credential',
      label,
      'workspace.lookup_failed',
      [facts.credentialError],
      facts.credentialError
    );
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
  // An iOS token from Firebase goes out through Firebase only when the credential says it
  // may; otherwise Customer.io refuses every send with NoProviderConfigured.
  if (
    facts.platform === 'ios' &&
    facts.provider === 'fcm' &&
    facts.credential.config !== 'allow_ios'
  ) {
    return fail(
      'push_credential',
      'Workspace sends iOS pushes through Firebase',
      'workspace.fcm_ios_not_enabled',
      [
        'the app links MessagingPushFCM, so its iOS token comes from Firebase',
        `the FCM credential's config is ${
          facts.credential.config ? `"${facts.credential.config}"` : 'empty'
        }, not "allow_ios"`,
      ]
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
        ],
        `a ${apsEnvironment} build needs a ${expected} credential`
      );
}
