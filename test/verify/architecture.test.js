const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { AREAS } = require('../../dist/verify');

/**
 * The shape that lets `verify` grow: areas sit on a core and on shared platform code, and
 * nothing points back up. If core or platform code learns an area's name, the next area has
 * to edit it, and areas stop being something you add.
 */
const SRC = path.join(__dirname, '../../src/verify');

function sources(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? sources(path.join(dir, entry.name))
        : entry.name.endsWith('.ts')
        ? [path.join(dir, entry.name)]
        : []
    );
}

/** Every relative import in a file, resolved to a path under src/verify. */
function importsOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/from '(\.[^']*)'|import '(\.[^']*)'/g)].map(
    (match) =>
      path.relative(SRC, path.resolve(path.dirname(file), match[1] ?? match[2]))
  );
}

const layer = (relative) => relative.split(path.sep)[0];
const areaOf = (relative) =>
  layer(relative) === 'areas' ? relative.split(path.sep)[1] : undefined;

test('core and platform code never import an area', () => {
  const offenders = [];
  for (const dir of ['core', 'platform']) {
    for (const file of sources(path.join(SRC, dir))) {
      for (const target of importsOf(file)) {
        if (layer(target) === 'areas') {
          offenders.push(`${path.relative(SRC, file)} → ${target}`);
        }
      }
    }
  }
  assert.deepStrictEqual(offenders, []);
});

test('core code never imports platform code', () => {
  const offenders = sources(path.join(SRC, 'core')).flatMap((file) =>
    importsOf(file)
      .filter((target) => layer(target) === 'platform')
      .map((target) => `${path.relative(SRC, file)} → ${target}`)
  );
  assert.deepStrictEqual(offenders, []);
});

test('no area imports another area', () => {
  const offenders = [];
  for (const file of sources(path.join(SRC, 'areas'))) {
    const own = areaOf(path.relative(SRC, file));
    for (const target of importsOf(file)) {
      const other = areaOf(target);
      if (other && other !== own) {
        offenders.push(`${path.relative(SRC, file)} → ${target}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, []);
});

test('every area is a verify command under its own name', () => {
  const { verifyCommand } = require('../../dist/verify');
  const names = verifyCommand.commands.map((command) => command.name());
  for (const area of AREAS) {
    assert.ok(names.includes(area.name), `verify has no ${area.name} command`);
    assert.strictEqual(area.command().name(), area.name);
  }
});

test('every cause code an area emits is in its own catalog', () => {
  for (const area of AREAS) {
    const prefixes = [
      ...new Set(Object.keys(area.causes).map((code) => code.split('.')[0])),
    ];
    const pattern = new RegExp(`'((?:${prefixes.join('|')})\\.[a-z_]+)'`, 'g');
    const missing = [];
    for (const file of sources(path.join(SRC, 'areas', area.name))) {
      if (file.endsWith('causes.ts')) continue;
      for (const match of fs.readFileSync(file, 'utf8').matchAll(pattern)) {
        if (!area.causes[match[1]]) {
          missing.push(`${path.relative(SRC, file)}: ${match[1]}`);
        }
      }
    }
    assert.deepStrictEqual(missing, [], `${area.name} emits unregistered causes`);
  }
});

test('no two areas claim the same cause code', () => {
  const owner = new Map();
  for (const area of AREAS) {
    for (const code of Object.keys(area.causes)) {
      assert.ok(
        !owner.has(code) || owner.get(code) === area.name,
        `${code} is in both ${owner.get(code)} and ${area.name}`
      );
      owner.set(code, area.name);
    }
  }
});

test('the registry refuses a code another area already owns', () => {
  const { registerCauses } = require('../../dist/verify/core/report/causes');
  const [area] = AREAS;
  const [code] = Object.keys(area.causes);
  assert.throws(
    () => registerCauses('not-' + area.name, { [code]: area.causes[code] }),
    /registered by both/
  );
  // The same area registering its own catalog again is harmless.
  registerCauses(area.name, area.causes);
});

test('every step a level names is one its area has, and level ids are unique', () => {
  for (const area of AREAS) {
    if (!area.levels) continue;
    const steps = new Set(area.steps.map((step) => step.id));
    const ids = area.levels.map((level) => level.id);
    assert.strictEqual(new Set(ids).size, ids.length, `${area.name} repeats a level`);
    for (const level of area.levels) {
      assert.ok(level.steps.length > 0, `${area.name} ${level.id} runs nothing`);
      for (const step of level.steps) {
        assert.ok(steps.has(step), `${area.name} ${level.id} names unknown step ${step}`);
      }
    }
  }
});

test("push's levels build on each other, as push chose", () => {
  const push = AREAS.find((area) => area.name === 'push');
  const [registration, onDevice, endToEnd] = push.levels;
  assert.deepStrictEqual(
    push.levels.map((level) => level.id),
    ['registration', 'on-device', 'end-to-end']
  );
  for (const step of registration.steps) assert.ok(onDevice.steps.includes(step));
  for (const step of onDevice.steps) assert.ok(endToEnd.steps.includes(step));
  assert.ok(endToEnd.unavailable, 'end-to-end runs before Customer.io records test pushes');
});
