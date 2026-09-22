/**
 * Regression checks for the push notification layer.
 *
 * Like `check-llm.ts`, the sender is verified against a local mock server so the
 * real `undici` request path is exercised without touching Expo's API. The
 * DeviceNotRegistered classification in particular is worth locking down: getting
 * it wrong means either retrying dead tokens forever or silently disabling live
 * devices.
 */
import { createServer, type Server } from 'node:http';
import {
  buildNewJobsNotice,
  isValidExpoPushToken,
  sendExpoPush,
  type ExpoPushMessage,
} from '../src/lib/push.js';

let passed = 0;
const failures: string[] = [];

function eq(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed += 1;
    return;
  }
  failures.push(`${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(detail === undefined ? name : `${name} — got ${JSON.stringify(detail)}`);
}

// ─── token validation ────────────────────────────────────────────────────────
eq('accepts a current token', isValidExpoPushToken('ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]'), true);
eq('accepts a legacy token', isValidExpoPushToken('ExponentPushToken[abcDEF123_-]'), true);
eq('rejects a bare string', isValidExpoPushToken('not-a-token'), false);
eq('rejects an empty string', isValidExpoPushToken(''), false);
eq('rejects a token with no brackets', isValidExpoPushToken('ExpoPushToken'), false);
eq('rejects a token with inner spaces', isValidExpoPushToken('ExpoPushToken[a b]'), false);
eq('rejects a fcm token', isValidExpoPushToken('fcm:abc123'), false);

// ─── notice composition ──────────────────────────────────────────────────────
eq('no jobs produces no notice', buildNewJobsNotice([]), null);

const one = buildNewJobsNotice([{ title: 'Backend Engineer', companyName: 'Towngas' }]);
eq('single job title is the notification title', one?.title, 'Backend Engineer');
eq('single job names the company in the body', one?.body, 'New at Towngas');

const oneNoCompany = buildNewJobsNotice([{ title: 'Analyst' }]);
eq('single job without a company', oneNoCompany?.body, 'New job posting');

const many = buildNewJobsNotice([
  { title: 'Backend Engineer', companyName: 'Towngas' },
  { title: 'Data Analyst', companyName: 'AIA' },
  { title: 'Product Manager', companyName: 'HSBC' },
]);
eq('several jobs are counted in the title', many?.title, '3 new jobs');
eq('several jobs name the first in the body', many?.body, 'Backend Engineer at Towngas, and 2 more');

// ─── sender against a mock Expo endpoint ─────────────────────────────────────
async function withMockExpo(
  handler: (call: number, body: unknown) => { status: number; body?: unknown },
  run: (url: string, calls: () => number, bodies: () => unknown[]) => Promise<void>,
): Promise<void> {
  let count = 0;
  const seen: unknown[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      count += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      seen.push(parsed);
      const result = handler(count, parsed);
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body ?? {}));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`, () => count, () => seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function message(to: string): ExpoPushMessage {
  return { to, title: 't', body: 'b' };
}

async function main(): Promise<void> {
  // 1. Happy path: a batch of 2, both accepted.
  await withMockExpo(
    () => ({ status: 200, body: { data: [{ status: 'ok', id: 'a' }, { status: 'ok', id: 'b' }] } }),
    async (url, calls) => {
      const result = await sendExpoPush([message('ExpoPushToken[a]'), message('ExpoPushToken[b]')], { url });
      eq('batch: both accepted', result.accepted, 2);
      eq('batch: no unregistered', result.unregistered.length, 0);
      eq('batch: no errors', result.errors.length, 0);
      eq('batch: one request', calls(), 1);
    },
  );

  // 2. A single message comes back as an object, not a 1-element array.
  await withMockExpo(
    () => ({ status: 200, body: { data: { status: 'ok', id: 'a' } } }),
    async (url) => {
      const result = await sendExpoPush([message('ExpoPushToken[a]')], { url });
      eq('single: accepted', result.accepted, 1);
      eq('single: no errors', result.errors.length, 0);
    },
  );

  // 3. DeviceNotRegistered must be classified separately from a generic error.
  await withMockExpo(
    () => ({
      status: 200,
      body: {
        data: [
          { status: 'ok', id: 'a' },
          { status: 'error', message: 'Device is not registered', details: { error: 'DeviceNotRegistered' } },
        ],
      },
    }),
    async (url) => {
      const result = await sendExpoPush([message('ExpoPushToken[a]'), message('ExpoPushToken[dead]')], { url });
      eq('unregistered: counted', result.unregistered.length, 1);
      eq('unregistered: token captured', result.unregistered[0], 'ExpoPushToken[dead]');
      eq('unregistered: not double-counted as an error', result.errors.length, 0);
      eq('unregistered: the live one still counts', result.accepted, 1);
    },
  );

  // 4. Other error codes land in `errors`, not `unregistered`.
  await withMockExpo(
    () => ({
      status: 200,
      body: {
        data: [{ status: 'error', message: 'Message too long', details: { error: 'MessageTooBig' } }],
      },
    }),
    async (url) => {
      const result = await sendExpoPush([message('ExpoPushToken[a]')], { url });
      eq('generic error: not unregistered', result.unregistered.length, 0);
      eq('generic error: captured', result.errors.length, 1);
      check('generic error: names the code', result.errors[0]?.includes('MessageTooBig') ?? false, result.errors[0]);
    },
  );

  // 5. Malformed tokens are filtered before any request is made.
  await withMockExpo(
    () => ({ status: 200, body: { data: { status: 'ok' } } }),
    async (url, calls) => {
      const result = await sendExpoPush([message('garbage'), message('also-garbage')], { url });
      eq('invalid: reported', result.invalid.length, 2);
      eq('invalid: no request made', calls(), 0);
    },
  );

  // 6. A server error is collected, not thrown — a push outage must not fail a run.
  await withMockExpo(
    () => ({ status: 500, body: { error: 'boom' } }),
    async (url) => {
      const result = await sendExpoPush([message('ExpoPushToken[a]')], { url });
      eq('server error: nothing accepted', result.accepted, 0);
      eq('server error: captured', result.errors.length, 1);
    },
  );

  // 7. Non-JSON response body.
  await withMockExpo(
    () => ({ status: 200, body: undefined }),
    async (url) => {
      const result = await sendExpoPush([message('ExpoPushToken[a]')], { url });
      // `{}` is valid JSON with no `data`, so this must not be reported as accepted.
      eq('empty body: nothing accepted', result.accepted, 0);
    },
  );

  // 8. Empty input short-circuits without a request.
  await withMockExpo(
    () => ({ status: 200, body: { data: [] } }),
    async (url, calls) => {
      const result = await sendExpoPush([], { url });
      eq('empty input: no request', calls(), 0);
      eq('empty input: zero accepted', result.accepted, 0);
    },
  );

}

await main();

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} FAILED:\n`);
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
}
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
