const test = require('node:test');
const assert = require('node:assert');

const { androidCell } = require('../../dist/verify/areas/push/on_device/android');
const { markLateArrivals } = require('../../dist/verify/areas/push/on_device/send');

const silentSdk = (posted) => ({
  available: true,
  sawLines: false,
  stopped: false,
  posted,
  received: false,
  loggedIds: [],
  freshIds: [],
});
const base = { state: 'killed', title: 'T', evidence: [] };
const stillThere = async () => true;

test('a push the OS listed during its cell was on time, so a silent SDK is not reported as slow delivery', async () => {
  const cell = androidCell(base, silentSdk(true));
  assert.strictEqual(cell.cause, 'runtime.no_evidence');
  const [out] = await markLateArrivals([cell], stillThere);
  assert.strictEqual(out.cause, 'runtime.no_evidence');
});

test('a push that was not listed during its cell but is there at the end was late', async () => {
  const cell = androidCell(base, silentSdk(false));
  const [out] = await markLateArrivals([cell], stillThere);
  assert.strictEqual(out.cause, 'runtime.push_arrived_late');
});
