const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');

const {
  replayCommand,
  shellQuote,
  wrapCommand,
} = require('../../dist/verify/core/replay');
const { resolveLevel, levelsHelp } = require('../../dist/verify/core/levels');
const { createAsker } = require('../../dist/verify/core/prompt');
const { pushRerun } = require('../../dist/verify/areas/push/rerun');
const { PUSH_LEVELS } = require('../../dist/verify/areas/push/levels');
const { AREAS, verifyCommand } = require('../../dist/verify');

// --- the command that repeats a run ---------------------------------------

test('a value the shell would split or expand is quoted, and nothing else is', () => {
  assert.strictEqual(shellQuote('apn-uikit://settings'), 'apn-uikit://settings');
  assert.strictEqual(shellQuote('00008120-0014694A3E32601E'), '00008120-0014694A3E32601E');
  assert.strictEqual(shellQuote('iPhone 16'), "'iPhone 16'");
  assert.strictEqual(shellQuote("it's"), `'it'\\''s'`);
  assert.strictEqual(shellQuote('a&b'), "'a&b'");
});

test('a wrapped command still pastes as one, and a flag never parts from its value', () => {
  const command = replayCommand('cio-sdk-tools verify push', [
    ['--depth', 'on-device'],
    '--check-opens',
    ['--deep-link', 'apn-uikit://settings'],
    ['--workspace', '122175'],
    ['--device', '00008120-0014694A3E32601E'],
  ]);
  const lines = wrapCommand(command, 60);
  assert.ok(lines.length > 1);
  for (const line of lines.slice(0, -1)) assert.match(line, / \\$/);
  for (const line of lines) assert.ok(line.length <= 62, line);
  const joined = lines.map((line) => line.replace(/ \\$/, '').trim()).join(' ');
  assert.strictEqual(joined, command);
  for (const line of lines) {
    assert.doesNotMatch(line, /--(workspace|device|depth|deep-link) \\$/, 'a flag left its value');
  }
});

const selection = (overrides = {}) => ({
  resolution: {
    how: 'chosen',
    candidates: [],
    workspace: { id: '122175', name: 'Native' },
  },
  appTargetName: 'APN UIKit',
  appTargetSource: 'only one',
  targetSelector: '00008120-0014694A3E32601E',
  targetName: 'iPhone 15',
  targetSource: 'picked',
  states: ['killed', 'background', 'foreground'],
  ...overrides,
});

const settings = (overrides = {}) => ({
  configuration: 'Debug',
  send: true,
  dryRun: false,
  resend: true,
  observe: false,
  opened: true,
  link: 'apn-uikit://settings',
  named: false,
  ...overrides,
});

test('the rerun names every answer the run had to pick, so it asks nothing next time', () => {
  const rerun = pushRerun({
    program: 'cio-sdk-tools verify push',
    pathArg: '.',
    level: 'on-device',
    options: settings(),
    flags: {},
    selection: selection(),
  });
  assert.strictEqual(
    rerun,
    'cio-sdk-tools verify push --depth on-device --check-opens --deep-link apn-uikit://settings --workspace 122175 --device 00008120-0014694A3E32601E'
  );
});

test('the rerun keeps what differs from the defaults and leaves out what does not', () => {
  const rerun = pushRerun({
    program: 'cio-sdk-tools verify push',
    pathArg: './ios',
    level: 'on-device',
    options: settings({ opened: false, link: undefined, resend: false, dryRun: true }),
    flags: { evidenceDir: '/tmp/ev' },
    selection: selection({
      states: ['killed'],
      appTargetSource: 'picked',
    }),
  });
  assert.match(rerun, /^cio-sdk-tools verify push \.\/ios --depth on-device /);
  assert.match(rerun, / --app-states killed /);
  assert.match(rerun, / --dry-run --no-retry /);
  assert.match(rerun, / --ios-target 'APN UIKit'/, 'a picked app target is named');
  assert.match(rerun, / --evidence-dir \/tmp\/ev$/);
  assert.doesNotMatch(rerun, /--check-opens|--deep-link/);

  const registration = pushRerun({
    program: 'cio-sdk-tools verify push',
    pathArg: '.',
    level: 'registration',
    options: settings({ send: false }),
    flags: {},
    selection: selection({ states: undefined }),
  });
  assert.doesNotMatch(registration, /--app-states|--check-opens|--deep-link/);
  assert.match(registration, /--depth registration --workspace 122175 --device /);
});

// --- levels ----------------------------------------------------------------

const scripted = (answer, interactive = true) => {
  const asked = [];
  return {
    asked,
    asker: {
      interactive,
      asked: 0,
      select: async (question, choices) => {
        asked.push({ question, choices });
        return choices.find((choice) => choice.value.id === answer).value;
      },
    },
  };
};

test('a level given by name is taken, an unknown or unavailable one is refused with why', async () => {
  const base = { flag: '--depth', question: 'How far?', fallback: 'registration' };
  const given = await resolveLevel(PUSH_LEVELS, {
    ...base,
    given: 'on-device',
    asker: scripted().asker,
  });
  assert.strictEqual(given.level.id, 'on-device');
  assert.strictEqual(given.asked, false);

  await assert.rejects(
    resolveLevel(PUSH_LEVELS, { ...base, given: 'far', asker: scripted().asker }),
    /unknown level far — --depth takes registration, on-device, end-to-end/
  );
  await assert.rejects(
    resolveLevel(PUSH_LEVELS, { ...base, given: 'end-to-end', asker: scripted().asker }),
    /--depth end-to-end isn't available yet: Customer\.io doesn't record test pushes yet/
  );
});

