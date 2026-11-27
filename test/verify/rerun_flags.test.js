const test = require('node:test');
const assert = require('node:assert');

const { pushRerun } = require('../../dist/verify/areas/push/rerun');
const { replayCommand } = require('../../dist/verify/core/replay');

const run = (given) =>
  pushRerun({
    program: 'cio-sdk-tools verify push',
    pathArg: '.',
    level: 'on-device',
    options: { send: false, resend: true, configuration: 'Debug', given },
    flags: {},
    selection: {
      resolution: { workspace: { id: '122175' } },
      targetSelector: 'emulator-5554',
    },
  });

test('a rerun repeats the user the run was told about', () => {
  const command = run({ userId: 'tester@example.com' });
  assert.match(command, /--user tester@example\.com/);
  assert.match(command, /--workspace 122175/);
  assert.doesNotMatch(command, /--token/);
});

test('a rerun reads the push token from the environment and never prints it', () => {
  const command = run({ userId: 'u1', token: 'sekret-token-value-1234' });
  assert.match(command, /--token "\$CIO_PUSH_TOKEN"/);
  assert.doesNotMatch(command, /sekret-token-value/);
});

test('a run given neither flag repeats neither', () => {
  const command = run({});
  assert.doesNotMatch(command, /--user|--token/);
});

test('a flag whose value is a variable is double-quoted so the shell expands it', () => {
  assert.strictEqual(
    replayCommand('tool', ['a', { flag: '--token', variable: 'X_TOKEN' }]),
    'tool a --token "$X_TOKEN"'
  );
});
