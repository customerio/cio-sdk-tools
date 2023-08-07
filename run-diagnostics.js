"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var fs = require("fs");
var path = require("path");
var xcode = require("xcode");
var cleanString = function (input) { return input.replace(/['"]/g, '').trim(); };
var searchFileInDirectory = function (startPath, filter) { return __awaiter(void 0, void 0, void 0, function () {
    var results, files, tasks;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                results = [];
                return [4 /*yield*/, fs.readdir(startPath)];
            case 1:
                files = _a.sent();
                tasks = files.map(function (file) { return __awaiter(void 0, void 0, void 0, function () {
                    var filename, stat, subDirResults;
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0:
                                filename = path.join(startPath, file);
                                return [4 /*yield*/, fs.lstat(filename)];
                            case 1:
                                stat = _a.sent();
                                if (filename.includes('/Pods/')) {
                                    return [2 /*return*/];
                                }
                                if (!stat.isDirectory()) return [3 /*break*/, 3];
                                return [4 /*yield*/, searchFileInDirectory(filename, filter)];
                            case 2:
                                subDirResults = _a.sent();
                                results = results.concat(subDirResults);
                                return [3 /*break*/, 4];
                            case 3:
                                if (filter.test(filename)) {
                                    results.push(filename);
                                }
                                _a.label = 4;
                            case 4: return [2 /*return*/];
                        }
                    });
                }); });
                return [4 /*yield*/, Promise.all(tasks)];
            case 2:
                _a.sent();
                return [2 /*return*/, results];
        }
    });
}); };
var checkNotificationServiceExtension = function (targets) {
    var extensionCount = 0;
    var isEmbedded = false;
    var isFoundationExtension = false;
    for (var key in targets) {
        var target = targets[key];
        if (target.productType && cleanString(target.productType) === 'com.apple.product-type.app-extension') {
            console.log("\uD83D\uDD0E Found extension app: ".concat(JSON.stringify(target)));
            console.log("\uD83D\uDD0E Found NSE: ".concat(target.name));
            extensionCount++;
        }
        if (target.productType && cleanString(target.productType) === 'com.apple.product-type.application') {
            console.log("\uD83D\uDD0E Checking if the NSE is embedded into target app: ".concat(target.productType));
            if (target.buildPhases && target.buildPhases.find(function (phase) { return cleanString(phase.comment) === 'Embed App Extensions'; })) {
                isEmbedded = true;
            }
            else if (target.buildPhases && target.buildPhases.find(function (phase) { return cleanString(phase.comment) === 'Embed Foundation Extensions'; })) {
                isFoundationExtension = true;
            }
        }
    }
    if (extensionCount > 1) {
        console.log('❌ Multiple Notification Service Extensions found. Only one should be present.');
    }
    else if (extensionCount === 1) {
        if (isEmbedded) {
            console.log('✅ Notification Service Extension found and embedded.');
        }
        else if (isFoundationExtension) {
            console.log('✅ Notification Service Extension found but not embedded as it is a Foundation Extension.');
        }
        else {
            console.log('❌ Notification Service Extension found but not embedded.');
        }
    }
    else {
        console.log('❌ Notification Service Extension not found.');
    }
};
var getDeploymentTargetVersion = function (pbxProject) {
    var buildConfig = pbxProject.pbxXCBuildConfigurationSection();
    var nativeTargets = pbxProject.pbxNativeTargetSection();
    var configList = pbxProject.pbxXCConfigurationList();
    var nseBuildConfigKeys = [];
    // Find the NSE build configuration list key
    for (var key in nativeTargets) {
        var nativeTarget = nativeTargets[key];
        if (nativeTarget.productType && cleanString(nativeTarget.productType) === 'com.apple.product-type.app-extension') {
            var configListKey = nativeTarget.buildConfigurationList;
            var buildConfigurations = configList[configListKey].buildConfigurations;
            nseBuildConfigKeys = buildConfigurations.map(function (config) { return config.value; });
            break;
        }
    }
    // Return deployment target of the NSE
    if (nseBuildConfigKeys.length) {
        for (var key in buildConfig) {
            var config = buildConfig[key];
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
var rootPath = process.argv[2];
// Define the patterns to search for
var projPattern = /\.pbxproj$/;
var appDelegatePattern = /AppDelegate\.swift$/;
function checkProject() {
    return __awaiter(this, void 0, void 0, function () {
        var _a, projectPaths, appDelegatePaths, _i, projectPaths_1, projectPath, project, targets, deploymentTarget, _b, appDelegatePaths_1, appDelegatePath, contents, err_1;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    // Search for the .pbxproj and AppDelegate.swift files
                    console.log('🔎 Searching for project files...');
                    return [4 /*yield*/, Promise.all([
                            searchFileInDirectory(rootPath, projPattern),
                            searchFileInDirectory(rootPath, appDelegatePattern)
                        ])];
                case 1:
                    _a = _c.sent(), projectPaths = _a[0], appDelegatePaths = _a[1];
                    // Process each .pbxproj file
                    for (_i = 0, projectPaths_1 = projectPaths; _i < projectPaths_1.length; _i++) {
                        projectPath = projectPaths_1[_i];
                        project = xcode.project(projectPath);
                        project.parseSync();
                        console.log("\uD83D\uDD0E Checking project at path: ".concat(projectPath));
                        targets = project.pbxNativeTargetSection();
                        // Check for Notification Service Extension
                        checkNotificationServiceExtension(targets);
                        deploymentTarget = getDeploymentTargetVersion(project);
                        console.log("\uD83D\uDD14 Deployment Target Version for NSE: ".concat(deploymentTarget, ". Ensure this version is not higher than the iOS version of the devices where the app will be installed. A higher target version may prevent some features, like rich notifications, from working correctly."));
                    }
                    _b = 0, appDelegatePaths_1 = appDelegatePaths;
                    _c.label = 2;
                case 2:
                    if (!(_b < appDelegatePaths_1.length)) return [3 /*break*/, 7];
                    appDelegatePath = appDelegatePaths_1[_b];
                    console.log("\uD83D\uDD0E Checking AppDelegate at path: ".concat(appDelegatePath));
                    _c.label = 3;
                case 3:
                    _c.trys.push([3, 5, , 6]);
                    return [4 /*yield*/, fs.readFile(appDelegatePath, 'utf8')];
                case 4:
                    contents = _c.sent();
                    if (contents.includes('func userNotificationCenter(')) {
                        console.log('✅ Required method found in AppDelegate.swift');
                    }
                    else {
                        console.log('❌ Required method not found in AppDelegate.swift');
                    }
                    return [3 /*break*/, 6];
                case 5:
                    err_1 = _c.sent();
                    console.error('🚨 Error reading file:', err_1);
                    return [3 /*break*/, 6];
                case 6:
                    _b++;
                    return [3 /*break*/, 2];
                case 7: return [2 /*return*/];
            }
        });
    });
}
checkProject().catch(function (err) { return console.error('🚨 Error during project check:', err); });
