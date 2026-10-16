import { promises as fs } from 'fs';
import * as path from 'path';

export interface SwiftFile {
  /** Relative to the scan root, for readable evidence. */
  path: string;
  absolutePath: string;
  text: string;
}

export interface InitSite {
  file: string;
  line: number;
  /** The declaration the call sits inside, as written. */
  scope: string;
  /**
   * `true` when a path from a launch method was found, `false` only on positive evidence of
   * the opposite — a SwiftUI `body`, re-evaluated on every redraw, with no guarantee of
   * running before the system delivers a launch push.
   *
   * `unknown` is a real answer and a common one: initialization routinely sits behind a
   * helper or a generated file. Reporting that as a failure flags correct apps, and a check
   * that cries wolf is worse than no check at all.
   */
  runsAtLaunch: boolean | 'unknown';
}

export interface SourceSignals {
  files: number;
  sdkImports: string[];
  appGroupIds: string[];
  initSites: InitSite[];
  identifies: boolean;
  logLevel?: string;
}

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'Pods',
  'build',
  'DerivedData',
  'Carthage',
]);

export async function readSwiftSources(
  root: string,
  maxDepth = 8
): Promise<SwiftFile[]> {
  const out: SwiftFile[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || SKIP_DIRECTORIES.has(entry)) continue;
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!/\.(swift|m|mm)$/.test(entry)) continue;
      const text = await fs.readFile(full, 'utf8').catch(() => '');
      out.push({ path: path.relative(root, full), absolutePath: full, text });
    }
  }

  await walk(root, 0);
  return out;
}

const LAUNCH_SCOPES = [
  /didFinishLaunchingWithOptions/,
  /willFinishLaunchingWithOptions/,
  /func\s+application\b/,
  /\binit\s*\(/,
  /func\s+scene\b/,
  /willConnectTo/,
];

/** A computed `body` is the one context that is positively wrong. */
const VIEW_BODY = /var\s+body\s*:/;

function scopeVerdict(scope: string): boolean | 'unknown' {
  if (LAUNCH_SCOPES.some((re) => re.test(scope))) return true;
  if (VIEW_BODY.test(scope)) return false;
  return 'unknown';
}

function scopeName(scope: string): string | undefined {
  return scope.match(/func\s+(\w+)/)?.[1];
}

/**
 * Follow `initialize()` back to a launch method through the helper that almost always wraps
 * it. Judging only the immediately-enclosing function is what makes this check useless in
 * practice: the overwhelmingly common shape is a `setUpCustomerIO()` called from
 * `didFinishLaunchingWithOptions`, and the SDK's own sample app is written that way. So
 * callers are resolved too, to a bounded depth — enough for the usual hop or two, and
 * stopping well short of real call-graph analysis.
 */
export function resolveRunsAtLaunch(
  scope: string,
  texts: string[],
  depth = 0,
  seen = new Set<string>()
): boolean | 'unknown' {
  const direct = scopeVerdict(scope);
  if (direct !== 'unknown' || depth >= 3) return direct;

  const name = scopeName(scope);
  if (!name || seen.has(name)) return 'unknown';
  seen.add(name);

  let sawBody = false;
  for (const text of texts) {
    // A declaration mentions the name too; only a call site makes something a caller.
    for (const match of text.matchAll(
      new RegExp(`(?<!func\\s+)\\b${name}\\s*\\(`, 'g')
    )) {
      const callerScope = enclosingScope(text.slice(0, match.index ?? 0));
      if (callerScope === scope) continue;
      const verdict = resolveRunsAtLaunch(callerScope, texts, depth + 1, seen);
      if (verdict === true) return true;
      if (verdict === false) sawBody = true;
    }
  }
  return sawBody ? false : 'unknown';
}

/**
 * Find the declaration a call sits inside by walking back to the nearest one, so the
 * question being answered is "which function is this in", not "does this file mention a
 * launch method somewhere".
 */
export function enclosingScope(textBefore: string): string {
  const declaration =
    /(?:^|\n)\s*(?:@\w+\s+)*(?:public |private |internal |fileprivate |static |override |final |lazy )*(?:func\s+\w+[^\n{]*|var\s+body\s*:[^\n{]*|init\s*\([^\n{]*)/g;
  let last = '';
  for (const match of textBefore.matchAll(declaration)) last = match[0].trim();
  return last;
}

export function analyzeSources(files: SwiftFile[]): SourceSignals {
  const sdkImports = new Set<string>();
  const appGroupIds = new Set<string>();
  const initSites: InitSite[] = [];
  const texts = files.map((f) => f.text);
  let identifies = false;
  let logLevel: string | undefined;

  for (const file of files) {
    const { text } = file;
    for (const match of text.matchAll(/\.appGroupId\(\s*"([^"]+)"\s*\)/g)) {
      appGroupIds.add(match[1]);
    }
    for (const match of text.matchAll(
      /^\s*(?:import|@import)\s+(Cio[A-Za-z]+|CustomerIO[A-Za-z]*)/gm
    )) {
      sdkImports.add(match[1]);
    }
    if (
      /CustomerIO\.shared\.identify\s*\(|\bidentify\s*\(\s*(?:userId|identifier)\s*:/.test(
        text
      )
    ) {
      identifies = true;
    }
    for (const match of text.matchAll(/CustomerIO\.initialize\s*\(/g)) {
      const before = text.slice(0, match.index ?? 0);
      initSites.push({
        file: file.path,
        line: before.split('\n').length,
        scope: enclosingScope(before) || '(top level)',
        // Resolved in a second pass, once every file has been read.
        runsAtLaunch: 'unknown',
      });
    }
    const level = text.match(/\.logLevel\(\s*\.(\w+)\s*\)/);
    if (level && !logLevel) logLevel = level[1];
  }

  for (const site of initSites) {
    site.runsAtLaunch = resolveRunsAtLaunch(site.scope, texts);
  }

  return {
    files: files.length,
    sdkImports: [...sdkImports],
    appGroupIds: [...appGroupIds],
    initSites,
    identifies,
    logLevel,
  };
}

export interface ForwardingResult {
  forwards: boolean;
  /** `file:line` of the call, when one was found. */
  site?: string;
  /** The extension declares the entry point iOS calls, whatever it does inside. */
  declaresEntryPoint: boolean;
}

/**
 * Does the extension hand the request to the SDK?
 *
 * Both entry points count: `MessagingPush.shared.didReceive` and the platform facade
 * `MessagingPushAPN.shared.didReceive`, which forwards to it. The override itself is
 * excluded deliberately — `override func didReceive` is what iOS calls, and an extension
 * that declares it and then calls `contentHandler` directly is the failure this whole tool
 * exists to catch.
 */
export function forwardsToSdk(files: SwiftFile[]): ForwardingResult {
  let declaresEntryPoint = false;
  let site: string | undefined;

  for (const file of files) {
    const mentionsSdk = /Cio|CustomerIO|MessagingPush/.test(file.text);
    const lines = file.text.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (/func\s+didReceive\s*\(/.test(line)) {
        declaresEntryPoint = true;
        continue;
      }
      const explicit =
        /\b(?:MessagingPush|MessagingPushAPN|MessagingPushFCM)\s*\.\s*shared\s*\.\s*didReceive\s*\(/.test(
          line
        );
      // A stored instance is the other real shape: `messagingPush.didReceive(request…)`.
      const indirect = mentionsSdk && /\w\s*\.\s*didReceive\s*\(/.test(line);
      if ((explicit || indirect) && !site) site = `${file.path}:${index + 1}`;
    }
  }

  return { forwards: site !== undefined, site, declaresEntryPoint };
}
