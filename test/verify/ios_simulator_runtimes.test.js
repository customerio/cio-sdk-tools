const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * `xcrun simctl list` is played by a script on PATH, so the test runs anywhere and holds
 * simulators from several runtimes.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-xcrun-'));
const listing = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
      { name: 'iPhone 16', udid: 'IOS-1', state: 'Booted', isAvailable: true },
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
      { name: 'Apple Watch', udid: 'WATCH-1', state: 'Booted', isAvailable: true },
    ],
    'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [
      { name: 'Apple TV', udid: 'TV-1', state: 'Booted', isAvailable: true },
    ],
    'com.apple.CoreSimulator.SimRuntime.xrOS-2-0': [
      { name: 'Apple Vision Pro', udid: 'XR-1', state: 'Booted', isAvailable: true },
    ],
  },
});
// devicectl lists a paired Watch simulator too, the way it lists hardware.
const paired = JSON.stringify({
  result: {
    devices: [
      {
        deviceProperties: { name: 'Apple Watch' },
        hardwareProperties: { udid: 'WATCH-1' },
        connectionProperties: {},
      },
    ],
  },
});
fs.writeFileSync(
  path.join(dir, 'xcrun'),
  `#!/bin/sh
case "$1" in
  simctl) printf '%s' '${listing}'; exit 0 ;;
  devicectl)
    while [ $# -gt 0 ]; do
      if [ "$1" = --json-output ]; then shift; printf '%s' '${paired}' > "$1"; exit 0; fi
      shift
    done ;;
esac
exit 1
`,
  { mode: 0o755 }
);
process.env.PATH = `${dir}:${process.env.PATH}`;

const { listTargets } = require('../../dist/verify/platform/ios/device');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('only iOS simulators are offered: a booted Watch, TV or Vision Pro cannot run the app', async () => {
  const targets = (await listTargets()).filter((t) => t.kind === 'simulator');
  assert.deepStrictEqual(
    targets.map((t) => t.udid),
    ['IOS-1']
  );
});

test('a non-iOS simulator that devicectl also lists is not offered as a device either', async () => {
  const udids = (await listTargets()).map((t) => t.udid);
  assert.ok(!udids.includes('WATCH-1'), `offered: ${udids.join(', ')}`);
});
