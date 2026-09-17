const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createAsker,
  describeMissingInput,
  MissingInput,
} = require('../../dist/verify/prompt');
const cli = require('../../dist/verify/cio/cli');
const { resolveWorkspace } = require('../../dist/verify/cio/workspace');
const { buildVariants } = require('../../dist/verify/android/project');

const sink = () => {
  const written = [];
  return { written, stream: { write: (c) => written.push(String(c)) } };
};

const asker = (lines, out, timeoutMs = 1_000) => {
  const input = new PassThrough();
  for (const line of lines) input.write(`${line}\n`);
  return createAsker({
    interactive: true,
    input,
    output: out.stream,
    timeoutMs,
  });
};

const choices = [
  { value: 'a', label: 'One', hint: '1' },
  { value: 'b', label: 'Two', hint: '2' },
];

test('a number picks, an empty line takes the default', async () => {
  const out = sink();
  assert.strictEqual(
    await asker(['2'], out).select('Which?', choices, { flag: '--x' }),
    'b'
  );
  assert.strictEqual(
    await asker([''], out).select('Which?', choices, { flag: '--x' }),
    'a'
  );
  assert.match(out.written.join(''), /One/);
});

test('an answer out of range is re-asked rather than accepted', async () => {
  const out = sink();
  const picked = await asker(['9', '1'], out).select('Which?', choices, {
    flag: '--x',
  });
  assert.strictEqual(picked, 'a');
  assert.match(out.written.join(''), /not one of 1-2/);
});

test('silence ends the run with the flag to pass, rather than waiting forever', async () => {
  const out = sink();
  const quiet = createAsker({
    interactive: true,
    input: new PassThrough(),
    output: out.stream,
    timeoutMs: 40,
  });
  await assert.rejects(
    () => quiet.select('Which?', choices, { flag: '--target <serial>' }),
    (error) => {
      assert.ok(error instanceof MissingInput);
      assert.match(error.message, /no answer in 0s — pass --target <serial>/);
      return true;
    }
  );
});

test('a non-interactive run never prompts; it names the flag and the candidates', async () => {
  const out = sink();
  const machine = createAsker({ interactive: false, output: out.stream });
  await assert.rejects(
    () =>
      machine.select('Which workspace?', choices, { flag: '--workspace <id>' }),
    (error) => {
      assert.match(error.message, /Which workspace\? — pass --workspace <id>/);
      assert.match(describeMissingInput(error), /1 {2}One/);
      assert.match(describeMissingInput(error), /2 {2}Two/);
      return true;
    }
  );
  assert.strictEqual(out.written.length, 0, 'it wrote to the terminal anyway');
});

// --- workspace resolution -------------------------------------------------
// `cioApi` is read off the module object at call time, so replacing it here is enough.

const withEnvironments = (environments) => {
  cli.cioApi = async () => ({ ok: true, data: { environments } });
};

test('a workspace is picked from the account, and the pick is what gets checked', async () => {
  withEnvironments([
    { id: '122175', name: 'Native' },
    { id: '94996', name: 'Expo' },
  ]);
  const out = sink();
  const resolution = await resolveWorkspace({
    accountId: '1',
    asker: asker(['2'], out),
  });
  assert.strictEqual(resolution.how, 'chosen');
  assert.strictEqual(resolution.workspace.id, '94996');
  assert.strictEqual(resolution.candidates.length, 2);
});

test('one workspace needs no question', async () => {
  withEnvironments([{ id: '122175', name: 'Native' }]);
  const resolution = await resolveWorkspace({
    accountId: '1',
    asker: createAsker({ interactive: false }),
  });
  assert.strictEqual(resolution.how, 'only_environment');
  assert.strictEqual(resolution.workspace.id, '122175');
});

test('a --workspace nobody can read is caught here, not three rungs later as a 404', async () => {
  withEnvironments([{ id: '122175', name: 'Native' }]);
  const resolution = await resolveWorkspace({
    accountId: '1',
    explicit: '999',
    asker: createAsker({ interactive: false }),
  });
  assert.strictEqual(resolution.how, 'unresolved');
  assert.match(resolution.unresolvedReason, /999 is not one this login can read/);
});

