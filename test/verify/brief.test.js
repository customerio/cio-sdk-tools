const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { briefReport } = require('../../dist/verify/core/report/brief');
const { PUSH_VOICE } = require('../../dist/verify/areas/push/voice');
const { detectFramework } = require('../../dist/verify/platform/framework');

const full = () => ({
  schema: 1,
  provenance: 'observed',
  tool: { name: 'cio-sdk-tools', version: '1.9.0' },
  command: 'verify push',
  area: 'push',
  level: 'on-device',
  startedAt: '2026-10-16T00:00:00.000Z',
  finishedAt: '2026-10-16T00:00:30.000Z',
  project: { path: '/app/ios/App.xcodeproj', platform: 'ios', framework: 'react-native', name: 'App' },
  sections: [
    {
      kind: 'checks',
      id: 'device_ready',
      title: 'Device ready',
      durationMs: 4100,
      checks: [
        { id: 'installed', verdict: 'pass', label: 'App is installed', evidence: ['io.example'] },
        {
          id: 'token_freshness',
          verdict: 'warn',
          label: 'Stored token belongs to the installed build',
          cause: 'device.token_predates_install',
          evidence: ['build installed 2026-10-15T23:00:00.000Z'],
        },
      ],
    },
    {
      kind: 'cells',
      metric: 'delivered',
      sdkQuiet: false,
      logs: { how: 'idevicesyslog', evidencePath: '/tmp/cio-verify-x/device.log' },
      cells: [
        {
          state: 'killed',
          verdict: 'fail',
          cause: 'send.provider_rejected',
          detail: 'send rejected: BadDeviceToken',
          evidence: ['log: 1723 lines, extension ran: false'],
          deliveryId: 'dgS_ugcABQ',
          title: 'cio verify QBMXS · killed',
          durationMs: 66000,
          recorded: 'not_checked',
        },
      ],
    },
  ],
  rerun: 'cio-sdk-tools verify push . --depth on-device',
  rerunUnproven: 'cio-sdk-tools verify push . --depth on-device --app-states killed',
  advice: ['this build was installed 3 days ago'],
  consent: { granted: true, by: 'named', writes: ['1 real push to App on iPhone through 122175'] },
  verdict: 'fail',
  causes: [
    {
      code: 'send.provider_rejected',
      stage: 'delivered_matrix',
      severity: 'blocker',
      summary: 'Customer.io refused the send.',
      remedy: 'Check the token.',
      evidence: ['send rejected: BadDeviceToken (delivery dgS_ugcABQ)'],
    },
  ],
  exitCode: 20,
});

test('the default report keeps verdicts, causes and fixes, and drops the evidence behind them', () => {
  const brief = briefReport(full(), PUSH_VOICE.reportKeys);
  const text = JSON.stringify(brief);

  for (const gone of ['1723 lines', '/tmp/cio-verify-x', 'idevicesyslog', 'dgS_ugcABQ', 'QBMXS', '2026-10-16T00', '/app/ios', 'observed']) {
    assert.ok(!text.includes(gone), `${gone} is evidence, not for the default report`);
  }
  assert.strictEqual(brief.verdict, 'fail');
  assert.strictEqual(brief.exitCode, 20);
  assert.deepStrictEqual(brief.project, { platform: 'ios', framework: 'react-native', name: 'App' });
  assert.deepStrictEqual(brief.sections[0], {
    kind: 'checks',
    id: 'device_ready',
    title: 'Device ready',
    verdict: 'warn',
    checks: [
      {
        id: 'token_freshness',
        verdict: 'warn',
        label: 'Stored token belongs to the installed build',
        cause: 'device.token_predates_install',
      },
    ],
  });
  assert.deepStrictEqual(brief.sections[1], {
    kind: 'cells',
    metric: 'delivered',
    verdict: 'fail',
    cells: [
      { state: 'killed', verdict: 'fail', cause: 'send.provider_rejected', detail: 'send rejected: BadDeviceToken' },
    ],
  });
  assert.deepStrictEqual(brief.causes, [
    {
      code: 'send.provider_rejected',
      stage: 'delivered_matrix',
      severity: 'blocker',
      summary: 'Customer.io refused the send.',
      remedy: 'Check the token.',
    },
  ]);
  assert.deepStrictEqual(brief.advice, ['this build was installed 3 days ago']);
  assert.strictEqual(brief.consent.by, 'named');
  assert.strictEqual(brief.rerunUnproven, 'cio-sdk-tools verify push . --depth on-device --app-states killed');
  assert.strictEqual(brief.rerun, undefined);
});

test('the default report of a failing run is a fraction of the full one', () => {
  const report = full();
  const brief = briefReport(report, PUSH_VOICE.reportKeys);
  assert.ok(JSON.stringify(brief).length < JSON.stringify(report).length * 0.75);
});

test('the framework is read from the folders around the native project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cio-framework-'));
  try {
    const app = (name, files) => {
      const dir = path.join(root, name);
      fs.mkdirSync(path.join(dir, 'ios', 'App.xcodeproj'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'android', 'app'), { recursive: true });
      for (const [file, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, file), content);
      }
      return dir;
    };
    const rn = app('rn', { 'package.json': JSON.stringify({ dependencies: { 'react-native': '0.76.0' } }) });
    const expo = app('expo', {
      'package.json': JSON.stringify({ dependencies: { expo: '52.0.0', 'react-native': '0.76.0' } }),
    });
    const flutter = app('flutter', { 'pubspec.yaml': 'name: app\n' });
    const native = app('native', {});

    assert.strictEqual(await detectFramework(path.join(rn, 'ios', 'App.xcodeproj')), 'react-native');
    assert.strictEqual(await detectFramework(path.join(rn, 'android', 'app')), 'react-native');
    assert.strictEqual(await detectFramework(path.join(expo, 'ios', 'App.xcodeproj')), 'expo');
    assert.strictEqual(await detectFramework(path.join(flutter, 'android', 'app')), 'flutter');
    assert.strictEqual(await detectFramework(path.join(native, 'ios', 'App.xcodeproj')), 'native');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
