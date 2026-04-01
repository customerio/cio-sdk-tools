export const iOS_DEPLOYMENT_TARGET_MIN_REQUIRED = 13.0;
export const GITHUB_ORG_NAME_CUSTOMER_IO = 'customerio';
export const PACKAGE_NAME_REACT_NATIVE = 'customerio-reactnative';

// CocoaPods pod names (used in Podfile and Podfile.lock)
export const POD_COMMON = 'CustomerIOCommon';
export const POD_DATA_PIPELINE = 'CustomerIODataPipelines';
export const POD_MESSAGING_IN_APP = 'CustomerIOMessagingInApp';
export const POD_MESSAGING_PUSH = 'CustomerIOMessagingPush';
export const POD_MESSAGING_PUSH_APN = 'CustomerIOMessagingPushAPN';
export const POD_MESSAGING_PUSH_FCM = 'CustomerIOMessagingPushFCM';

// SPM package identities (used in Package.resolved)
export const SPM_PACKAGE_IDENTITY = 'customerio-ios';
export const SPM_DATA_PIPELINE = 'DataPipelines';
export const SPM_MESSAGING_IN_APP = 'MessagingInApp';
export const SPM_MESSAGING_PUSH_APN = 'MessagingPushAPN';
export const SPM_MESSAGING_PUSH_FCM = 'MessagingPushFCM';

/**
 * Specific versions of SDKs for which we have special handling in doctor tool
 */
// iOS SDK version that introduced support for swizzling in push module
export const iOS_SDK_PUSH_SWIZZLE_VERSION = '2.11';

// Android SDK constants
export const ANDROID_MIN_SDK_VERSION = 21;
export const ANDROID_SDK_MIN_VERSION = '3.0.0';
export const ANDROID_PACKAGE_GROUP = 'io.customer.android';
export const ANDROID_MODULE_DATA_PIPELINES = 'datapipelines';
export const ANDROID_MODULE_MESSAGING_IN_APP = 'messaging-in-app';
export const ANDROID_MODULE_MESSAGING_PUSH_FCM = 'messaging-push-fcm';
