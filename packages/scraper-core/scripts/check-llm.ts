/**
 * Regression checks for the LLM enrichment layer.
 *
 * Two halves:
 *   1. Pure functions — prompt building, truncation, deadline sanitising, list
 *      normalising, and the Zod contract.
 *   2. A mock OpenRouter server on localhost — exercises the real `OpenRouterClient`
 *      against canned responses (happy path, prose-instead-of-tool-call, 429 with
 *      Retry-After, 400 that must NOT be retried, rate-limit header capture).
 *      This is how the client is verified without spending any free-tier quota.
 *
 * Run: pnpm --filter @apply-ez/scraper-core check:llm
 */
import { createServer, type Server } from 'node:http';
import { OpenRouterClient, OpenRouterError } from '../src/lib/llm/openrouter.js';
import {
  buildInsightPrompt,
  deadlineToInstant,
  estimateTokens,
  INSIGHT_TOOL_NAME,
  jobInsightSchema,
  normalizeEmploymentType,
  normalizeSeniority,
  normalizeStringList,
  normalizeSummaryLang,
  normalizeWorkArrangement,
  sanitizeDeadline,
  truncateDescription,
} from '../src/lib/llm/schema.js';
import { toStoredInsight } from '../src/lib/llm/enrich.js';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(detail === undefined ? name : `${name} — got ${JSON.stringify(detail)}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(name, actual === expected, actual);
}

const TOOL = {
  type: 'function' as const,
  function: { name: INSIGHT_TOOL_NAME, description: 'd', parameters: { type: 'object' } },
};

// ─── 1. truncateDescription ───────────────────────────────────────────────────
{
  const short = 'a'.repeat(500);
  eq('truncate: short text untouched', truncateDescription(short), short);

  const long = `${'H'.repeat(6000)}${'M'.repeat(6000)}${'T'.repeat(3000)}`;
  const cut = truncateDescription(long);
  check('truncate: keeps head', cut.startsWith('H'.repeat(100)));
  check('truncate: keeps tail', cut.endsWith('T'.repeat(100)));
  check('truncate: marks the omission', cut.includes('middle of the posting omitted'));
  check('truncate: shorter than input', cut.length < long.length, cut.length);

  // The whole point: requirements live at the end, so the tail must survive.
  const withReq = `${'x'.repeat(9000)}\nRequirements: 5 years of TypeScript.`;
  check('truncate: requirement line survives', truncateDescription(withReq).includes('5 years of TypeScript'));

  eq('truncate: collapses 3+ blank lines', truncateDescription('a\n\n\n\nb'), 'a\n\nb');
  eq('truncate: normalises CRLF', truncateDescription('a\r\nb'), 'a\nb');
}

// ─── 2. buildInsightPrompt ────────────────────────────────────────────────────
{
  const prompt = buildInsightPrompt({
    title: 'Backend Engineer',
    companyName: 'Towngas',
    location: 'Hong Kong',
    department: 'Digital',
    description: 'Build things.',
    knownExperienceMin: 5,
    knownDeadline: '2026-10-01',
  });
  check('prompt: title present', prompt.includes('Backend Engineer'));
  check('prompt: company present', prompt.includes('Towngas'));
  check('prompt: known yoe stated', prompt.includes('minimum years of experience: 5'));
  check('prompt: known deadline stated', prompt.includes('2026-10-01'));
  check('prompt: wrapped in untrusted marker', prompt.startsWith('<job_posting>') && prompt.endsWith('</job_posting>'));

  const sparse = buildInsightPrompt({ title: 'Analyst' });
  check('prompt: tells the model to omit unknowns', sparse.includes('omit every field you cannot determine'));
  check('prompt: no posting-text block when empty', !sparse.includes('--- posting text ---'));
}

// ─── 3. sanitizeDeadline ──────────────────────────────────────────────────────
{
  const now = new Date('2026-09-22T00:00:00Z');
  eq('deadline: accepts a valid near date', sanitizeDeadline('2026-10-31', now), '2026-10-31');
  eq('deadline: accepts last year', sanitizeDeadline('2025-06-01', now), '2025-06-01');
  eq('deadline: rejects empty', sanitizeDeadline('', now), undefined);
  eq('deadline: rejects prose', sanitizeDeadline('end of October', now), undefined);
  eq('deadline: rejects DD/MM/YYYY', sanitizeDeadline('31/10/2026', now), undefined);
  eq('deadline: rejects rollover date', sanitizeDeadline('2026-02-31', now), undefined);
  eq('deadline: rejects month 13', sanitizeDeadline('2026-13-01', now), undefined);
  eq('deadline: rejects far future', sanitizeDeadline('2099-01-01', now), undefined);
  eq('deadline: rejects ancient past', sanitizeDeadline('1999-01-01', now), undefined);
  eq('deadline: rejects non-string', sanitizeDeadline(20261031, now), undefined);
  eq('deadline: rejects null', sanitizeDeadline(null, now), undefined);
  eq('deadlineToInstant: end of day UTC', deadlineToInstant('2026-10-31'), '2026-10-31T23:59:59.000Z');
}

// ─── 4. normalizeStringList ───────────────────────────────────────────────────
{
  eq('list: trims and collapses whitespace', normalizeStringList(['  a   b '], 5)[0], 'a b');
  eq('list: drops empties', normalizeStringList(['a', '  ', ''], 5).length, 1);
  eq('list: dedupes case-insensitively', normalizeStringList(['React', 'react', 'REACT'], 5).length, 1);
  eq('list: caps length', normalizeStringList(['a', 'b', 'c', 'd'], 2).length, 2);
  eq('list: ignores non-strings', normalizeStringList(['a', 1, null, {}], 5).length, 1);
  eq('list: non-array input', normalizeStringList('react', 5).length, 0);
  eq('list: empty input', normalizeStringList([], 5).length, 0);
}

// ─── 5. jobInsightSchema + toStoredInsight ────────────────────────────────────
{
  const minimal = { summary: 'A'.repeat(60), summaryLang: 'en', skills: ['ts'], flags: [] };
  check('schema: accepts minimal payload', jobInsightSchema.safeParse(minimal).success);
  check('schema: rejects too-short summary', !jobInsightSchema.safeParse({ ...minimal, summary: 'short' }).success);
  check('schema: rejects missing skills', !jobInsightSchema.safeParse({ summary: 'A'.repeat(60), summaryLang: 'en', flags: [] }).success);
  // Format is deliberately NOT enforced here — see the normalise* helpers below.
  check('schema: tolerates an unknown lang', jobInsightSchema.safeParse({ ...minimal, summaryLang: 'fr' }).success);
  check('schema: tolerates an unknown seniority', jobInsightSchema.safeParse({ ...minimal, seniority: 'WIZARD' }).success);
  check('schema: tolerates a malformed deadline', jobInsightSchema.safeParse({ ...minimal, deadline: 'end of October' }).success);

  // ── normalise* helpers: bad values are dropped individually ──────────────
  eq('lang: zh maps to Traditional', normalizeSummaryLang('zh'), 'zh-Hant');
  eq('lang: zh-TW maps to Traditional', normalizeSummaryLang('zh-TW'), 'zh-Hant');
  eq('lang: en stays en', normalizeSummaryLang('en'), 'en');
  eq('lang: unknown falls back to en', normalizeSummaryLang('fr'), 'en');
  eq('lang: missing falls back to en', normalizeSummaryLang(undefined), 'en');

  eq('seniority: accepts a known code', normalizeSeniority('SENIOR'), 'SENIOR');
  eq('seniority: case-insensitive', normalizeSeniority('senior'), 'SENIOR');
  eq('seniority: hyphen-tolerant', normalizeSeniority('mid-level'), undefined);
  eq('seniority: rejects an unknown code', normalizeSeniority('WIZARD'), undefined);
  eq('seniority: rejects a non-string', normalizeSeniority(3), undefined);

  eq('employmentType: accepts CONTRACT', normalizeEmploymentType('contract'), 'CONTRACT');
  eq('employmentType: rejects nonsense', normalizeEmploymentType('gig'), undefined);
  eq('workArrangement: accepts hybrid', normalizeWorkArrangement('Hybrid'), 'HYBRID');
  eq('workArrangement: accepts on-site', normalizeWorkArrangement('on site'), 'ONSITE');
  eq('workArrangement: rejects nonsense', normalizeWorkArrangement('sometimes'), undefined);

  const stored = toStoredInsight(
    {
      summary: '  Owns  the payments  platform end to end.  ',
      summaryLang: 'en',
      skills: ['TypeScript', 'typescript', 'Kubernetes'],
      flags: [],
      yoeMin: 8,
      yoeMax: 3,
      deadline: '2026-10-31',
      seniority: 'SENIOR',
    },
    'qwen/qwen3.8-27b:free',
    false,
  );
  check('stored: parses a valid payload', stored !== null);
  eq('stored: collapses summary whitespace', stored?.summary, 'Owns the payments platform end to end.');
  eq('stored: dedupes skills', stored?.skills.length, 2);
  eq('stored: keeps the seniority code', stored?.seniority, 'SENIOR');
  // A reversed range is a model slip; both bounds are dropped rather than published.
  eq('stored: drops inverted yoe range (min)', stored?.yoeMin, undefined);
  eq('stored: drops inverted yoe range (max)', stored?.yoeMax, undefined);
  eq('stored: keeps the valid deadline', stored?.deadline, '2026-10-31');
  eq('stored: records the model', stored?.model, 'qwen/qwen3.8-27b:free');
  eq('stored: marks non-fallback', stored?.usedFallback, false);

  // A whitespace-padded stub must not sneak past the minimum-length gate.
  check(
    'stored: rejects a whitespace-padded stub',
    toStoredInsight({ summary: `   ${'a'.repeat(20)}   `, summaryLang: 'en', skills: [], flags: [] }, 'm', false) === null,
  );

  const dropped = toStoredInsight(
    { summary: 'A'.repeat(60), summaryLang: 'en', skills: [], flags: [], deadline: 'not a date' },
    'm',
    true,
  );
  // The regression this guards: a malformed deadline used to fail the whole Zod
  // parse, discarding an otherwise perfectly good summary.
  check('stored: survives a malformed deadline', dropped !== null);
  eq('stored: drops the malformed deadline', dropped?.deadline, undefined);
  eq('stored: marks fallback', dropped?.usedFallback, true);

  check('stored: rejects an invalid payload', toStoredInsight({ nope: true }, 'm', false) === null);
}

// ─── 6. estimateTokens ────────────────────────────────────────────────────────
{
  eq('tokens: rough 4 chars per token', estimateTokens('a'.repeat(400)), 100);
  eq('tokens: empty', estimateTokens(''), 0);
}

// ─── 7. OpenRouterClient against a mock server ────────────────────────────────
async function withMockServer(
  handler: (call: number, body: unknown) => { status: number; body?: unknown; headers?: Record<string, string> },
  run: (baseUrl: string, calls: () => number) => Promise<void>,
): Promise<void> {
  let count = 0;
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
      const result = handler(count, parsed);
      res.writeHead(result.status, { 'content-type': 'application/json', ...(result.headers ?? {}) });
      res.end(JSON.stringify(result.body ?? {}));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`, () => count);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function toolResponse(args: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    model: 'qwen/qwen3.8-27b:free',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [{ function: { name: INSIGHT_TOOL_NAME, arguments: JSON.stringify(args) } }],
        },
      },
    ],
    usage: { prompt_tokens: 1200, completion_tokens: 180 },
    ...extra,
  };
}

