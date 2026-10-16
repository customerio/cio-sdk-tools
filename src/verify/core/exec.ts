import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type Tracer = (
  cmd: string,
  args: string[],
  code: number,
  ms: number
) => void;

let tracer: Tracer | undefined;

/**
 * Watch every command this tool runs. Set by the reporter in verbose mode: four of the
 * six failed runs in this project's history were the tool misreading a subprocess, and
 * the command plus its exit code is what made each one obvious in hindsight.
 */
export function setTracer(next: Tracer | undefined): void {
  tracer = next;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run a command to completion. Never throws on a non-zero exit — the caller decides. */
export async function run(
  cmd: string,
  args: string[],
  timeoutMs = 120_000
): Promise<RunResult> {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    tracer?.(cmd, args, 0, Date.now() - started);
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number;
      message?: string;
    };
    const code = e.code ?? 1;
    tracer?.(cmd, args, code, Date.now() - started);
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
      code,
    };
  }
}

/**
 * Read a plist as JSON through plutil, which handles the binary and XML forms alike —
 * entitlements are XML today and a build step is free to rewrite them.
 */
export async function readPlist<T = unknown>(path: string): Promise<T | null> {
  const { stdout, code } = await run('plutil', [
    '-convert',
    'json',
    '-o',
    '-',
    path,
  ]);
  if (code !== 0) return null;
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

export async function isCommandAvailable(cmd: string): Promise<boolean> {
  const { code } = await run('which', [cmd], 5_000);
  return code === 0;
}
