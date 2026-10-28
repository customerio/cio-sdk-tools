#!/usr/bin/env node
/**
 * Does each SDK's latest release still say what `verify push` reads?
 *
 * The tool reads SDK log sentences and SDK store names (docs/verify-contract.md). This checks
 * the fixed part of every one of them against the SDKs' sources at their latest release tag,
 * or at a ref or a local checkout given, and fails naming each one that is gone, so a reworded
 * line is found before a customer's run calls a working app broken.
 *
 *   node scripts/sdk-canary.js                      latest release of each SDK
 *   node scripts/sdk-canary.js --ref main           each SDK's main branch
 *   node scripts/sdk-canary.js --ios ../customerio-ios --android ../customerio-android
 *
 * Needs the compiled tool (`npx tsc`) and git.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { canaryLiterals } = require('../dist/verify/areas/push/on_device/markers');

const SDKS = {
  ios: { repo: 'https://github.com/customerio/customerio-ios.git', sources: ['Sources'] },
  android: {
    repo: 'https://github.com/customerio/customerio-android.git',
    sources: ['core', 'datapipelines', 'messagingpush'],
  },
};

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The newest `x.y.z` tag, ignoring pre-releases. */
function latestRelease(repo) {
  const tags = git(['ls-remote', '--tags', '--refs', repo])
    .split('\n')
    .map((line) => line.split('refs/tags/')[1])
    .filter((tag) => tag && /^v?\d+\.\d+\.\d+$/.test(tag));
  const parts = (tag) => tag.replace(/^v/, '').split('.').map(Number);
  tags.sort((a, b) => {
    const [x, y] = [parts(a), parts(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  return tags[tags.length - 1];
}

function checkout(name, sdk, scratch) {
  const local = argument(name);
  if (local) return { dir: path.resolve(local), at: `${local} (as checked out)` };
  const ref = argument('ref') ?? latestRelease(sdk.repo);
  const dir = path.join(scratch, name);
  git(['clone', '--quiet', '--depth', '1', '--branch', ref, sdk.repo, dir]);
  return { dir, at: ref };
}

/** Whether any tracked source file holds the literal, exactly. */
function found(dir, sources, literal) {
  try {
    git(['grep', '-q', '-F', '-e', literal, '--', ...sources], dir);
    return true;
  } catch {
    return false;
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-canary-'));
let missing = 0;
try {
  const literals = canaryLiterals();
  for (const [name, sdk] of Object.entries(SDKS)) {
    const { dir, at } = checkout(name, sdk, scratch);
    const gone = literals[name].filter((literal) => !found(dir, sdk.sources, literal));
    console.log(`${name} ${at}: ${literals[name].length - gone.length}/${literals[name].length} found`);
    for (const literal of gone) console.log(`  missing: ${JSON.stringify(literal)}`);
    missing += gone.length;
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
if (missing > 0) {
  console.log(
    `\n${missing} line or store name verify push reads is gone from the SDK. Update on_device/markers.ts (and docs/verify-contract.md) to the SDK's new wording.`
  );
  process.exit(1);
}
