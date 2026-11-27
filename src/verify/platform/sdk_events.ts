import { LogLine } from './logs';

/**
 * The key tail the SDKs put on the lines this tool reads: the sentence, then
 * ` || ev=<event> key=value…`. A sentence can change wording in any release; the event and its
 * keys never do. Each SDK holds itself to that in its own contract tests, which point at
 * docs/verify-contract.md.
 */
export interface SdkEvent {
  ev: string;
  fields: Record<string, string>;
}

const DELIMITER = ' || ';

/**
 * The event a line carries, if it carries one. The tail is the remainder after the last
 * delimiter, and only when every word of it is a `key=value` pair: a sentence that happens
 * to contain ` || ` is not an event. Values arrive percent-encoded where they would break the
 * format (`%`, `|` and whitespace), and a pair splits at its first `=`, because a delivery id
 * can end in one.
 */
export function sdkEvent(message: string): SdkEvent | undefined {
  const at = message.lastIndexOf(DELIMITER);
  if (at < 0) return undefined;
  const fields: Record<string, string> = {};
  for (const pair of message.slice(at + DELIMITER.length).split(' ')) {
    const equals = pair.indexOf('=');
    if (equals <= 0) return undefined;
    const key = pair.slice(0, equals);
    if (!/^[a-z_]+$/.test(key)) return undefined;
    fields[key] = decode(pair.slice(equals + 1));
  }
  const ev = fields.ev;
  if (!ev) return undefined;
  delete fields.ev;
  return { ev, fields };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * What the SDK says about itself in its `sdk.state` line: written when it starts, and again
 * whenever the user or the token changes, so the latest line is the current state.
 */
export interface SdkStateLine {
  /** The native SDK's version, also under a wrapper. */
  version?: string;
  userId?: string;
  /** The SDK said no user is identified. */
  anonymous: boolean;
  token?: string;
  /** The SDK said it holds no token. */
  noToken: boolean;
  /** The first characters of the CDP API key the app runs with; never the whole key. */
  keyPrefix?: string;
  at: string;
}

export function latestSdkState(lines: LogLine[]): SdkStateLine | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const event = sdkEvent(lines[index].message);
    if (event?.ev !== 'sdk.state') continue;
    const { version, user, token, key } = event.fields;
    return {
      version,
      userId: user && user !== 'anonymous' ? user : undefined,
      anonymous: user === 'anonymous',
      token: token && token !== 'none' ? token : undefined,
      noToken: token === 'none',
      keyPrefix: key && key !== 'none' ? key : undefined,
      at: lines[index].at,
    };
  }
  return undefined;
}
