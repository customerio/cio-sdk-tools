const test = require('node:test');
const assert = require('node:assert');

const { sendResultOf } = require('../../dist/verify/areas/push/on_device/send');
const {
  awaitRecord,
  parseDelivery,
  readDelivery,
} = require('../../dist/verify/areas/push/record/read');
const { readBack } = require('../../dist/verify/areas/push/record');
const { Ladder } = require('../../dist/verify/core/report/ladder');
const { CAUSES } = require('../../dist/verify/areas/push/causes');

/**
 * Customer.io's record of a test push, against the contract the backend hands over: the send
 * returns `delivery_id` once test pushes are kept, and `GET /deliveries/{id}` reads it back.
 * Until then there is no id, which is the normal case and must read as "not checked".
 */

const ID = 'dgS_ugcNBQAAAaE52sEAXhwKfTOyn06Bxg==';

// The read route's shape (services #29645, GET /test_deliveries/{delivery_id}): a test push,
// accepted by APNs, then reported delivered and opened by the device's SDK.
const OPENED = {
  test_delivery: {
    id: ID,
    token: '806f516ee6e5…',
    platform: 'ios',
    state: 'opened',
    sent: 1791972000,
    failed: null,
    delivered: 1791972003,
    opened: 1791972041,
    provider_status: 200,
    failure_message: null,
    failure_detail: null,
  },
};

const record = (fields) => ({ ok: true, record: parseDelivery(ID, fields) });
const QUICK = { deliveredMs: 60, openedMs: 80, pollMs: 5 };

// --- the send ------------------------------------------------------------------

test('the send keeps the delivery id when there is one, and has none when the feature is off', () => {
  assert.deepStrictEqual(
    sendResultOf({
      ok: true,
      data: { status: '200 OK', errors: null, delivery_id: ID },
    }),
    { accepted: true, deliveryId: ID }
  );
  assert.deepStrictEqual(
    sendResultOf({ ok: true, data: { status: '200 OK', errors: null } }),
    {
      accepted: true,
      deliveryId: undefined,
    }
  );
});

test("a refused send keeps the id from the error's meta, so its failure can be read back", () => {
  const refused = sendResultOf({
    ok: false,
    error: 'API error 400: BadDeviceToken',
    errorBody: {
      errors: [
        {
          detail: 'BadDeviceToken',
          status: 400,
          meta: { full_error_message: '…', delivery_id: ID },
        },
      ],
    },
  });
  assert.strictEqual(refused.accepted, false);
  assert.strictEqual(refused.deliveryId, ID);
  assert.strictEqual(refused.error, 'API error 400: BadDeviceToken');

  // Errors in a 200 body are read for their detail, not printed as [object Object].
  const inBody = sendResultOf({
    ok: true,
    data: { errors: [{ detail: 'BadDeviceToken', meta: { delivery_id: ID } }] },
  });
  assert.strictEqual(inBody.error, 'BadDeviceToken');
  assert.strictEqual(inBody.deliveryId, ID);
});

// --- reading one delivery --------------------------------------------------------

test("a test delivery reads back with its times and the provider's answer", async () => {
  const read = await readDelivery('122175', ID, async (path, params) => {
    assert.strictEqual(
      path,
      '/v1/environments/{environment_id}/test_deliveries/{delivery_id}'
    );
    assert.deepStrictEqual(params, {
      environment_id: '122175',
      delivery_id: ID,
    });
    return { ok: true, data: OPENED };
  });
  assert.strictEqual(read.ok, true);
  assert.deepStrictEqual(read.record, {
    id: ID,
    sent: 1791972000,
    delivered: 1791972003,
    opened: 1791972041,
    failed: undefined,
    providerStatus: 200,
    failureMessage: undefined,
    failureDetail: undefined,
  });
  // Nothing reported yet is null, and reads as not happened.
  const fresh = parseDelivery(ID, {
    ...OPENED.test_delivery,
    delivered: null,
    opened: null,
  });
  assert.strictEqual(fresh.delivered, undefined);
  assert.strictEqual(fresh.opened, undefined);
});

