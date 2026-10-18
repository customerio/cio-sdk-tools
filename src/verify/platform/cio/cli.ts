import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isCommandAvailable, run } from '../../core/exec';

/**
 * Everything that talks to Customer.io shells out to the `cio` CLI, so this tool holds no
 * credentials and implements no auth. Token exchange, refresh and region resolution are all
 * inherited, and a better login flow over there arrives here without a change.
 *
 * The account id and region come from `cio auth status`, which reports them for whatever
 * login `cio` is using: a stored profile, `CIO_TOKEN` in a CI job, or a config somewhere
 * this tool cannot see. `~/.cio/config.json` is read only for its profile names, and for
 * the account id when an older `cio` prints its status as text. The tokens in it are
 * deliberately never touched: reading one would mean owning its expiry.
 */
export interface CioContext {
  available: boolean;
  authenticated: boolean;
  accountId?: string;
  region?: string;
  /** The credential set these values came from. */
  profile?: string;
  /** Why it is unusable, ready to print. */
  reason?: string;
}

export interface CioResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  /** A refused call's own body, when the API sent one: it can carry more than the error. */
  errorBody?: unknown;
}

const INSTALL_HINT =
  'install it with `npm install -g @customerio/cli`, then run `cio auth login`';

const DEFAULT_PROFILE = 'default';

/**
 * The profile selected for this run, set once before any credential is read — the same
 * arrangement the `cio` CLI uses, for the same reason: every call site would otherwise have
 * to thread it through, and one that forgot would silently read another account's config.
 */
let activeProfile: string | undefined;

export function setActiveProfile(name?: string): void {
  activeProfile = name?.trim() || undefined;
}

/** `--cio-profile` → `CIO_PROFILE` → stored `current_profile` → `default`, exactly as `cio` resolves it. */
function resolveProfileName(stored?: StoredConfig): string {
  const explicit = activeProfile ?? process.env.CIO_PROFILE?.trim();
  if (explicit) return explicit;
  return stored?.current_profile?.trim() || DEFAULT_PROFILE;
}

export async function cioContext(): Promise<CioContext> {
  if (!(await isCommandAvailable('cio'))) {
    return {
      available: false,
      authenticated: false,
      reason: `the cio CLI is not installed — ${INSTALL_HINT}`,
    };
  }

  const stored = await readStoredConfig();
  const missing = unknownProfile(stored, requestedProfile());
  if (missing)
    return { available: true, authenticated: false, reason: missing };

  const status = await run('cio', ['auth', 'status', ...profileArgs()], 30_000);
  const problem = authStatusProblem(status);
  if (problem)
    return { available: true, authenticated: false, reason: problem };

  const reported = statusFacts(status.stdout);
  const credentials = stored
    ? selectCredentials(stored, resolveProfileName(stored))
    : undefined;
  return {
    available: true,
    authenticated: true,
    accountId: reported?.accountId ?? credentials?.account_id,
    region: reported?.region ?? credentials?.region,
    profile:
      reported?.tokenSource === 'environment'
        ? 'CIO_TOKEN'
        : credentials?.profile ?? requestedProfile(),
  };
}

/**
 * The account id, region and token source `cio auth status` reports as JSON. Reading them
 * here rather than from the config file is what lets a CI job authenticated by `CIO_TOKEN`,
 * with no config file at all, resolve a workspace.
 */
export function statusFacts(
  stdout: string
): { accountId?: string; region?: string; tokenSource?: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const facts = parsed as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === 'string' && value !== '' ? value : undefined;
  return {
    accountId:
      typeof facts.account_id === 'number'
        ? String(facts.account_id)
        : text(facts.account_id),
    region: text(facts.region),
    tokenSource: text(facts.token_source),
  };
}

/** The profile asked for by name — `--cio-profile` or `CIO_PROFILE` — if any. */
function requestedProfile(): string | undefined {
  return activeProfile ?? (process.env.CIO_PROFILE?.trim() || undefined);
}

function profileArgs(): string[] {
  const name = requestedProfile();
  return name ? ['--profile', name] : [];
}

/**
 * A profile asked for by name that the config does not hold. Decided from the config
 * rather than from `cio`'s exit code, which is 1 for an unknown profile and for a missing
 * login alike — and "run `cio auth login`" is the wrong fix for a typo.
 */
export function unknownProfile(
  stored: (StoredConfig & Credentials) | undefined,
  name: string | undefined
): string | undefined {
  if (!name || !stored || selectCredentials(stored, name)) return undefined;
  const names = stored.profiles
    ? Object.keys(stored.profiles)
    : [DEFAULT_PROFILE];
  return `the cio CLI has no profile "${name}" — the profiles here are ${names.join(
    ', '
  )}; pass one of them to --cio-profile`;
}

/**
 * What `cio auth status` says is wrong with the login, ready to print, or nothing when it
 * works. Three failures used to read as one "not authenticated", and two of them send
 * people to the wrong fix:
 * - a `cio` from before profiles rejects `--profile` as an unknown flag;
 * - a stored token that no longer exchanges still reports `status: authenticated`, with
 *   `verified: false` beside it, and `cio auth login` then refuses to start over because
 *   it believes the user is signed in.
 */
