export const iOS_USER_NOTIFICATION_CENTER_SWIFT: RegExp =
  /func\s+userNotificationCenter\(\s*_\s*center:\s*UNUserNotificationCenter,\s*didReceive\s*response:\s*UNNotificationResponse,\s*withCompletionHandler\s*completionHandler:/;
export const iOS_USER_NOTIFICATION_CENTER_OBJC: RegExp =
  /-\s*\(\s*void\s*\)\s*userNotificationCenter:\s*\(UNUserNotificationCenter\s*\*\)\s*center\s*didReceiveNotificationResponse:\s*\(UNNotificationResponse\s*\*\)\s*response\s*withCompletionHandler:\s*\(void\s*\(\^\)\(void\)\)\s*completionHandler/;
export const iOS_PUSH_ENV_ENTITLEMENT = /<key>\s*aps-environment\s*<\/key>/;
