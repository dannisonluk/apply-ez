/**
 * Regression check for the shared HTTP layer and the failure circuit.
 *
 * Run with:  pnpm --filter @apply-ez/scraper-core exec tsx scripts/check-http.ts
 *
 * Why this suite exists: the Workday, Eightfold and Phenom adapters each had
 * their own `fetchJson` that called bare `fetch`, so they bypassed the project's
 * robots.txt check, its per-host rate limiter, and its retry policy. Nothing
 * failed visibly — the adapters just quietly did not participate. The cost showed
 * up later as a CDN block on HSBC, and as a listing failure that reported
 * "listing page failed" with no reason attached.
 *
 * So the assertions here are mostly about what does NOT happen: a disallowed path
 * is never requested, a 403 is never retried, a crawl-delay is never ignored.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FailureCircuit } from '../src/lib/circuit.js';
import { fetchJson } from '../src/lib/http-json.js';
import { configureRateLimit, parseRetryAfterMs, scraperUserAgent } from '../src/lib/rate-limit.js';

// Fast retries. The production backoff starts at 1.2s and doubles, which would
// make the retry cases below take half a minute of wall clock. Both are read per
// call rather than at import time, so setting them here works regardless of
// module evaluation order.
process.env.SCRAPER_RETRY_MAX_ATTEMPTS = '3';
process.env.SCRAPER_RETRY_INITIAL_DELAY_MS = '20';
process.env.SCRAPER_RETRY_MAX_DELAY_MS = '50';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected);
    passed += 1;
  } catch {
    failed += 1;
    console.error(
      `FAIL  ${name}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`,
    );
  }
}

const ALLOW_ALL_ROBOTS = 'User-agent: *\nAllow: /\n';

async function withServer<T>(server: ReturnType<typeof createServer>, fn: (origin: string) => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Serves an allow-all robots.txt, then answers every other path with `status`. */
function statusServer(status: number, options: { headers?: Record<string, string>; failTimes?: number } = {}) {
  const failTimes = options.failTimes ?? Number.POSITIVE_INFINITY;
  const state = { calls: 0 };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '', 'http://127.0.0.1');
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(ALLOW_ALL_ROBOTS);
      return;
    }
    state.calls += 1;
    if (state.calls > failTimes) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json', ...(options.headers ?? {}) });
    res.end(JSON.stringify({ error: `status ${status}` }));
  });
  return { server, state };
}

