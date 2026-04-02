import https from 'node:https';
import { logger, trimEqualOperator, uniqueValues } from '.';
import { GITHUB_ORG_NAME_CUSTOMER_IO } from '../constants';

function createPodRegex(podName: string): RegExp {
  return new RegExp(`- ${podName}\\s+\\(([^)]+)\\)`, 'g');
}

export function extractVersionFromPodLock(
  podfileLockContent: string,
  podName: string
): string | undefined {
  const podPattern: RegExp = createPodRegex(podName);
  const versions: string[] = [];

  let match;
  while ((match = podPattern.exec(podfileLockContent)) !== null) {
    versions.push(match[1]);
  }

  if (versions.length > 0) {
    const distinctValues = uniqueValues(
      versions.map((version) => trimEqualOperator(version))
    );
    return distinctValues.join(', ');
  } else {
    return undefined;
  }
}

function createPackageRegexYarn(packageName: string): RegExp {
  return new RegExp(
    `${packageName}@[^:]+:\\s*\\n\\s*version\\s*"([^"]+)"`,
    'g'
  );
}

export function extractVersionFromPackageLock(
  packageLockContent: string,
  packageLockType: string,
  packageName: string
): string | undefined {
  if (packageLockType === 'yarn') {
    const packagePattern: RegExp = createPackageRegexYarn(packageName);
    const lockVersionMatch = packagePattern.exec(packageLockContent);
    return lockVersionMatch ? lockVersionMatch[1] : undefined;
  } else if (packageLockType === 'npm') {
    const npmLockJson = JSON.parse(packageLockContent);
    // Regex to match the package name
    const packagePatternNpm: RegExp = new RegExp(`${packageName}`, 'i');

    // Find a matching dependency
    const matchingPackage = Object.keys(npmLockJson.packages).find((dep) =>
      packagePatternNpm.test(dep)
    );

    return matchingPackage
      ? npmLockJson.packages[matchingPackage].version
      : undefined;
  } else {
    return undefined;
  }
}

export function extractVersionFromPackageJson(
  packageFileContent: string,
  packageName: string
): string | undefined {
  const packageJson = JSON.parse(packageFileContent);
  const dependencies = packageJson.dependencies;
  return dependencies[packageName];
}

/**
 * Extracts version from build.gradle for a specific Android dependency.
 * Handles both Groovy DSL and Kotlin DSL syntax.
 *
 * @example
 * // Groovy DSL: implementation 'io.customer.android:datapipelines:3.1.0'
 * // Kotlin DSL: implementation("io.customer.android:datapipelines:3.1.0")
 *
 * @param content Content of the build.gradle or build.gradle.kts file
 * @param packageGroup Maven group ID (e.g., 'io.customer.android')
 * @param moduleName Module name (e.g., 'datapipelines')
 * @returns Version string if found, undefined otherwise
 */
export function extractVersionFromBuildGradle(
  content: string,
  packageGroup: string,
  moduleName: string
): string | undefined {
  // Pattern matches: packageGroup:moduleName:version
  // Handles both single and double quotes, with or without parentheses
  const escapedGroup = packageGroup.replace(/\./g, '\\.');
  const pattern = new RegExp(
    `['"]${escapedGroup}:${moduleName}:([\\d.]+(?:-[\\w.]+)?)['"]`,
    'g'
  );
  const match = pattern.exec(content);
  return match ? match[1] : undefined;
}

/**
 * Extracts version, branch, or revision from Package.resolved (SPM) for a given package identity
 * Package.resolved format (v2/v3):
 * {
 *   "pins": [
 *     {
 *       "identity": "customerio-ios",
 *       "state": { "version": "4.3.1" }  // or "branch": "main" or "revision": "abc123..."
 *     }
 *   ]
 * }
 */
export function extractVersionFromPackageResolved(
  packageResolvedContent: string,
  packageIdentity: string
): string | undefined {
  try {
    const packageResolved = JSON.parse(packageResolvedContent);
    const pins = packageResolved.pins || [];

    const matchedPin = pins.find(
      (pin: { identity: string }) => pin.identity === packageIdentity
    );

    // Return version, branch, or revision (similar to CocoaPods handling)
    return (
      matchedPin?.state?.version ||
      matchedPin?.state?.branch ||
      matchedPin?.state?.revision
    );
  } catch (error) {
    logger.debug(`Error parsing Package.resolved: ${error}`);
    return undefined;
  }
}

/**
 * Extracts version for an SPM module/product from Package.resolved.
 *
 * Note: Package.resolved only lists packages, not individual products/modules.
 * For Customer.io iOS SDK, all modules (DataPipelines, MessagingInApp, etc.) are
 * products of the main package and share the same version. We cannot determine
 * which specific products are actually imported without parsing Swift source files.
 *
 * The moduleName parameter exists for API consistency with CocoaPods but is not used.
 */
export function extractModuleVersionFromPackageResolved(
  packageResolvedContent: string,
  packageIdentity: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  moduleName: string
): string | undefined {
  // All SPM products share the package version
  return extractVersionFromPackageResolved(
    packageResolvedContent,
    packageIdentity
  );
}

export async function fetchLatestVersion(
  packageName: string
): Promise<string | undefined> {
  try {
    return await fetchLatestGitHubRelease(packageName);
  } catch (err) {
    logger.debug(
      `Unable to fetch latest package version for ${packageName}.  Error: ${err}`
    );
    return undefined;
  }
}

export function fetchLatestGitHubRelease(
  repo: string,
  owner: string = GITHUB_ORG_NAME_CUSTOMER_IO
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
      { headers: { 'User-Agent': 'NodeJS' } },
      (response) => {
        let data = '';
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => resolve(JSON.parse(data).tag_name));
      }
    );
    request.setTimeout(3000, () => {
      request.destroy();
      reject(new Error('Request timed out'));
    });
    request.on('error', (error) => reject(error));
  });
}

/**
 * Extracts the first semantic version number from a string that may contain multiple versions separated by commas.
 *
 * @param versions String containing multiple versions
 * @returns First semantic version found in the string, or undefined if no version is found or input is undefined.
 */
export function extractSemanticVersion(
  versions: string | undefined
): string | undefined {
  if (versions === undefined) return undefined;

  // Regex pattern to match a semantic version number
  const versionPattern = /\b\d+\.\d+(\.\d+)?\b/;
  const match = versions.match(versionPattern);
  return match ? match[0] : undefined;
}

/**
 * Compares two semantic version strings.
 *
 * @param version1 First version string to compare.
 * @param version2 Second version string to compare.
 * @returns -1 if version1 is less than version2, 1 if version1 is greater than version2, and 0 if they are equal.
 */
export function compareSemanticVersions(
  version1: string | undefined,
  version2: string | undefined
): number {
  // Handle undefined values
  if (version1 === undefined && version2 === undefined) return 0;
  if (version1 === undefined) return -1;
  if (version2 === undefined) return 1;

  const v1Parts = version1.split('-')[0].split('.').map(Number);
  const v2Parts = version2.split('-')[0].split('.').map(Number);

  // Compare each part of the version numbers
  for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
    const part1 = v1Parts[i] ?? 0; // Use 0 for missing parts
    const part2 = v2Parts[i] ?? 0; // Use 0 for missing parts

    if (part1 > part2) return 1;
    if (part1 < part2) return -1;
  }

  // If all parts are equal, return 0
  return 0;
}
