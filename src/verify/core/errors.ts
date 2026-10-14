/**
 * Tool-level failures, shaped the way the `cio` CLI shapes them.
 *
 * Anything driving both tools — a plugin, a CI job, a person — should not have to learn two
 * error formats, so this mirrors `cio`'s contract exactly: a JSON envelope on **stderr**
 * with a stable `code`, and an exit code derived from that code. Reports go to stdout;
 * errors never do, or a `--json` consumer has to parse two different things out of one
 * stream.
 *
 * Verdict exit codes (20 broken, 21 nothing proven) live in `types.ts` and are a different
 * axis: those say what the *integration* did, these say the tool could not run.
 */
export const ERROR_CODES = {
  general: 'GENERAL_ERROR',
  validation: 'VALIDATION_ERROR',
  auth: 'AUTH_ERROR',
  authz: 'AUTHZ_ERROR',
  api: 'API_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** The same mapping `cio` uses, so a wrapper can branch on either tool's exit code. */
export function exitCodeForError(code: ErrorCode): number {
  switch (code) {
    case ERROR_CODES.validation:
      return 2;
    case ERROR_CODES.auth:
      return 3;
    case ERROR_CODES.authz:
      return 4;
    case ERROR_CODES.api:
      return 5;
    default:
      return 1;
  }
}

export interface CliError {
  error: true;
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/**
 * Write a structured error to stderr and return its exit code.
 *
 * `json` only decides whether a human line accompanies the envelope — the envelope itself
 * is always written, because a wrapper that forgot to pass `--json` still deserves a
 * parseable failure.
 */
export function printError(
  code: ErrorCode,
  message: string,
  options: { details?: unknown; human?: boolean } = {}
): number {
  const payload: CliError = {
    error: true,
    code,
    message,
    ...(options.details === undefined ? {} : { details: options.details }),
  };

  let line: string;
  try {
    line = JSON.stringify(payload);
  } catch {
    // Never lose the error to a serialisation problem in its own details.
    line = JSON.stringify({ error: true, code, message });
  }
  process.stderr.write(`${line}\n`);

  return exitCodeForError(code);
}
