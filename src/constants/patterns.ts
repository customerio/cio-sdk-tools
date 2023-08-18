export const iOS_APP_DELEGATE_OBJECTIVE_C: RegExp = /AppDelegate\.m$/;
export const iOS_APP_DELEGATE_OBJECTIVE_C_PLUS_PLUS: RegExp =
  /AppDelegate\.mm$/;
export const iOS_APP_DELEGATE_SWIFT: RegExp = /AppDelegate\.swift$/;
export const iOS_ENTITLEMENTS: RegExp = /\.entitlements$/;
export const iOS_PROJECT_XCODE: RegExp = /\.pbxproj$/;

export const iOS_OBJ_C_USER_NOTIFICATION_CENTER =
  /-\s?\(void\)userNotificationCenter:\s*\(UNUserNotificationCenter\s?\*\)center\s*/;
export const iOS_PUSH_ENV_ENTITLEMENT = /<key>\s*aps-environment\s*<\/key>/;

export const iOS_POD_CIO_REACT_NATIVE =
  /- customerio-reactnative\s+\(([^)]+)\)/g;
export const iOS_POD_CIO_TRACKING = /- CustomerIO\/Tracking\s+\(([^)]+)\)/g;
export const iOS_POD_CIO_IN_APP = /- CustomerIO\/MessagingInApp\s+\(([^)]+)\)/g;
export const iOS_POD_CIO_PUSH_APN =
  /- CustomerIO\/MessagingPushAPN\s+\(([^)]+)\)/g;
export const iOS_POD_CIO_PUSH_FCM =
  /- CustomerIO\/MessagingPushFCM\s+\(([^)]+)\)/g;
