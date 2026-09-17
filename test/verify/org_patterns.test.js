const test = require('node:test');
const assert = require('node:assert');

const { ERROR_CODES, exitCodeForError, printError } = require('../../dist/verify/errors');
const { selectCredentials } = require('../../dist/verify/cio/cli');

/**
 * These three behaviours are borrowed from the org's own CLIs — the `cio` CLI's error
 * envelope and exit-code mapping, its profile resolution, and `stack`'s narrator. The tests
 * pin the parts where diverging would be silently wrong.
 */

test('exit codes match the cio CLI, so a wrapper can branch on either tool', () => {
  assert.strictEqual(exitCodeForError(ERROR_CODES.validation), 2);
  assert.strictEqual(exitCodeForError(ERROR_CODES.auth), 3);
  assert.strictEqual(exitCodeForError(ERROR_CODES.authz), 4);
  assert.strictEqual(exitCodeForError(ERROR_CODES.api), 5);
  assert.strictEqual(exitCodeForError(ERROR_CODES.general), 1);
});

test('the error envelope goes to stderr and carries a stable code', () => {
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  let code;
  try {
    code = printError(ERROR_CODES.validation, 'unknown platform: martian', {
      details: { platform: 'martian' },
    });
  } finally {
    process.stderr.write = original;
  }

  assert.strictEqual(code, 2);
  const payload = JSON.parse(written.join(''));
  assert.deepStrictEqual(payload, {
    error: true,
    code: 'VALIDATION_ERROR',
    message: 'unknown platform: martian',
    details: { platform: 'martian' },
  });
});

test('a file with profiles never falls back to its own top level', () => {
  // The fallback would read another account's credentials without saying so.
  const stored = {
    current_profile: 'staging',
    account_id: '999',
    profiles: {
      default: { account_id: '1', region: 'us' },
      staging: { account_id: '2', region: 'eu' },
    },
  };
  assert.deepStrictEqual(selectCredentials(stored, 'staging'), {
    profile: 'staging',
    account_id: '2',
    region: 'eu',
  });
  assert.strictEqual(selectCredentials(stored, 'nope'), undefined);
});

test('a legacy flat config is the default profile, and nothing else', () => {
  const legacy = { account_id: '1', region: 'us' };
  assert.deepStrictEqual(selectCredentials(legacy, 'default'), {
    profile: 'default',
    account_id: '1',
    region: 'us',
  });
  assert.strictEqual(selectCredentials(legacy, 'staging'), undefined);
});

// The narrator's own properties — silence under --json, a heartbeat, one close per step —
// live on the reporter now and are covered in report.test.js.
