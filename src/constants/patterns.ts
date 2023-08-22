export const iOS_APP_DELEGATE_OBJECTIVE_C: RegExp = /AppDelegate\.m$/;
export const iOS_APP_DELEGATE_OBJECTIVE_C_PLUS_PLUS: RegExp =
  /AppDelegate\.mm$/;
export const iOS_APP_DELEGATE_SWIFT: RegExp = /AppDelegate\.swift$/;
export const iOS_ENTITLEMENTS: RegExp = /\.entitlements$/;
export const iOS_PROJECT_XCODE: RegExp = /\.pbxproj$/;

export const SWIFT_USER_NOTIFICATION_CENTER_PATTERN : RegExp =
  /func\s+userNotificationCenter\(\s*_\s*center:\s*UNUserNotificationCenter,\s*didReceive\s*response:\s*UNNotificationResponse,\s*withCompletionHandler\s*completionHandler:/;

export const OBJC_USER_NOTIFICATION_CENTER_PATTERN : RegExp = 
  /-\s*\(\s*void\s*\)\s*userNotificationCenter:\s*\(UNUserNotificationCenter\s*\*\)\s*center\s*didReceiveNotificationResponse:\s*\(UNNotificationResponse\s*\*\)\s*response\s*withCompletionHandler:\s*\(void\s*\(\^\)\(void\)\)\s*completionHandler/;

export const iOS_PUSH_ENV_ENTITLEMENT = /<key>\s*aps-environment\s*<\/key>/;

export const iOS_POD_CIO_REACT_NATIVE =
  /- customerio-reactnative\s+\(([^)]+)\)/g;
export const iOS_POD_CIO_TRACKING = /- CustomerIO\/Tracking\s+\(([^)]+)\)/g;
export const iOS_POD_CIO_IN_APP = /- CustomerIO\/MessagingInApp\s+\(([^)]+)\)/g;
export const iOS_POD_CIO_PUSH_APN =
  /- CustomerIO\/MessagingPushAPN\s+\(([^)]+)\)/g;
export const iOS_POD_CIO_PUSH_FCM =
  /- CustomerIO\/MessagingPushFCM\s+\(([^)]+)\)/g;
