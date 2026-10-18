import { promises as fs } from 'fs';
import * as path from 'path';

/** The native SDK's version, and where it was read: a wrapper's own version says nothing here. */
export interface SdkVersion {
  version: string;
  source: string;
}

export type SdkPlatform = 'ios' | 'android';

/**
 * The SDK majors whose stores and sentences this tool's readers were checked against. A newer
 * major may have moved any of them, so what the tool fails to find there is unproven rather
 * than a fault; within a major, each SDK's contract tests hold the names still. Android 3 kept
 * its token somewhere else entirely.
 */
export const CHECKED_MAJORS: Record<SdkPlatform, number[]> = {
  ios: [3, 4],
  android: [4],
};

export function versionParts(version: string): number[] | undefined {
  const match = version.trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** Negative, zero or positive, like a sort comparator; an unreadable version sorts first. */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a) ?? [-1, 0, 0];
  const right = versionParts(b) ?? [-1, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/**
 * Whether the tool knows where this SDK version keeps what it reads. An unknown version is
 * not known: the tool cannot tell a missing token from one it looked for in the wrong place.
 */
export function versionChecked(
  platform: SdkPlatform,
  version: string | undefined
): boolean {
  const major = version ? versionParts(version)?.[0] : undefined;
  return major !== undefined && CHECKED_MAJORS[platform].includes(major);
}

/**
 * The iOS SDK's version from what the dependency manager resolved: CocoaPods' lock file, or
 * SwiftPM's `Package.resolved` wherever Xcode keeps it. A local package reference resolves to
 * no version at all, which is what the SDK's own sample apps use.
 */
export async function iosSdkVersion(
  scanRoot: string
): Promise<SdkVersion | undefined> {
  const podfileLock = path.join(scanRoot, 'Podfile.lock');
  const pods = await fs.readFile(podfileLock, 'utf8').catch(() => undefined);
  const fromPods = pods && podVersion(pods);
  if (fromPods) return { version: fromPods, source: 'Podfile.lock' };

  for (const resolved of await packageResolvedFiles(scanRoot)) {
    const text = await fs.readFile(resolved, 'utf8').catch(() => undefined);
    const version = text && resolvedVersion(text);
    if (version) {
      return { version, source: path.relative(scanRoot, resolved) };
    }
  }
  return undefined;
}

/** `- CustomerIO/DataPipelines (4.9.0):`, or a wrapper's `(= 4.9.0)` dependency on it. */
export function podVersion(lock: string): string | undefined {
  return lock.match(
    /^\s*-\s+"?CustomerIO[A-Za-z]*(?:\/[A-Za-z]+)?"?\s+\((?:=\s*)?(\d+\.\d+\.\d+)\)/m
  )?.[1];
}

/** Every shape of `Package.resolved` Xcode has written: v1's `object.pins`, v2 and v3's `pins`. */
export function resolvedVersion(text: string): string | undefined {
  let parsed: {
    pins?: ResolvedPin[];
    object?: { pins?: ResolvedPin[] };
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const pins = parsed.pins ?? parsed.object?.pins ?? [];
  const pin = pins.find((each) =>
    /customerio-ios(?:\.git)?$/i.test(
      each.identity ?? each.location ?? each.repositoryURL ?? each.package ?? ''
    )
  );
  return pin?.state?.version ?? undefined;
}

interface ResolvedPin {
  identity?: string;
  location?: string;
  package?: string;
  repositoryURL?: string;
  state?: { version?: string | null };
}

async function packageResolvedFiles(scanRoot: string): Promise<string[]> {
  const files = [path.join(scanRoot, 'Package.resolved')];
  const entries = await fs.readdir(scanRoot).catch(() => [] as string[]);
  for (const entry of entries) {
    if (entry.endsWith('.xcworkspace')) {
      files.push(
        path.join(
          scanRoot,
          entry,
          'xcshareddata',
          'swiftpm',
          'Package.resolved'
        )
      );
    } else if (entry.endsWith('.xcodeproj')) {
      files.push(
        path.join(
          scanRoot,
          entry,
          'project.xcworkspace',
          'xcshareddata',
          'swiftpm',
          'Package.resolved'
        )
      );
    }
  }
  return files;
}
