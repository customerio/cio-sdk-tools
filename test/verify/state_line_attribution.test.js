const test = require('node:test');
const assert = require('node:assert');

const {
  readAfter,
  readIosStateLine,
} = require('../../dist/verify/areas/push/state_line');
const { whyNoSend } = require('../../dist/verify/areas/push/on_device/send');
const { parseLogcat } = require('../../dist/verify/platform/android/logcat');

/**
 * Every app's SDK writes the same `sdk.state` line into one shared log, so a line is the
 * selected app's only when the process that wrote it is.
 */
const state = (pid, user, token) => ({
  at: '10:00:00',
  process: 'CIO-SDK',
  pid,
  message: `[Init] SDK state || ev=sdk.state version=4.9.0 user=${user} token=${token} key=1a2b3c4d`,
});
const capture = (lines) => ({
  available: true,
  lines,
  mark: () => 0,
  since: () => lines,
  stop: async () => undefined,
});
const only = (pid) => async () => (line) => line.pid === pid;

test('logcat lines keep the pid of the process that wrote them', () => {
  const line = parseLogcat('11-24 10:00:01.000 I/CIO-SDK( 1234): hello');
  assert.strictEqual(line.pid, '1234');
  assert.strictEqual(line.message, 'hello');
});

test('a state line from another app in the log is not taken for the selected app', async () => {
  const lines = [state('100', 'mine', 'tok-mine'), state('200', 'other', 'tok-other')];
  const read = await readAfter(capture(lines), async () => undefined, only('100'), 1_000);
  assert.strictEqual(read.userId, 'mine');
  assert.strictEqual(read.token, 'tok-mine');
});

test('with only another app\'s line in the log, nothing is read', async () => {
  const lines = [state('200', 'other', 'tok-other')];
  const read = await readAfter(capture(lines), async () => undefined, only('100'), 600);
  assert.strictEqual(read, undefined);
});

test('an iOS app with no executable name cannot be told apart in the log, so nothing is read', async () => {
  assert.strictEqual(
    await readIosStateLine({ kind: 'simulator', udid: 'U' }, 'com.example.app'),
    undefined
  );
});

test('a send without a device-read token says to pass --token when the profile held one', () => {
  const message = whyNoSend({
    target: 'T',
    app: 'a',
    workspaceId: '1',
    token: undefined,
    tokenFromProfile: true,
  });
  assert.match(message, /another phone.*--token/);
  assert.match(
    whyNoSend({ target: 'T', app: 'a', workspaceId: '1' }),
    /no push token registered on the target/
  );
});
