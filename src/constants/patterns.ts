export function createFilePattern(fileNameWithExtension: string): RegExp {
  return new RegExp(`${fileNameWithExtension}$`);
}

export function constructFilePattern(
  fileName: string,
  extensions: string[],
): RegExp {
  const joinedExtensions = extensions
    .map((ext) => ext.replace(".", "\\."))
    .join("|"); // Escape the dots and join with |
  return new RegExp(`${fileName}(${joinedExtensions})$`);
}
export function constructKeywordFilePattern(
  keyword: string,
  extensions: string[],
): RegExp {
  const joinedExtensions = extensions
    .map((ext) => ext.replace(".", "\\."))
    .join("|"); // Escape the dots and join with |
  return new RegExp(`${keyword}.*(${joinedExtensions})$`, "i");
}

export const iOS_USER_NOTIFICATION_CENTER_SWIFT: RegExp =
  /func\s+userNotificationCenter\(\s*_\s*center:\s*UNUserNotificationCenter,\s*didReceive\s*response:\s*UNNotificationResponse,\s*withCompletionHandler\s*completionHandler:/;
export const iOS_USER_NOTIFICATION_CENTER_OBJC: RegExp =
  /-\s*\(\s*void\s*\)\s*userNotificationCenter:\s*\(UNUserNotificationCenter\s*\*\)\s*center\s*didReceiveNotificationResponse:\s*\(UNNotificationResponse\s*\*\)\s*response\s*withCompletionHandler:\s*\(void\s*\(\^\)\(void\)\)\s*completionHandler/;
export const iOS_PUSH_ENV_ENTITLEMENT = /<key>\s*aps-environment\s*<\/key>/;