test('a 404 is told apart from other errors', async () => {
  const missing = await readDelivery('122175', ID, async () => ({
    ok: false,
    error: 'API error 404: Not Found',
  }));
  assert.deepStrictEqual(missing, {
    ok: false,
    notFound: true,
    permanent: false,
    error: 'API error 404: Not Found',
  });
  const denied = await readDelivery('122175', ID, async () => ({
    ok: false,
    error: 'API error 403',
  }));
  assert.strictEqual(denied.notFound, false);
});

// --- waiting for the device's reports -------------------------------------------

test('a record that already holds what is waited for answers on the first read', async () => {
  let reads = 0;
  const answer = await awaitRecord(
    '122175',
    [ID],
    { delivered: true, opened: true },
    {
      read: async () => (reads++, record(OPENED.test_delivery)),
      limits: QUICK,
    }
  );
  assert.strictEqual(reads, 1);
  assert.strictEqual(answer.record.opened, 1791972041);
});

test('an opened record that gains its delivered later is read again until it has both', async () => {
  // Customer.io may record the open before the delivery (a failed upload retries later): the
  // later read has the same rank as the earlier one, and still has to win.
  let reads = 0;
  const answer = await awaitRecord(
    '122175',
    [ID],
    { delivered: true, opened: true },
    {
      read: async () =>
        ++reads < 3
          ? record({ sent: 1791972000, opened: 1791972041 })
          : record({
              sent: 1791972000,
              delivered: 1791972050,
              opened: 1791972041,
            }),
      limits: QUICK,
    }
  );
  assert.strictEqual(reads, 3);
  assert.strictEqual(answer.record.delivered, 1791972050);
  assert.strictEqual(answer.error, undefined);
});

test('the record is read again until the open lands', async () => {
  let reads = 0;
  const answer = await awaitRecord(
    '122175',
    [ID],
    { delivered: true, opened: true },
    {
      read: async () =>
        ++reads < 3
          ? record({ sent: 1791972000, delivered: 1791972003 })
          : record(OPENED.test_delivery),
      limits: QUICK,
    }
  );
  assert.strictEqual(reads, 3);
  assert.strictEqual(answer.record.opened, 1791972041);
  assert.strictEqual(answer.error, undefined);
});

test('a report still missing at the limit comes back without it, and how long was waited', async () => {
  const answer = await awaitRecord(
    '122175',
    [ID],
    { delivered: true, opened: false },
    {
      read: async () => record({ sent: 1791972000 }),
      limits: QUICK,
    }
  );
  assert.strictEqual(answer.record.delivered, undefined);
  assert.ok(
    answer.waitedMs >= QUICK.deliveredMs - QUICK.pollMs,
    `waited ${answer.waitedMs}ms`
  );
});

test('a 404 is read again in case the read beat the write, and reported when it lasts', async () => {
  let reads = 0;
  const late = await awaitRecord(
    '122175',
    [ID],
    { delivered: true, opened: false },
    {
      read: async () =>
        ++reads === 1
          ? { ok: false, notFound: true, error: 'API error 404' }
          : record(OPENED.test_delivery),
      limits: QUICK,
    }
  );
  assert.strictEqual(late.record.delivered, 1791972003);

  const gone = await awaitRecord(
    '122175',
    [ID],
    { delivered: true, opened: false },
    {
      read: async () => ({ ok: false, notFound: true, error: 'API error 404' }),
      limits: QUICK,
    }
  );
  assert.strictEqual(gone.record, undefined);
  assert.deepStrictEqual(gone.error, {
    notFound: true,
    message: 'API error 404',
  });
});

test('a failed delivery ends the wait: nothing more will land on it', async () => {
  let reads = 0;
  const answer = await awaitRecord(
    '122175',
    [ID],
    { delivered: true, opened: true },
    {
      read: async () => (
        reads++, record({ sent: 1791972000, failed: 1791972000 })
      ),
      limits: QUICK,
    }
  );
  assert.strictEqual(reads, 1);
  assert.strictEqual(answer.record.failed, 1791972000);
});

test('of a send and its re-send, the one the device reported is the one kept', async () => {
  const answer = await awaitRecord(
    '122175',
    ['first', 'resent'],
    { delivered: true, opened: true },
    {
      read: async (environmentId, id) =>
        id === 'resent'
          ? record({ ...OPENED.test_delivery, id: 'resent' })
          : record({ id: 'first', sent: 1 }),
      limits: QUICK,
    }
  );
  assert.strictEqual(answer.record.id, 'resent');
});

