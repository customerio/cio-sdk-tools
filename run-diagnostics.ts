import * as fs from 'fs';
import * as path from 'path';
import * as xcode from 'xcode';

const cleanString = (input: string) => input.replace(/['"]/g, '').trim();

const searchFileInDirectory = async (startPath: string, filter: RegExp) => {
  const results = [];
  const files = await fs.readdir(startPath);
  const tasks = files.map(async (file) => {
    const filename = path.join(startPath, file);
    const stat = await fs.lstat(filename);

    if (filename.includes('/Pods/')) {
      return;
    }

    if (stat.isDirectory()) {
      const subDirResults = await searchFileInDirectory(filename, filter);
      results = results.concat(subDirResults);
    } else if (filter.test(filename)) {
      results.push(filename);
    }
  });

  await Promise.all(tasks);

  return results;
};

const checkNotificationServiceExtension = (targets: Object) => {
  let extensionCount = 0;
  let isEmbedded = false;
  let isFoundationExtension = false;

  for (const key in targets) {
    const target = targets[key];

    if (target.productType && cleanString(target.productType) === 'com.apple.product-type.app-extension') {
      console.log(`🔎 Found extension app: ${JSON.stringify(target)}`);
      console.log(`🔎 Found NSE: ${target.name}`);
      extensionCount++;
    }

    if (target.productType && cleanString(target.productType) === 'com.apple.product-type.application') {
      console.log(`🔎 Checking if the NSE is embedded into target app: ${target.productType}`);
      if (target.buildPhases && target.buildPhases.find((phase) => cleanString(phase.comment) === 'Embed App Extensions')) {
        isEmbedded = true;
      } else if (target.buildPhases && target.buildPhases.find((phase) => cleanString(phase.comment) === 'Embed Foundation Extensions')) {
        isFoundationExtension = true;
      }
    }
  }

  if (extensionCount > 1) {
    console.log('❌ Multiple Notification Service Extensions found. Only one should be present.');
  } else if (extensionCount === 1) {
    if (isEmbedded) {
      console.log('✅ Notification Service Extension found and embedded.');
    } else if (isFoundationExtension) {
      console.log('✅ Notification Service Extension found but not embedded as it is a Foundation Extension.');
    } else {
      console.log('❌ Notification Service Extension found but not embedded.');
    }
  } else {
    console.log('❌ Notification Service Extension not found.');
  }
};

const getDeploymentTargetVersion = (pbxProject: Object) => {
    const buildConfig = pbxProject.pbxXCBuildConfigurationSection();
    const nativeTargets = pbxProject.pbxNativeTargetSection();
    const configList = pbxProject.pbxXCConfigurationList();
  
    let nseBuildConfigKeys = [];
  
    // Find the NSE build configuration list key
    for (const key in nativeTargets) {
      const nativeTarget = nativeTargets[key];
      if (nativeTarget.productType && cleanString(nativeTarget.productType) === 'com.apple.product-type.app-extension') {
        const configListKey = nativeTarget.buildConfigurationList;
        const buildConfigurations = configList[configListKey].buildConfigurations;
        nseBuildConfigKeys = buildConfigurations.map(config => config.value);
        break;
      }
    }
  
    // Return deployment target of the NSE
    if (nseBuildConfigKeys.length) {
      for (const key in buildConfig) {
        const config = buildConfig[key];
  
        // Check if the config is the NSE build configuration and it has an iOS deployment target
        if (nseBuildConfigKeys.includes(key) && config.buildSettings && config.buildSettings['IPHONEOS_DEPLOYMENT_TARGET']) {
          return config.buildSettings['IPHONEOS_DEPLOYMENT_TARGET'];
        }
      }
    }
  
    return null;
  };
  
  // Validate input argument
  if (!process.argv[2]) {
    console.error('🚨 Error: No directory provided.');
    process.exit(1);
  }
  
  // Get root path
  const rootPath = process.argv[2];
  
  // Define the patterns to search for
  const projPattern = /\.pbxproj$/;
  const appDelegatePattern = /AppDelegate\.swift$/;
  
  async function checkProject() {
    // Search for the .pbxproj and AppDelegate.swift files
    console.log('🔎 Searching for project files...');
    const [projectPaths, appDelegatePaths] = await Promise.all([
      searchFileInDirectory(rootPath, projPattern),
      searchFileInDirectory(rootPath, appDelegatePattern)
    ]);
  
    // Process each .pbxproj file
    for (const projectPath of projectPaths) {
      const project = xcode.project(projectPath);
      project.parseSync();
  
      console.log(`🔎 Checking project at path: ${projectPath}`);
  
      const targets = project.pbxNativeTargetSection();
  
      // Check for Notification Service Extension
      checkNotificationServiceExtension(targets);
  
      const deploymentTarget = getDeploymentTargetVersion(project);
      console.log(`🔔 Deployment Target Version for NSE: ${deploymentTarget}. Ensure this version is not higher than the iOS version of the devices where the app will be installed. A higher target version may prevent some features, like rich notifications, from working correctly.`);
    }
  
    // Process each AppDelegate.swift file
    for (const appDelegatePath of appDelegatePaths) {
      console.log(`🔎 Checking AppDelegate at path: ${appDelegatePath}`);
      try {
        const contents = await fs.readFile(appDelegatePath, 'utf8');
        if (contents.includes('func userNotificationCenter(')) {
          console.log('✅ Required method found in AppDelegate.swift');
        } else {
          console.log('❌ Required method not found in AppDelegate.swift');
        }
      } catch (err) {
        console.error('🚨 Error reading file:', err);
      }
    }
  }
  
  checkProject().catch(err => console.error('🚨 Error during project check:', err));
  