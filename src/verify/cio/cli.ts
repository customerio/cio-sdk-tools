import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isCommandAvailable, run } from '../exec';

/**
 * Everything that talks to Customer.io shells out to the `cio` CLI, so this tool holds no
 * credentials and implements no auth. Token exchange, refresh and region resolution are all
 * inherited, and a better login flow over there arrives here without a change.
 *
 * `~/.cio/config.json` is read for context only — the account id and region. The tokens in
 * it are deliberately never touched: reading one would mean owning its expiry.
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

/** `--profile` → `CIO_PROFILE` → stored `current_profile` → `default`, exactly as `cio` resolves it. */
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

  const { code } = await run(
    'cio',
    ['auth', 'status', ...profileArgs()],
    30_000
  );
  if (code !== 0) {
    return {
      available: true,
      authenticated: false,
      reason: 'the cio CLI is not authenticated — run `cio auth login`',
    };
  }

  const credentials = await readCredentials();
  return {
    available: true,
    authenticated: true,
    accountId: credentials?.account_id,
    region: credentials?.region,
    profile: credentials?.profile,
  };
}

function profileArgs(): string[] {
  const name = activeProfile ?? process.env.CIO_PROFILE?.trim();
  return name ? ['--profile', name] : [];
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
 * Read the account id and region out of `~/.cio/config.json`.
 *
 * The file holds named profiles — production, staging, one per client — and a flat file
 * from an older CLI is read as the `default` profile, which is how `cio` migrates it. A
 * reader that ignores all this finds no account id on a multi-profile machine and reports
 * the workspace as unresolvable, or worse, reports the wrong account's.
 *
 * Only these two fields are read. The tokens in the same file are deliberately untouched:
 * reading one would mean owning its expiry.
 */
async function readCredentials(): Promise<
  (Credentials & { profile: string }) | undefined
> {
  const text = await fs
    .readFile(path.join(os.homedir(), '.cio', 'config.json'), 'utf8')
    .catch(() => undefined);
  if (!text) return undefined;

  let parsed: StoredConfig & Credentials;
  try {
    parsed = JSON.parse(text) as StoredConfig & Credentials;
  } catch {
    return undefined;
  }

  return selectCredentials(parsed, resolveProfileName(parsed));
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

/**
 * One sentence a person can read. The API's own errors arrive as JSON nested inside the
 * envelope's message, and the detail is the only part worth surfacing — the full body is
 * still available under --verbose, where every command and its exit code is printed.
 */
function readableError(envelope: Record<string, unknown>): string {
  const message = String(envelope.message ?? envelope.error);
  const nested = /^(API error \d+): (\{.*\})$/s.exec(message);
  if (!nested) return message;
  try {
    const body = JSON.parse(nested[2]) as {
      errors?: { detail?: string }[];
      message?: string;
    };
    const detail = body.errors?.[0]?.detail ?? body.message;
    if (!detail) return nested[1];
    return `${nested[1]}: ${detail.replace(/\s*\(reference [^)]*\)/, '')}`;
  } catch {
    return nested[1];
  }
}