export function authStatusProblem(status: {
  code: number;
  stdout: string;
  stderr: string;
}): string | undefined {
  const output = `${status.stdout}\n${status.stderr}`;
  if (/unknown flag: --profile/.test(output)) {
    return 'this cio CLI has no profiles — drop --cio-profile and CIO_PROFILE, or update it with `npm install -g @customerio/cli`';
  }
  if (status.code !== 0) {
    return 'the cio CLI is not authenticated — run `cio auth login`';
  }

  let parsed:
    | { verified?: unknown; verify_error?: unknown; token_source?: unknown }
    | undefined;
  try {
    parsed = JSON.parse(status.stdout);
  } catch {
    // An older `cio` printing text: the exit code is all there is to go on.
    return undefined;
  }
  if (parsed?.verified !== false) return undefined;
  const why =
    typeof parsed.verify_error === 'string'
      ? ` (${shortError(parsed.verify_error)})`
      : '';
  // Logging in again only replaces the stored token; one from the environment still wins.
  if (parsed.token_source === 'environment') {
    return `the CIO_TOKEN in the environment does not work${why} — fix or unset it`;
  }
  return `the cio login no longer works${why} — run \`cio auth logout\`, then \`cio auth login\``;
}

/** An API error without the JSON body `cio` nests in it: the status line is enough. */
export function shortError(message: string): string {
  return message.split(/:\s*\{/)[0].trim();
}

export interface Credentials {
  account_id?: string;
  region?: string;
}

export interface StoredConfig {
  current_profile?: string;
  profiles?: Record<string, Credentials>;
}

/**
 * Read `~/.cio/config.json` for its profile names, account id and region.
 *
 * The file holds named profiles — production, staging, one per client — and a flat file
 * from an older CLI is read as the `default` profile, which is how `cio` migrates it. A
 * reader that ignores all this finds no account id on a multi-profile machine and reports
 * the workspace as unresolvable, or worse, reports the wrong account's.
 *
 * Only those are used. The tokens in the same file are deliberately untouched: using one
 * would mean owning its expiry.
 */
async function readStoredConfig(): Promise<
  (StoredConfig & Credentials) | undefined
> {
  const text = await fs
    .readFile(path.join(os.homedir(), '.cio', 'config.json'), 'utf8')
    .catch(() => undefined);
  if (!text) return undefined;

  try {
    return JSON.parse(text) as StoredConfig & Credentials;
  } catch {
    return undefined;
  }
}

/**
 * Pick one profile's credentials out of the stored config.
 *
 * Exported because this is the part that silently reads the wrong account if it is wrong:
 * a file with `profiles` must never fall back to its top level, and a file without them is
 * the legacy flat shape that belongs to `default`.
 */
export function selectCredentials(
  parsed: StoredConfig & Credentials,
  name: string
): (Credentials & { profile: string }) | undefined {
  const credentials = parsed.profiles
    ? parsed.profiles[name]
    : name === DEFAULT_PROFILE
    ? parsed
    : undefined;
  if (!credentials) return undefined;

  return {
    profile: name,
    account_id:
      typeof credentials.account_id === 'string'
        ? credentials.account_id
        : undefined,
    region:
      typeof credentials.region === 'string' ? credentials.region : undefined,
  };
}

export async function cioApi<T>(
  apiPath: string,
  params: Record<string, string> = {},
  options: { method?: string; body?: unknown; jq?: string } = {}
): Promise<CioResult<T>> {
  const args = ['api', apiPath, ...profileArgs()];
  if (Object.keys(params).length > 0) {
    args.push('--params', JSON.stringify(params));
  }
  if (options.body !== undefined) {
    args.push('--json', JSON.stringify(options.body));
  }
  if (options.method) args.push('-X', options.method);
  if (options.jq) args.push('--jq', options.jq);

  const { stdout, stderr, code } = await run('cio', args, 120_000);
  const body = stdout.trim() || stderr.trim();
  if (!body) {
    return {
      ok: code === 0,
      error: code === 0 ? undefined : 'no output from cio',
    };
  }

  // A failing `cio api` prints its envelope to stdout *and* stderr, so the body can hold
  // two JSON objects. Parsing the whole thing throws, and the raw double envelope used to
  // end up verbatim in a check's evidence.
  const parsed = firstJson(body);
  if (parsed === undefined) return { ok: false, error: body.slice(0, 400) };
  if ((parsed as { error?: unknown })?.error) {
    return {
      ok: false,
      error: readableError(parsed as Record<string, unknown>),
      errorBody: apiBody(parsed as Record<string, unknown>),
    };
  }
  return { ok: code === 0, data: parsed as T };
}

/** The first parseable JSON value in a body that may hold several, one per line. */
function firstJson(body: string): unknown {
  for (const line of body.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      return JSON.parse(text);
    } catch {
      continue;
    }
  }
  return undefined;
}

const NESTED = /^(API error \d+): (\{.*\})$/s;

/**
 * One sentence a person can read. The API's own errors arrive as JSON nested inside the
 * envelope's message, and the detail is the only part worth surfacing — the full body is
 * still available under --verbose, where every command and its exit code is printed.
 */
function readableError(envelope: Record<string, unknown>): string {
  const message = String(envelope.message ?? envelope.error);
  const nested = NESTED.exec(message);
  if (!nested) return message;
  const body = parseBody(nested[2]) as
    | { errors?: { detail?: string }[]; message?: string }
    | undefined;
  const detail = body?.errors?.[0]?.detail ?? body?.message;
  if (!detail) return nested[1];
  return `${nested[1]}: ${detail.replace(/\s*\(reference [^)]*\)/, '')}`;
}

/** The API's own JSON body, nested inside the envelope's message, if it parses. */
function apiBody(envelope: Record<string, unknown>): unknown {
  const nested = NESTED.exec(String(envelope.message ?? envelope.error));
  return nested ? parseBody(nested[2]) : undefined;
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
