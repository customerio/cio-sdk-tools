import { Asker, MissingInput } from '../prompt';
import { cioApi, shortError } from './cli';

export interface Workspace {
  id: string;
  name?: string;
  /** How profiles are identified here — the lookup in rung 4 depends on it. */
  identifierType?: string;
}

export type Resolution =
  | 'explicit'
  | 'chosen'
  | 'only_environment'
  | 'unresolved';

export interface WorkspaceResolution {
  workspace?: Workspace;
  how: Resolution;
  /** Everything the account can see, for the picker and for the failure message. */
  candidates: Workspace[];
  unresolvedReason?: string;
}

/**
 * The account's workspaces, or why they could not be listed. A failed call is kept apart
 * from an empty answer: reading a 401 as "no workspaces" sent people looking for a
 * permission problem when the login itself had stopped working.
 */
export async function listEnvironments(
  accountId: string
): Promise<{ environments: Workspace[]; error?: string }> {
  const res = await cioApi<Record<string, unknown>>(
    '/v1/accounts/{account_id}/environments',
    { account_id: accountId }
  );
  if (!res.ok || !res.data) {
    return {
      environments: [],
      error: shortError(res.error ?? 'no answer from the cio CLI'),
    };
  }
  const raw =
    (res.data.environments as unknown[]) ?? (res.data.data as unknown[]) ?? [];
  if (!Array.isArray(raw)) return { environments: [] };
  return {
    environments: raw
      .map((entry) => entry as Record<string, unknown>)
      .filter((entry) => entry.id !== undefined)
      .map((entry) => ({
        id: String(entry.id),
        name: entry.name as string,
        identifierType: entry.identifier_type as string,
      })),
  };
}

/**
 * Which workspace should this app be talking to?
 *
 * Asked, never inferred. The previous version swept the account's environments for the
 * siteId the SDK had stored, which was wrong twice over: `siteId` is an argument to the
 * in-app messaging module, so a push-only app has none at all, and even where it exists
 * it makes the app's own configuration the authority on what the app's configuration
 * should be. Connecting to the intended workspace is part of what is being verified, so
 * the answer has to come from outside the thing under test.
 */
export async function resolveWorkspace(options: {
  accountId?: string;
  explicit?: string;
  asker: Asker;
}): Promise<WorkspaceResolution> {
  if (!options.accountId) {
    return {
      how: 'unresolved',
      candidates: [],
      unresolvedReason: 'no account id in the cio CLI config',
    };
  }

  const listed = await listEnvironments(options.accountId);
  if (listed.error) {
    return {
      how: 'unresolved',
      candidates: [],
      unresolvedReason: `could not list this login's workspaces (${listed.error}) — check \`cio auth status\``,
    };
  }
  const environments = listed.environments;
  if (environments.length === 0) {
    return {
      how: 'unresolved',
      candidates: [],
      unresolvedReason: 'the account has no workspaces this login can read',
    };
  }

  if (options.explicit) {
    // A typo in --workspace would otherwise surface as a 404 three rungs later — or, as
    // a skipped rung, as a run that carries on and proves nothing. It is a bad argument,
    // so it ends the run the way a missing one does, with the workspaces it could be.
    const known = environments.find(
      (environment) => environment.id === options.explicit
    );
    if (!known) {
      throw new MissingInput(
        `workspace ${options.explicit} is not one this login can read — pass --workspace <id>`,
        '--workspace <id>',
        environments.map((environment) =>
          environment.name
            ? `${environment.id}  ${environment.name}`
            : environment.id
        )
      );
    }
    return { workspace: known, how: 'explicit', candidates: environments };
  }

  if (environments.length === 1) {
    return {
      workspace: environments[0],
      how: 'only_environment',
      candidates: environments,
    };
  }

  const chosen = await options.asker.select(
    'Which workspace should this app be reporting to?',
    environments.map((environment) => ({
      value: environment,
      label: environment.name ?? environment.id,
      hint: environment.id,
    })),
    { flag: '--workspace <id>' }
  );
  return { workspace: chosen, how: 'chosen', candidates: environments };
}