// --- the read-back over a whole run ----------------------------------------------

const delivered = (state, sentIds, extra = {}) => ({
  state,
  verdict: 'pass',
  evidence: [],
  sentIds,
  ...extra,
});
const tapped = (state, extra = {}) => ({
  state,
  verdict: 'pass',
  tapped: true,
  evidence: [],
  ...extra,
});
const section = (metric, cells) => ({ metric, cells });

/** A read that answers per id, counting each read. */
const reader = (byId) => {
  const reads = [];
  const read = async (environmentId, id) => {
    reads.push(id);
    const answer = byId[id];
    return typeof answer === 'function' ? answer() : answer;
  };
  return { read, reads };
};

test('with the feature off, end-to-end reads nothing and says why: unproven, never passed', async () => {
  const { read, reads } = reader({});
  const result = await readBack({
    environmentId: '122175',
    judge: true,
    delivered: section('delivered', [
      delivered('killed', []),
      delivered('background', []),
    ]),
    opened: section('opened', [
      tapped('killed', { verdict: 'skip', cause: 'runtime.tap_lines_lost' }),
    ]),
    linkSent: false,
    read,
    limits: QUICK,
  });
  assert.deepStrictEqual(reads, []);
  assert.strictEqual(result.recorded.cells.length, 0);
  assert.match(result.recorded.skipped, /returned no delivery id/);
  // The open the log could not prove stays unproven, and says the record was not read.
  assert.strictEqual(result.opened.cells[0].verdict, 'skip');
  assert.match(
    result.opened.cells[0].evidence.at(-1),
    /not read: the send returned no delivery id/
  );

  const ladder = new Ladder();
  ladder.addMatrix(result.delivered);
  ladder.addMatrix(result.opened);
  ladder.addMatrix(result.recorded);
  assert.strictEqual(ladder.exitCode, 21);
  assert.strictEqual(ladder.matrices[0].cells[0].recorded, 'not_checked');
});

test('nothing sent means nothing to read, said as that', async () => {
  const result = await readBack({
    environmentId: '122175',
    judge: true,
    delivered: section('delivered', [
      delivered('killed', undefined, { verdict: 'skip' }),
    ]),
    linkSent: false,
    read: async () => assert.fail('nothing should be read'),
  });
  assert.match(result.recorded.skipped, /no push was sent/);
});

test('end to end: each push recorded as delivered, and opened where tapped, passes', async () => {
  const { read } = reader({
    k: record({ ...OPENED.test_delivery, id: 'k' }),
    b: record({ id: 'b', sent: 1791972000, delivered: 1791972002 }),
  });
  const result = await readBack({
    environmentId: '122175',
    judge: true,
    delivered: section('delivered', [
      delivered('killed', ['k']),
      delivered('background', ['b']),
    ]),
    opened: section('opened', [tapped('killed')]),
    linkSent: false,
    read,
    limits: QUICK,
  });
  const [killed, background] = result.recorded.cells;
  assert.strictEqual(killed.verdict, 'pass');
  assert.strictEqual(killed.summary, 'delivered · opened');
  assert.match(
    killed.evidence[0],
    /delivery k, provider 200, sent 10:00:00Z, delivered 3s later, opened 41s later/
  );
  assert.strictEqual(background.verdict, 'pass');
  assert.strictEqual(background.summary, 'delivered');
  // The record is a fact on the device's cells too.
  assert.deepStrictEqual(
    result.delivered.cells.map((cell) => cell.recorded),
    ['recorded', 'recorded']
  );
  assert.strictEqual(result.opened.cells[0].recorded, 'recorded');
});

