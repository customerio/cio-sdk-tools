const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  armLaunchHold,
  parseHoldEvent,
} = require('../../dist/verify/platform/ios/launch_hold');

const phone = { kind: 'device', udid: '00008120-TEST', name: 'iPhone' };

/**
 * The debugger side, played by a script: it answers the way the Python helper does, one JSON
 * object a line, and records what the tool writes to it.
 */
function fakeDebugger(script) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.written = '';
  child.stdin = new PassThrough();
  child.stdin.on('data', (chunk) => {
    child.written += chunk.toString();
    if (child.written.includes('release\n')) script.onRelease?.(child);
  });
  child.kill = () => {
    child.killed = true;
    exit(child, null);
  };
  child.say = (event) => child.stdout.write(`${JSON.stringify(event)}\n`);
  setImmediate(() => script.onStart(child));
  return child;
}

function exit(child, code) {
  if (child.exitCode !== null) return;
  child.exitCode = code ?? 0;
  child.emit('exit', code);
}

const deps = (script) => ({
  pythonPath: async () => '/fake/lldb/python',
  spawnHelper: (args, env) => {
    script.args = args;
    script.env = env;
    return (script.child = fakeDebugger(script));
  },
});

test('the hold events parse, and anything else is ignored', () => {
  assert.deepStrictEqual(parseHoldEvent('{"event":"held","pid":1220}'), {
    event: 'held',
    pid: 1220,
  });
  assert.strictEqual(parseHoldEvent('Traceback (most recent call last):'), undefined);
  assert.strictEqual(parseHoldEvent('{"pid":1}'), undefined);
});

test('a launch is held, followed, and let go when the tool says so', async () => {
  const script = {
    onStart: (child) => child.say({ event: 'armed' }),
    onRelease: (child) => {
      child.say({ event: 'released', held: true, timedOut: false, error: null });
      exit(child, 0);
    },
  };
  const armed = await armLaunchHold(phone, 'APN UIKit', deps(script));
  assert.ok(armed.hold, armed.unavailableReason);
  assert.deepStrictEqual(script.args.slice(0, 2), ['00008120-TEST', 'APN UIKit']);
  assert.strictEqual(script.env.PYTHONPATH, '/fake/lldb/python');
  assert.strictEqual(armed.hold.state(), 'waiting');

  script.child.say({ event: 'held', pid: 1220, frame: '__mmap', module: 'dyld' });
  assert.deepStrictEqual(await armed.hold.held, {
    pid: 1220,
    stoppedIn: '__mmap in dyld',
  });
  assert.strictEqual(armed.hold.state(), 'held');

  const released = await armed.hold.release();
  assert.strictEqual(script.child.written, 'release\n');
  assert.deepStrictEqual(released, { timedOut: undefined, error: undefined });
  assert.strictEqual(armed.hold.state(), 'done');
  // Asked again, it answers again without writing again.
  await armed.hold.release();
  assert.strictEqual(script.child.written, 'release\n');
});

test('no launch before the release means nothing was held', async () => {
  const script = {
    onStart: (child) => child.say({ event: 'armed' }),
    onRelease: (child) => {
      child.say({ event: 'released', held: false });
      exit(child, 0);
    },
  };
  const armed = await armLaunchHold(phone, 'APN UIKit', deps(script));
  await armed.hold.release();
  assert.strictEqual(await armed.hold.held, undefined);
});

test('a debugger that cannot wait is a reason, never a hold', async () => {
  const refused = {
    onStart: (child) => {
      child.say({ event: 'error', message: 'attach failed' });
      exit(child, 1);
    },
  };
  const armed = await armLaunchHold(phone, 'APN UIKit', deps(refused));
  assert.strictEqual(armed.hold, undefined);
  assert.match(armed.unavailableReason, /could not wait for the app: attach failed/);

  const crashed = {
    onStart: (child) => {
      child.stderr.write("ModuleNotFoundError: No module named 'lldb'\n");
      setImmediate(() => exit(child, 1));
    },
  };
  const gone = await armLaunchHold(phone, 'APN UIKit', deps(crashed));
  assert.match(gone.unavailableReason, /No module named 'lldb'/);
});

test('a debugger with no Python module, or a simulator, is never armed', async () => {
  const none = await armLaunchHold(phone, 'APN UIKit', {
    pythonPath: async () => undefined,
    spawnHelper: () => assert.fail('nothing should start'),
  });
  assert.match(none.unavailableReason, /xcrun lldb -P/);

  const simulator = await armLaunchHold(
    { kind: 'simulator', udid: 'SIM', name: 'iPhone 16' },
    'APN UIKit',
    { spawnHelper: () => assert.fail('nothing should start') }
  );
  assert.match(simulator.unavailableReason, /simulator/);
});

test('a debugger that dies while holding still settles the hold', async () => {
  const script = { onStart: (child) => child.say({ event: 'armed' }) };
  const armed = await armLaunchHold(phone, 'APN UIKit', deps(script));
  exit(script.child, null);
  assert.strictEqual(await armed.hold.held, undefined);
  assert.strictEqual(await armed.hold.release(), undefined);
  assert.strictEqual(armed.hold.state(), 'done');
});
