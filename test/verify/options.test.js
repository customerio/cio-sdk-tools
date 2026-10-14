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

// A level an area has not built yet, to prove the core refuses it and leaves it out.
const LATER = {
  id: 'later',
  label: 'Later',
  title: 'a level that cannot run yet',
  steps: ['project_wiring'],
  unavailable: 'it is not built',
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
  const endToEnd = await resolveLevel(PUSH_LEVELS, {
    ...base,
    given: 'end-to-end',
    asker: scripted().asker,
  });
  assert.strictEqual(endToEnd.level.id, 'end-to-end');
  await assert.rejects(
    resolveLevel([...PUSH_LEVELS, LATER], { ...base, given: 'later', asker: scripted().asker }),
    /--depth later isn't available yet: it is not built/
  );
});

test('a missing level is asked for, without the ones that cannot run, or falls back when nobody can be asked', async () => {
  const base = { flag: '--depth', question: 'How far?', fallback: 'registration' };
  const { asker, asked } = scripted('on-device');
  const picked = await resolveLevel([...PUSH_LEVELS, LATER], { ...base, asker });
  assert.strictEqual(picked.level.id, 'on-device');
  assert.strictEqual(picked.asked, true);
  assert.deepStrictEqual(
    asked[0].choices.map((choice) => [choice.label, choice.hint]),
    [
      ['Registration only', 'nothing is sent'],
      ['On the device', 'sends real pushes and checks the app handles them'],
      ['End to end', 'also checks Customer.io recorded them'],
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
  const lines = levelsHelp([...PUSH_LEVELS, LATER], 60).join('\n');
  for (const level of PUSH_LEVELS) assert.match(lines, new RegExp(`^${level.id} `, 'm'));
  assert.match(lines, /^later\s+a level that cannot run yet \(not\s+available\s+yet\)/m);
  assert.strictEqual(lines.match(/not\s+available\s+yet/g).length, 1, 'only the level that cannot run says so');
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

test('end-to-end sends like on-device: unattended, it must name the workspace and the device', () => {
  const { code, stdout, stderr } = verify(['--depth', 'end-to-end', '--json']);
  assert.strictEqual(code, 2);
  assert.strictEqual(stdout, '', '--json after the area still owns stdout');
  assert.deepStrictEqual(envelope(stderr).details.flags, ['--workspace <id>', '--device <id|name>']);
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
    assert.match(envelope(result.stderr).message, /pass --workspace <id> and --device/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

// --- the go-ahead on a terminal ----------------------------------------------

const fakeTerminal = () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode) => {
    input.isRaw = mode;
  };
  const written = [];
  const output = { isTTY: true, write: (chunk) => written.push(String(chunk)) };
  return { input, output, text: () => written.join('') };
};

const press = (input, ...keys) => {
  let delay = 10;
  for (const key of keys) {
    setTimeout(() => input.write(key), delay);
    delay += 10;
  }
};

const answers = { yes: 'Yes, send 3 pushes', no: 'No, send nothing' };

test('on a terminal the go-ahead is two rows, and Enter alone is no', async () => {
  const terminal = fakeTerminal();
  const asker = createAsker({ interactive: true, input: terminal.input, output: terminal.output, timeoutMs: 2_000 });
  press(terminal.input, '\r');
  assert.strictEqual(await asker.agree('Send 3 real pushes?', 'context\n', answers), false);
  assert.match(terminal.text(), /Send 3 real pushes\?/);
  assert.match(terminal.text(), /Yes, send 3 pushes/);
  // Answered, the question and its answer collapse to one line, marked as not sent.
  assert.match(terminal.text(), /– Send 3 real pushes\? · No, send nothing/);
  assert.doesNotMatch(terminal.text(), /\(y\/N\)/, 'the typed form showed on a terminal');
  assert.strictEqual(terminal.input.isRaw, false, 'raw mode was left on');
});

test('the arrow up to yes and Enter is the only way to send', async () => {
  const terminal = fakeTerminal();
  const asker = createAsker({ interactive: true, input: terminal.input, output: terminal.output, timeoutMs: 2_000 });
  press(terminal.input, '\u001b[A', '\r');
  assert.strictEqual(await asker.agree('Send 3 real pushes?', undefined, answers), true);
  assert.match(terminal.text(), /✔ Send 3 real pushes\? · Yes, send 3 pushes/);

  const silent = fakeTerminal();
  const waiting = createAsker({ interactive: true, input: silent.input, output: silent.output, timeoutMs: 50 });
  assert.strictEqual(await waiting.agree('Send?', undefined, answers), false, 'silence sent');
});

// --- what a partly proven run says ------------------------------------------------

const { unprovenLine } = require('../../dist/verify/core/report/render');
const { PUSH_VOICE } = require('../../dist/verify/areas/push/voice');
const { unprovenStates } = require('../../dist/verify/areas/push/rerun');

const cell = (state, verdict, cause) => ({ state, verdict, cause, evidence: [] });
const iphone = [
  {
    kind: 'cells',
    metric: 'delivered',
    cells: [cell('killed', 'pass'), cell('background', 'pass'), cell('foreground', 'pass')],
  },
  {
    kind: 'cells',
    metric: 'opened',
    cells: [cell('killed', 'skip', 'runtime.tap_lines_lost'), cell('background', 'pass')],
  },
];

test('a run with one cell it could not read says how much was proven and names that cell', () => {
  assert.strictEqual(
    unprovenLine(iphone, PUSH_VOICE),
    '4 of 5 proven; not proven: killed opened (runtime.tap_lines_lost). Skipped is not passed.'
  );
  assert.strictEqual(
    unprovenLine(
      [iphone[0], { kind: 'cells', metric: 'opened', cells: [], skipped: 'a dry run sends nothing' }],
      PUSH_VOICE
    ),
    '3 of 3 proven; opened did not run. Skipped is not passed.'
  );
  assert.strictEqual(
    unprovenLine([{ kind: 'cells', metric: 'delivered', cells: [], skipped: 'nothing confirmed' }], PUSH_VOICE),
    'nothing was proven. Skipped is not passed.'
  );
});

test('only the states with an inconclusive cell are run again, and a dry run has none', () => {
  assert.deepStrictEqual(unprovenStates(iphone), ['killed']);
  assert.deepStrictEqual(
    unprovenStates([{ metric: 'delivered', cells: [cell('killed', 'skip'), cell('background', 'skip')] }]),
    [],
    'a dry run\'s cells name no cause'
  );
  const retry = pushRerun({
    program: 'cio-sdk-tools verify push',
    pathArg: '.',
    level: 'on-device',
    options: settings({ opened: false }),
    flags: {},
    selection: selection({ states: ['foreground'] }),
  });
  assert.doesNotMatch(retry, /--deep-link|--check-opens/, 'a deep link without taps');
  assert.match(retry, /--app-states foreground/);
});
