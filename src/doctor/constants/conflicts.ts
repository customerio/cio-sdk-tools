export const reactNativePackages = [
  'react-native-onesignal',
  '@react-native-firebase/messaging',
];

export const iosPods = ['OneSignal', 'Firebase/Messaging'];
// Note: SPM packages may contain multiple products. Package.resolved only tracks
// packages, not individual products, so we cannot detect which specific products
// are in use (e.g., firebase-ios-sdk includes Analytics, Auth, Messaging, etc).
export const iosSPMPackages = ['onesignal-ios-sdk', 'firebase-ios-sdk'];
