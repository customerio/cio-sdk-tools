# Doctor Testing Script

## Overview

Tests the doctor command on multiple sample apps to validate changes across different project types (iOS, React Native, Flutter, etc.).

## Quick Start

Run the script - no setup needed:

```bash
npm run test:doctor
```

The script auto-creates `.testapps.doctor.json` with example configuration on first run.

## Usage

### Test Local Version (Default)
Run doctor with current code changes. Results overwrite previous runs (no timestamp).

```bash
npm run test:doctor
```

### Test Global Version
Run doctor with the published npm package.

```bash
npm run test:doctor:global
```

### Compare Local vs Global
Run both versions and save results with timestamps for comparison.

```bash
npm run test:doctor:compare
```

### Clean Before Running
Add `--clean` to remove old results before running tests.

```bash
npm run test:doctor -- --clean
npm run test:doctor:compare -- --clean
```

## Configuration

On first run, the script auto-creates `.testapps.doctor.json` with sample app paths.

**To customize:**
- Edit `.testapps.doctor.json` to point to local apps
- Use absolute paths (`/Users/name/...`) or relative paths (`../...`)
- File is gitignored

## Output

### Default Behavior (No Timestamps)
Results saved to `results/doctor/` directory:
```
results/doctor/
  iOS-SPM.txt
  iOS-CocoaPods.txt
  Flutter.txt
  React-Native.txt
  Expo.txt
```

Files are **overwritten** on each run - great for iterative testing.

### With Timestamps
When using `--timestamped` flag or compare mode, files include timestamps:
```
results/doctor/
  iOS-SPM-20260327-142505.txt
  iOS-CocoaPods-20260327-142505.txt
  ...
```

### Compare Mode
When using `npm run test:doctor:compare`, automatically generates diffs:
```
results/doctor/
  comparison-summary-20260327-142505.txt    # All apps summary
  iOS-SPM-local-20260327-142505.txt
  iOS-SPM-global-20260327-142505.txt
  iOS-SPM-diff-20260327-142505.txt          # Pre-computed diff
  ...
```
