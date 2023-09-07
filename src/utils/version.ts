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