async function main(): Promise<void> {
  // Pacing off by default; the pacing case below sets its own floor. Each mock
  // server gets a fresh port, so each is a fresh host with a fresh limiter.
  configureRateLimit({ minTimeMs: 0, maxConcurrent: 4 });

  // ── robots.txt is enforced BEFORE the request is sent ─────────────────────
  const seenPaths: string[] = [];
  const robotsServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '', 'http://127.0.0.1');
    seenPaths.push(url.pathname);
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /private\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  await withServer(robotsServer, async (origin) => {
    let refusal = '';
    const blocked = await fetchJson(`${origin}/private/jobs`, {
      onFailure: (detail) => {
        refusal = detail;
      },
    });
    check('robots: a disallowed path yields no payload', blocked, undefined);
    check('robots: the refusal names robots.txt', /robots\.txt disallows/.test(refusal), true);
    // The point of the check: a refusal that still sends the request is not a
    // refusal. The path must never reach the server.
    check('robots: the disallowed path was never requested', seenPaths.includes('/private/jobs'), false);

    const allowed = await fetchJson<{ ok?: boolean }>(`${origin}/public/jobs`);
    check('robots: an allowed path is fetched', allowed?.ok, true);
    check('robots: the allowed path was requested', seenPaths.includes('/public/jobs'), true);
  });

  // ── a flaky robots.txt is retried, not silently downgraded ────────────────
  // robots.txt is read once per host per hour and then cached, so a single flake
  // there downgrades the whole host to fail-open — losing both the verdict and any
  // declared crawl-delay, with nothing in the run summary to show for it. Measured
  // on AXA, whose robots.txt intermittently timed out.
  const flakyRobots = { robotsHits: 0, paths: [] as string[] };
  const flakyRobotsServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '', 'http://127.0.0.1');
    if (url.pathname === '/robots.txt') {
      flakyRobots.robotsHits += 1;
      if (flakyRobots.robotsHits === 1) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('temporarily unavailable');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /private\n');
      return;
    }
    flakyRobots.paths.push(url.pathname);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  await withServer(flakyRobotsServer, async (origin) => {
    const blocked = await fetchJson(`${origin}/private/jobs`);
    check('robots retry: a transient failure is retried', flakyRobots.robotsHits, 2);
    // The retry is what makes this work. Without it the host would be fail-open,
    // the policy would be lost, and this request would have been sent.
    check('robots retry: the parsed policy still applies', blocked, undefined);
    check('robots retry: the disallowed path was never sent', flakyRobots.paths.includes('/private/jobs'), false);
  });

  // A 404 is a real answer, not a failure: the site has no robots.txt, so there is
  // nothing to retry and the fail-open path is correct.
  const absent = { robotsHits: 0 };
  const absentRobotsServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '', 'http://127.0.0.1');
    if (url.pathname === '/robots.txt') {
      absent.robotsHits += 1;
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  await withServer(absentRobotsServer, async (origin) => {
    const fetched = await fetchJson<{ ok?: boolean }>(`${origin}/jobs`);
    check('robots 404: not retried', absent.robotsHits, 1);
    check('robots 404: fails open and fetches', fetched?.ok, true);
  });

  // ── a declared crawl-delay paces us, above our own floor ──────────────────
  const delayServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '', 'http://127.0.0.1');
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      // AXA really declares this.
      res.end('User-agent: *\nAllow: /\ncrawl-delay: 1\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  await withServer(delayServer, async (origin) => {
    // Our own floor is 0 here, so anything measured comes from the site's own
    // crawl-delay rather than from our default pacing.
    configureRateLimit({ minTimeMs: 0 });
    const startedAt = Date.now();
    await fetchJson(`${origin}/a`);
    await fetchJson(`${origin}/b`);
    const elapsed = Date.now() - startedAt;
    check('crawl-delay: a declared delay is honoured', elapsed >= 900, true);
  });

  // ── our own pacing floor still applies ───────────────────────────────────
  const pacedServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '', 'http://127.0.0.1');
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(ALLOW_ALL_ROBOTS);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  await withServer(pacedServer, async (origin) => {
    configureRateLimit({ minTimeMs: 60, maxConcurrent: 4 });
    const startedAt = Date.now();
    await Promise.all([fetchJson(`${origin}/1`), fetchJson(`${origin}/2`), fetchJson(`${origin}/3`)]);
    check('pacing: the configured floor spaces requests', Date.now() - startedAt >= 100, true);
  });

  configureRateLimit({ minTimeMs: 0, maxConcurrent: 4 });

  // ── retry policy ─────────────────────────────────────────────────────────
  const flaky = statusServer(503, { failTimes: 1 });
  const flakyResult = await withServer(flaky.server, (origin) => fetchJson<{ ok?: boolean }>(`${origin}/jobs`));
  check('retry: a transient 503 is retried and then succeeds', flakyResult?.ok, true);
  check('retry: exactly one retry was needed', flaky.state.calls, 2);

  const down = statusServer(500);
  const downResult = await withServer(down.server, (origin) => fetchJson(`${origin}/jobs`));
  check('retry: a persistent 500 eventually gives up', downResult, undefined);
  check('retry: 500 gets 1 attempt + 3 retries', down.state.calls, 4);

  const missing = statusServer(404);
  await withServer(missing.server, (origin) => fetchJson(`${origin}/jobs`));
  check('retry: 404 is not retried', missing.state.calls, 1);

  // The pinned decision. A CDN 403 is a block, not a blip: retrying it multiplies
  // load against whatever just decided to refuse us, which is how a two-minute
  // block becomes an hourly one. Pacing is the fix; a retry only makes it worse.
  const forbidden = statusServer(403);
  let forbiddenDetail = '';
  await withServer(forbidden.server, (origin) =>
    fetchJson(`${origin}/jobs`, {
      onFailure: (detail) => {
        forbiddenDetail = detail;
      },
    }),
  );
  check('retry: 403 is not retried', forbidden.state.calls, 1);
  // And the body is surfaced, so a blocked run is diagnosable from the run summary.
  check('retry: the 403 response body reaches the caller', /status 403/.test(forbiddenDetail), true);
  check('retry: the failure message carries the status', /HTTP 403/.test(forbiddenDetail), true);

  const throttled = statusServer(429, { headers: { 'retry-after': '1' } });
  const throttledResult = await withServer(throttled.server, (origin) => fetchJson(`${origin}/jobs`));
  check('retry: a persistent 429 gives up', throttledResult, undefined);
  check('retry: 429 gets 1 attempt + 3 retries', throttled.state.calls, 4);

  // `Retry-After` is honoured by `withRetry`, which caps it at maxDelayMs — so the
  // 429 case above stays fast rather than sleeping the requested second.
  check('retry-after: seconds become ms', parseRetryAfterMs('1'), 1000);
  check('retry-after: absent is undefined', parseRetryAfterMs(undefined), undefined);
  check('retry-after: a past HTTP date is ignored', parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT'), undefined);

  // ── the request shape the adapters depend on ──────────────────────────────
  let postBody = '';
  let postContentType = '';
  let seenUserAgent = '';
  const shapeServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '', 'http://127.0.0.1');
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(ALLOW_ALL_ROBOTS);
      return;
    }
    seenUserAgent = String(req.headers['user-agent'] ?? '');
    postContentType = String(req.headers['content-type'] ?? '');
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      postBody = body;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await withServer(shapeServer, async (origin) => {
    await fetchJson(`${origin}/jobs`, { method: 'POST', body: '{"limit":20,"offset":0}' });
  });
  check('post: the body is sent verbatim', postBody, '{"limit":20,"offset":0}');
  // Workday rejects a CXS POST without this, so it is set automatically whenever
  // a body is present rather than left to each call site.
  check('post: content-type is json', postContentType, 'application/json');
  // The project's declared identity, not a string pretending to be a browser.
  check('ua: the declared bot identity is sent', seenUserAgent, scraperUserAgent());
  check('ua: no browser spoofing', /Mozilla/.test(seenUserAgent), false);

  // ── FailureCircuit ───────────────────────────────────────────────────────
  const fresh = new FailureCircuit();
  check('circuit: starts closed', fresh.isOpen, false);

  const belowFloor = new FailureCircuit();
  for (let i = 0; i < 7; i += 1) belowFloor.recordFailure();
  check('circuit: 7 failures is below the floor', belowFloor.isOpen, false);

  const allBad = new FailureCircuit();
  for (let i = 0; i < 8; i += 1) allBad.recordFailure();
  check('circuit: 8 failures out of 8 trips it', allBad.isOpen, true);

  const noisy = new FailureCircuit();
  for (let i = 0; i < 100; i += 1) noisy.recordSuccess();
  for (let i = 0; i < 10; i += 1) noisy.recordFailure();
  check('circuit: isolated failures among successes do not trip it', noisy.isOpen, false);

  const atRatio = new FailureCircuit();
  for (let i = 0; i < 5; i += 1) atRatio.recordSuccess();
  for (let i = 0; i < 20; i += 1) atRatio.recordFailure();
  check('circuit: exactly 0.8 trips it', atRatio.isOpen, true);

  const underRatio = new FailureCircuit();
  for (let i = 0; i < 6; i += 1) underRatio.recordSuccess();
  for (let i = 0; i < 20; i += 1) underRatio.recordFailure();
  check('circuit: just under 0.8 stays closed', underRatio.isOpen, false);

  // Latched: a few in-flight successes must not re-open the gate onto a host that
  // is still refusing.
  const latched = new FailureCircuit();
  for (let i = 0; i < 8; i += 1) latched.recordFailure();
  for (let i = 0; i < 20; i += 1) latched.recordSuccess();
  check('circuit: an open circuit stays open', latched.isOpen, true);

  const described = new FailureCircuit();
  described.recordFailure();
  described.recordSuccess();
  described.recordSuccess();
  check('circuit: describe reports both counts', described.describe(), '1 failed / 2 ok');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
