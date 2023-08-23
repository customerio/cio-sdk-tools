import { trimEqualOperator, uniqueValues } from '.';

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
    return npmLockJson.dependencies[packageName].version;
  } else {
    return undefined;
  }
}