test('an explicit workspace keeps the name, so the report reads like a workspace', async () => {
  withEnvironments([{ id: '122175', name: 'Native' }, { id: '94996' }]);
  const resolution = await resolveWorkspace({
    accountId: '1',
    explicit: '122175',
    asker: createAsker({ interactive: false }),
  });
  assert.strictEqual(resolution.how, 'explicit');
  assert.strictEqual(resolution.workspace.name, 'Native');
});

// --- Android variants ----------------------------------------------------

test('application ids come from what the build produced, suffixes included', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cio-variants-'));
  const write = async (variant, applicationId) => {
    const dir = path.join(root, 'build', 'outputs', 'apk', variant);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'output-metadata.json'),
      JSON.stringify({ applicationId, variantName: variant })
    );
  };
  await write('release', 'io.example.app');
  await write('debug', 'io.example.app.debug');

  const variants = await buildVariants(root);
  assert.deepStrictEqual(
    variants.map((v) => `${v.variantName}=${v.applicationId}`).sort(),
    ['debug=io.example.app.debug', 'release=io.example.app']
  );
  assert.ok(variants.every((v) => v.source === 'output-metadata'));

  // A module nobody has built offers nothing, which is the honest answer: nothing is
  // installed either.
  assert.deepStrictEqual(await buildVariants(path.join(root, 'nope')), []);
});

test('a closed stdin answers immediately instead of looking like a hang', async () => {
  const out = sink();
  const input = new PassThrough();
  const closing = createAsker({
    interactive: true,
    input,
    output: out.stream,
    timeoutMs: 30_000,
  });
  const pending = closing.select('Which?', choices, { flag: '--target <x>' });
  input.end();
  await assert.rejects(pending, (error) => {
    assert.match(error.message, /nothing on stdin — pass --target <x>/);
    return true;
  });
});

// --- the failure-path sweep ----------------------------------------------

const { findIdentityElsewhere } = require('../../dist/verify/cio/push');
const { describeHits } = require('../../dist/verify/rungs/profile_linked');

test('the sweep says which workspace actually holds the device', async () => {
  const swept = [];
  cli.cioApi = async (_path, params) => {
    swept.push(params.environment_id);
    // Only 122175 knows this person, and it holds the exact token.
    if (params.environment_id !== '122175') return { ok: true, data: {} };
    return {
      ok: true,
      data: {
        customers: [
          { id: 'cio_1', devices: [{ id: 'TOKEN', attributes: {} }] },
        ],
      },
    };
  };

  const hits = await findIdentityElsewhere({
    identifier: 'cli@mo.io',
    token: 'TOKEN',
    candidates: [
      { id: '94996', name: 'Expo' },
      { id: '122175', name: 'Native' },
      { id: '68200', name: 'Testing' },
    ],
    skip: '94996',
  });

  assert.ok(!swept.includes('94996'), 'it re-checked the chosen workspace');
  assert.deepStrictEqual(
    hits.map((hit) => `${hit.workspace.id}:${hit.hasToken}`),
    ['122175:true']
  );
  assert.deepStrictEqual(describeHits(hits), [
    'this device is in Native (122175)',
  ]);
});

test('an identity found without the token is reported as the weaker finding', () => {
  const hits = [
    { workspace: { id: '68200', name: 'Testing' }, cioId: 'c', hasToken: false, devices: 2 },
  ];
  assert.deepStrictEqual(describeHits(hits), [
    'this identity is in Testing (68200) · 2 devices',
  ]);
});

test('a workspace holding the device outranks one holding only the name', async () => {
  cli.cioApi = async (_path, params) => ({
    ok: true,
    data: {
      customers: [
        {
          id: 'c',
          devices:
            params.environment_id === '122175'
              ? [{ id: 'TOKEN', attributes: {} }]
              : [],
        },
      ],
    },
  });
  const hits = await findIdentityElsewhere({
    identifier: 'cli@mo.io',
    token: 'TOKEN',
    candidates: [
      { id: '68200', name: 'Testing' },
      { id: '122175', name: 'Native' },
    ],
  });
  assert.strictEqual(hits[0].workspace.id, '122175');
});
