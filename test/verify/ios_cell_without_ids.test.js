const test = require('node:test');
const assert = require('node:assert');

const dist = '../../dist/verify';
const logs = require(`${dist}/platform/ios/logs`);
const appState = require(`${dist}/platform/ios/app_state`);
const send = require(`${dist}/areas/push/on_device/send`);
const notifications = require(`${dist}/areas/push/on_device/notifications`);
const probe = require(`${dist}/areas/push/on_device/probe`);
const pushService = require(`${dist}/platform/ios/push_service`);
const settings = require(`${dist}/platform/ios/notification_settings`);
const opened = require(`${dist}/areas/push/on_device/opened`);
const { runDeliveredMatrix } = require(`${dist}/areas/push/on_device`);

const extensionLine = { at: '', process: 'NotificationService', message: 'didReceive' };

/**
 * One foreground cell on a simulator whose sends return no delivery id and whose notification
 * store never holds the push. `onSend` and `onProbe` decide when the extension speaks.
 */
async function runOneCell({ onSend = () => {}, onProbe = () => {}, resend = false, tap = false }) {
  const lines = [];
  const tapped = [];
  let sends = 0;
  logs.startCapture = async () => ({
    available: true,
    how: 'fake',
    lines,
    mark: () => lines.length,
    since: (mark) => lines.slice(mark),
    stop: async () => {},
  });
  appState.setAppState = async () => ({ ok: true, how: 'fake' });
  send.sendVerifyPush = async (request) => {
    sends += 1;
    onSend(sends, lines, request);
    return { accepted: true };
  };
  notifications.waitForNotification = async () => false;
  notifications.waitForTitle = async () => false;
  probe.probeLocalDelivery = async () => {
    onProbe(lines);
    return { result: 'landed', evidence: 'a locally injected push landed' };
  };
  pushService.simulatorPushService = async () => ({ connected: true });
  settings.simulatorNotificationStatus = async () => undefined;
  opened.tapIosPush = async (state, push) => {
    tapped.push(push);
    return { state, verdict: 'pass', evidence: [] };
  };
  const result = await runDeliveredMatrix({
    target: { kind: 'simulator', udid: 'U1', name: 'iPhone 16', state: 'booted' },
    bundleId: 'io.example.app',
    environmentId: '1',
    token: 'a'.repeat(64),
    sandbox: true,
    provider: 'apns',
    states: ['foreground'],
    extensionName: 'NotificationService',
    cellTimeoutMs: 50,
    resend,
    tap: tap ? { states: ['foreground'] } : undefined,
  });
  return { cell: result.delivered.cells[0], tapped };
}

test("the probe waking the extension is not this push arriving", async () => {
  const { cell, tapped } = await runOneCell({ onProbe: (lines) => lines.push(extensionLine), tap: true });
  assert.notStrictEqual(cell.arrived, true);
  assert.notStrictEqual(cell.verdict, 'pass', cell.cause);
  assert.strictEqual(tapped.length, 0, 'a push that never arrived is not offered for a tap');
});

test('without delivery ids the push to tap keeps the first title', async () => {
  // The extension speaks only after the re-send, and neither send named its delivery.
  const { cell, tapped } = await runOneCell({
    resend: true,
    tap: true,
    onSend: (n, lines) => n === 2 && lines.push(extensionLine),
  });
  assert.strictEqual(cell.arrived, true);
  assert.strictEqual(tapped.length, 1);
  assert.strictEqual(tapped[0].title, cell.title);
});