test('a report missing at the limit is unproven with its cause, and says it can still arrive', async () => {
  const { read } = reader({
    k: record({ id: 'k', sent: 1791972000, delivered: 1791972003 }),
  });
  const result = await readBack({
    environmentId: '122175',
    judge: true,
    delivered: section('delivered', [delivered('killed', ['k'])]),
    opened: section('opened', [tapped('killed')]),
    linkSent: false,
    read,
    limits: QUICK,
  });
  const [cell] = result.recorded.cells;
  assert.strictEqual(cell.verdict, 'skip');
  assert.strictEqual(cell.cause, 'backend.metric_not_recorded');
  assert.match(
    cell.evidence.at(-1),
    /opened not recorded within \d+s; it can still arrive later/
  );
  assert.strictEqual(result.opened.cells[0].recorded, 'not_recorded');
  assert.ok(CAUSES['backend.metric_not_recorded']);
});

test('a refusal Customer.io recorded fails with the same cause as the send, and its reason', async () => {
  const { read, reads } = reader({
    k: record({
      id: 'k',
      state: 'failed',
      sent: null,
      failed: 1791972000,
      provider_status: 400,
      failure_message: 'BadDeviceToken',
      failure_detail: '{"reason":"BadDeviceToken"}',
    }),
  });
  const result = await readBack({
    environmentId: '122175',
    judge: true,
    delivered: section('delivered', [
      delivered('killed', ['k'], {
        verdict: 'fail',
        cause: 'send.provider_rejected',
      }),
    ]),
    linkSent: false,
    read,
    limits: QUICK,
  });
  const [cell] = result.recorded.cells;
  assert.strictEqual(cell.verdict, 'fail');
  assert.strictEqual(cell.cause, 'send.provider_rejected');
  assert.match(cell.evidence[0], /delivery k, provider 400, failed 10:00:00Z/);
  assert.match(
    cell.evidence.at(-1),
    /recorded it as failed: BadDeviceToken \(\{"reason":"BadDeviceToken"\}\)/
  );
  // A push the device never got is read once, not waited on.
  assert.deepStrictEqual(reads, ['k']);
});

test('an id the send returned that reads as 404 is its own cause', async () => {
  const { read } = reader({
    k: { ok: false, notFound: true, error: 'API error 404: Not Found' },
  });
  const result = await readBack({
    environmentId: '122175',
    judge: true,
    delivered: section('delivered', [delivered('killed', ['k'])]),
    linkSent: false,
    read,
    limits: QUICK,
  });
  assert.strictEqual(
    result.recorded.cells[0].cause,
    'backend.delivery_not_found'
  );
  assert.strictEqual(result.recorded.cells[0].verdict, 'skip');
  assert.strictEqual(result.delivered.cells[0].recorded, undefined);
});

test('on the device, only an open the log could not prove is read, and the record settles it', async () => {
  const { read, reads } = reader({
    k: record({ ...OPENED.test_delivery, id: 'k' }),
  });
  const result = await readBack({
    environmentId: '122175',
    judge: false,
    delivered: section('delivered', [
      delivered('killed', ['k']),
      delivered('background', ['b']),
    ]),
    opened: section('opened', [
      tapped('killed', {
        verdict: 'fail',
        cause: 'runtime.cold_tap_not_handled',
      }),
      tapped('background'),
    ]),
    linkSent: false,
    read,
    limits: QUICK,
  });
  assert.deepStrictEqual(reads, ['k']);
  assert.strictEqual(result.recorded, undefined);
  assert.strictEqual(result.opened.cells[0].verdict, 'pass');
  assert.match(
    result.opened.cells[0].evidence.at(-1),
    /recorded the open of k at 10:00:41Z/
  );
  // A tap the log proved is left alone.
  assert.strictEqual(result.opened.cells[1].verdict, 'pass');
  assert.strictEqual(result.opened.cells[1].recorded, undefined);
  assert.strictEqual(result.delivered.cells[0].recorded, undefined);
});

test('a 401 or 403 ends the wait at once, and a 404 is still read again', async () => {
  let refusals = 0;
  const refused = await awaitRecord('1', ['dgS_a'], { delivered: true, opened: true }, {
    read: async () => (refusals++, { ok: false, notFound: false, permanent: true, error: '403 forbidden' }),
    limits: { openedMs: 60_000, pollMs: 5 },
  });
  assert.strictEqual(refusals, 1);
  assert.strictEqual(refused.record, undefined);
  assert.match(refused.error.message, /403/);

  let misses = 0;
  await awaitRecord('1', ['dgS_a'], { delivered: true, opened: true }, {
    read: async () => (misses++, { ok: false, notFound: true, permanent: false, error: '404 not found' }),
    limits: { openedMs: 60, pollMs: 5 },
  });
  assert.ok(misses > 2, `a 404 was read ${misses} times`);
});