async function mockTests(): Promise<void> {
  // happy path + rate-limit header capture
  await withMockServer(
    () => ({
      status: 200,
      body: toolResponse({ summary: 'x'.repeat(60) }),
      headers: {
        'x-ratelimit-limit': '50',
        'x-ratelimit-remaining': '49',
        'x-ratelimit-reset': '1790000000',
      },
    }),
    async (baseUrl, calls) => {
      const client = new OpenRouterClient({ apiKey: 'test', baseUrl, maxRetries: 0 });
      const result = await client.callTool({
        model: 'qwen/qwen3.8-27b:free',
        messages: [{ role: 'user', content: 'hi' }],
        tool: TOOL,
      });
      check('client: parses tool arguments', (result.args as { summary: string }).summary.length === 60);
      eq('client: reports the model', result.model, 'qwen/qwen3.8-27b:free');
      eq('client: captures prompt tokens', result.promptTokens, 1200);
      eq('client: captures completion tokens', result.completionTokens, 180);
      eq('client: captures quota limit', result.rateLimit.limit, 50);
      eq('client: captures quota remaining', result.rateLimit.remaining, 49);
      eq('client: captures quota reset', result.rateLimit.resetAt, 1790000000);
      eq('client: made exactly one call', calls(), 1);
    },
  );

  // prose instead of a tool call — must fail and must NOT be retried
  await withMockServer(
    () => ({
      status: 200,
      body: {
        model: 'm',
        choices: [{ finish_reason: 'stop', message: { content: 'Sure! Here is the summary:' } }],
      },
    }),
    async (baseUrl, calls) => {
      const client = new OpenRouterClient({ apiKey: 'test', baseUrl, maxRetries: 2 });
      let error: unknown;
      try {
        await client.callTool({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tool: TOOL });
      } catch (caught) {
        error = caught;
      }
      check('client: prose answer throws', error instanceof OpenRouterError);
      eq('client: prose answer is not retryable', (error as OpenRouterError).retryable, false);
      eq('client: prose answer not retried', calls(), 1);
    },
  );

  // 429 with Retry-After — retried, and the second attempt succeeds
  await withMockServer(
    (call) =>
      call === 1
        ? { status: 429, body: { error: { message: 'rate limited' } }, headers: { 'retry-after': '0' } }
        : { status: 200, body: toolResponse({ summary: 'y'.repeat(60) }) },
    async (baseUrl, calls) => {
      const client = new OpenRouterClient({ apiKey: 'test', baseUrl, maxRetries: 2 });
      const result = await client.callTool({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        tool: TOOL,
      });
      check('client: recovers after a 429', (result.args as { summary: string }).summary.startsWith('y'));
      eq('client: retried the 429 once', calls(), 2);
    },
  );

  // 429 exhausted — surfaced as a retryable error with statusCode 429 so the
  // orchestrator can stop the run instead of hammering the endpoint.
  await withMockServer(
    () => ({ status: 429, body: { error: { message: 'quota' } }, headers: { 'retry-after': '0' } }),
    async (baseUrl, calls) => {
      const client = new OpenRouterClient({ apiKey: 'test', baseUrl, maxRetries: 1 });
      let error: unknown;
      try {
        await client.callTool({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tool: TOOL });
      } catch (caught) {
        error = caught;
      }
      eq('client: persistent 429 surfaces statusCode', (error as OpenRouterError).statusCode, 429);
      eq('client: persistent 429 retried once', calls(), 2);
    },
  );

  // 400 must not be retried — a bad request fails identically every time
  await withMockServer(
    () => ({ status: 400, body: { error: { message: 'model not found' } } }),
    async (baseUrl, calls) => {
      const client = new OpenRouterClient({ apiKey: 'test', baseUrl, maxRetries: 3 });
      let error: unknown;
      try {
        await client.callTool({ model: 'nope', messages: [{ role: 'user', content: 'hi' }], tool: TOOL });
      } catch (caught) {
        error = caught;
      }
      eq('client: 400 is not retryable', (error as OpenRouterError).retryable, false);
      eq('client: 400 attempted once', calls(), 1);
    },
  );

  // malformed tool arguments
  await withMockServer(
    () => ({
      status: 200,
      body: {
        model: 'm',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [{ function: { name: INSIGHT_TOOL_NAME, arguments: '{not json' } }],
            },
          },
        ],
      },
    }),
    async (baseUrl) => {
      const client = new OpenRouterClient({ apiKey: 'test', baseUrl, maxRetries: 0 });
      let error: unknown;
      try {
        await client.callTool({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tool: TOOL });
      } catch (caught) {
        error = caught;
      }
      check('client: malformed arguments throw', error instanceof OpenRouterError);
      eq('client: malformed arguments not retryable', (error as OpenRouterError).retryable, false);
    },
  );

  // missing API key
  {
    let threw = false;
    try {
      new OpenRouterClient({ apiKey: '' });
    } catch {
      threw = true;
    }
    check('client: rejects an empty API key', threw);
  }
}

await mockTests();

// ─── report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} FAILED:\n`);
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
}
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
