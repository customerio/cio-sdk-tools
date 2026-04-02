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
Run doctor with current code changes. Each run appends to the same file with a timestamp heading.

```bash
npm run test:doctor
```

### Test Global Version
Run doctor with the published npm package.

```bash
npm run test:doctor:global
```

### Compare Local vs Global
Run both versions and generate diffs.

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

Results saved to `results/doctor/` directory with one `.md` file per app:
```
results/doctor/
  ios_spm.md
  ios_cocoapods.md
  flutter.md
  react_native.md
  expo.md
```

Each run **appends** to the file with a timestamp section heading, building a history of runs.

### Compare Mode
Compare mode adds `_summary.md` with all diffs, plus each app file includes local, global, and diff sections:
```
results/doctor/
  _summary.md    # All apps diff summary (sorts first)
  ios_spm.md                # Local + Global + Diff
  ios_cocoapods.md
  ...
```