test('a failed read of a record is classified from the answer it carries', async () => {
  const read = (error) => readDelivery('1', 'dgS_a', async () => ({ ok: false, error }));
  assert.strictEqual((await read('cio api failed: 403 Forbidden')).permanent, true);
  assert.strictEqual((await read('cio api failed: 401 Unauthorized')).permanent, true);
  assert.strictEqual((await read('cio api failed: 404 Not Found')).permanent, false);
  assert.strictEqual((await read('cio api failed: 503 Unavailable')).permanent, false);
});

test('a delivery the provider refused is said to be refused, not to be one that may still open', () => {
  const { openedAnswer, withRecordedOpen } = require('../../dist/verify/areas/push/record');
  const answer = openedAnswer(
    { record: { id: 'dgS_a', failed: 1791983000, providerStatus: 400, failureMessage: 'BadDeviceToken' }, waitedMs: 3000 },
    ['dgS_a']
  );
  assert.deepStrictEqual(answer, { answer: 'failed', deliveryId: 'dgS_a', reason: 'BadDeviceToken' });
  const cell = { state: 'killed', verdict: 'skip', cause: 'runtime.tap_lines_lost', evidence: [] };
  const settled = withRecordedOpen(cell, answer, false);
  assert.strictEqual(settled.verdict, 'skip');
  assert.match(settled.evidence.at(-1), /recorded dgS_a as failed \(BadDeviceToken\), so no open can arrive/);
  assert.doesNotMatch(settled.evidence.join(' '), /can still arrive later/);
});

test('a delivery read as sent and later as failed ends on the failure, not the older sent read', async () => {
  let reads = 0;
  const answer = await awaitRecord('1', ['dgS_a'], { delivered: true, opened: false }, {
    read: async () => {
      reads += 1;
      return reads === 1
        ? { ok: true, record: { id: 'dgS_a', sent: 1791983000 } }
        : { ok: true, record: { id: 'dgS_a', sent: 1791983000, failed: 1791983004, failureMessage: 'BadDeviceToken' } };
    },
    limits: { deliveredMs: 2_000, pollMs: 5 },
  });
  assert.strictEqual(answer.record.failed, 1791983004);
  assert.strictEqual(answer.record.failureMessage, 'BadDeviceToken');
  assert.strictEqual(reads, 2, 'a failure is final, so the wait ends on it');
});

test('a refused first send does not end the wait while its re-send is still on its way', async () => {
  let reads = 0;
  const answer = await awaitRecord('1', ['dgS_first', 'dgS_retry'], { delivered: true, opened: false }, {
    read: async (_env, id) => {
      reads += 1;
      if (id === 'dgS_first') return { ok: true, record: { id, sent: 1, failed: 2 } };
      return reads > 6
        ? { ok: true, record: { id, sent: 3, delivered: 4 } }
        : { ok: true, record: { id, sent: 3 } };
    },
    limits: { deliveredMs: 2_000, pollMs: 5 },
  });
  assert.strictEqual(answer.record.id, 'dgS_retry');
  assert.strictEqual(answer.record.delivered, 4);
});

test("a refused first send does not end the wait while the re-send's record has not landed", async () => {
  let reads = 0;
  const answer = await awaitRecord('1', ['dgS_first', 'dgS_retry'], { delivered: true, opened: false }, {
    read: async (_env, id) => {
      reads += 1;
      if (id === 'dgS_first') return { ok: true, record: { id, sent: 1, failed: 2 } };
      // The re-send's record is written a moment after the send: 404 until then.
      return reads > 6
        ? { ok: true, record: { id, sent: 3, delivered: 4 } }
        : { ok: false, notFound: true, permanent: false, error: 'API error 404' };
    },
    limits: { deliveredMs: 2_000, pollMs: 5 },
  });
  assert.strictEqual(answer.record.id, 'dgS_retry');
  assert.strictEqual(answer.record.delivered, 4);
});