test('a missing level is asked for, without the ones that cannot run, or falls back when nobody can be asked', async () => {
  const base = { flag: '--depth', question: 'How far?', fallback: 'registration' };
  const { asker, asked } = scripted('on-device');
  const picked = await resolveLevel(PUSH_LEVELS, { ...base, asker });
  assert.strictEqual(picked.level.id, 'on-device');
  assert.strictEqual(picked.asked, true);
  assert.deepStrictEqual(
    asked[0].choices.map((choice) => [choice.label, choice.hint]),
    [
      ['Registration only', 'nothing is sent'],
      ['On the device', 'sends real pushes and checks the app handles them'],
    ]
  );

  const unattended = await resolveLevel(PUSH_LEVELS, {
    ...base,
    asker: scripted(undefined, false).asker,
  });
  assert.strictEqual(unattended.level.id, 'registration', 'an unattended run sent pushes');
  assert.strictEqual(unattended.asked, false);
});

test('the help lists every level from the data, and says which cannot run yet', () => {
  const lines = levelsHelp(PUSH_LEVELS, 60).join('\n');
  for (const level of PUSH_LEVELS) assert.match(lines, new RegExp(`^${level.id} `, 'm'));
  assert.match(lines, /\(not\s+available yet\)/);
});

// --- help --------------------------------------------------------------------

test("every option an area's command has is in its help, and verify's help lists every area", () => {
  for (const area of AREAS) {
    const command = area.command();
    const help = command.helpInformation();
    for (const option of command.options) {
      assert.ok(help.includes(option.flags), `${area.name} help leaves out ${option.flags}`);
    }
  }
  const help = verifyCommand.helpInformation();
  for (const area of AREAS) assert.match(help, new RegExp(`^  ${area.name} `, 'm'));
  for (const option of verifyCommand.options) {
    assert.ok(help.includes(option.flags), `verify help leaves out ${option.flags}`);
  }
  assert.match(help, /Exit codes:/);
});

// --- the free-text question and the count ----------------------------------

test('a free-text answer is trimmed, Enter is no answer, and only real questions are counted', async () => {
  const input = new PassThrough();
  input.write('  apn-uikit://settings \n\n2\n');
  const asker = createAsker({ interactive: true, input, output: { write() {} }, timeoutMs: 1_000 });
  assert.strictEqual(asker.asked, 0);
  assert.strictEqual(await asker.ask('Deep link?'), 'apn-uikit://settings');
  assert.strictEqual(await asker.ask('Deep link?'), undefined);
  assert.strictEqual(await asker.askTap('Tap it'), 'not_shown');
  assert.strictEqual(asker.asked, 2, 'a tap is the check itself, not an answer a flag could give');

  const machine = createAsker({ interactive: false, output: { write() {} } });
  assert.strictEqual(await machine.ask('Deep link?'), undefined);
  assert.strictEqual(machine.asked, 0);
});

// --- the command line, end to end, up to the point it would touch anything ----

const CLI = path.join(__dirname, '../../dist/index.js');

function androidProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cio-verify-options-'));
  fs.writeFileSync(
    path.join(dir, 'build.gradle'),
    "plugins { id 'com.android.application' }\n"
  );
  return dir;
}

function verify(args) {
  const project = androidProject();
  try {
    const result = spawnSync(process.execPath, [CLI, 'verify', 'push', project, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1' },
      timeout: 20_000,
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
}

const envelope = (stderr) => JSON.parse(stderr.split('\n').find((line) => line.startsWith('{')));

test('end-to-end is refused by name until Customer.io records test pushes', () => {
  const { code, stdout, stderr } = verify(['--depth', 'end-to-end', '--json']);
  assert.strictEqual(code, 2);
  assert.strictEqual(stdout, '', '--json after the area still owns stdout');
  assert.match(envelope(stderr).message, /--depth end-to-end isn't available yet/);
});

test('a sending flag beside --depth registration is a contradiction, not a silent send', () => {
  const { code, stderr } = verify(['--depth', 'registration', '--check-opens', '--json']);
  assert.strictEqual(code, 2);
  assert.match(
    envelope(stderr).message,
    /--check-opens only means something when pushes are sent, and --depth registration sends none/
  );
});

test('an unattended send must name the workspace and the device; a sending flag names the depth', () => {
  const { code, stderr } = verify(['--check-opens', '--json']);
  assert.strictEqual(code, 2);
  const error = envelope(stderr);
  assert.match(error.message, /nobody can be asked, .* pass --workspace <id> and --device <id\|name>/);
  assert.deepStrictEqual(error.details.flags, ['--workspace <id>', '--device <id|name>']);
});

test('the shared options work before the area name too', () => {
  const project = androidProject();
  try {
    const result = spawnSync(
      process.execPath,
      [CLI, 'verify', '--json', 'push', project, '--depth', 'end-to-end'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }
    );
    assert.strictEqual(result.status, 2);
    assert.strictEqual(result.stdout, '');
    assert.match(envelope(result.stderr).message, /isn't available yet/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
