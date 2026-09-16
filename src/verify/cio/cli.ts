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

export async function cioContext(): Promise<CioContext> {
  if (!(await isCommandAvailable('cio'))) {
    return {
      available: false,
      authenticated: false,
      reason: `the cio CLI is not installed — ${INSTALL_HINT}`,
    };
  }

  const { code } = await run('cio', ['auth', 'status'], 30_000);
  if (code !== 0) {
    return {
      available: true,
      authenticated: false,
      reason: 'the cio CLI is not authenticated — run `cio auth login`',
    };
  }

  const config = await readConfig();
  return {
    available: true,
    authenticated: true,
    accountId: config?.account_id,
    region: config?.region,
  };
}

async function readConfig(): Promise<
  { account_id?: string; region?: string } | undefined
> {
  const text = await fs
    .readFile(path.join(os.homedir(), '.cio', 'config.json'), 'utf8')
    .catch(() => undefined);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      account_id:
        typeof parsed.account_id === 'string' ? parsed.account_id : undefined,
      region: typeof parsed.region === 'string' ? parsed.region : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function cioApi<T>(
  apiPath: string,
  params: Record<string, string> = {},
  options: { method?: string; body?: unknown; jq?: string } = {}
): Promise<CioResult<T>> {
  const args = ['api', apiPath];
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

  try {
    const parsed = JSON.parse(body);
    if (parsed?.error) {
      return { ok: false, error: String(parsed.message ?? parsed.error) };
    }
    return { ok: code === 0, data: parsed as T };
  } catch {
    return { ok: false, error: body.slice(0, 400) };
  }
}
