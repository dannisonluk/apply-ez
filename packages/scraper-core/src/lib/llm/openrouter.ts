import { request } from 'undici';

/**
 * Minimal OpenRouter client.
 *
 * Why tool calling and not `response_format: { type: 'json_schema' }`:
 * measured on 2026-09-22, the primary free model (`qwen/qwen3.8-27b:free`) has a
 * **34.12% structured-output error rate** but only a **0.21% tool-call error rate**.
 * Forcing JSON schema mode fails roughly one job in three; forcing a tool call
 * fails about one in five hundred. So the whole layer is built on tool calls.
 *
 * Free-tier rate limits are read from the response headers
 * (`x-ratelimit-remaining` / `x-ratelimit-limit` / `x-ratelimit-reset`) rather than
 * from a separate `/key` probe — the headers describe the request we just made,
 * which is the number that actually matters.
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export interface RateLimitSnapshot {
  limit: number | null;
  remaining: number | null;
  /** Unix seconds, when the window resets. */
  resetAt: number | null;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface ToolCallRequest {
  model: string;
  messages: ChatMessage[];
  tool: ToolDefinition;
  maxTokens?: number;
  temperature?: number;
}

export interface ToolCallResult {
  /** Raw parsed arguments from the tool call. Untrusted — validate with Zod. */
  args: unknown;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  rateLimit: RateLimitSnapshot;
}

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  /** Sent as HTTP-Referer / X-Title; OpenRouter uses these for attribution. */
  referer?: string | undefined;
  title?: string | undefined;
}

export class OpenRouterError extends Error {
  readonly statusCode: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    details: { statusCode?: number | null; retryable?: boolean; retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.name = 'OpenRouterError';
    this.statusCode = details.statusCode ?? null;
    this.retryable = details.retryable ?? false;
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}

function parseHeaderNumber(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readRateLimit(headers: Record<string, string | string[] | undefined>): RateLimitSnapshot {
  return {
    limit: parseHeaderNumber(headers['x-ratelimit-limit']),
    remaining: parseHeaderNumber(headers['x-ratelimit-remaining']),
    resetAt: parseHeaderNumber(headers['x-ratelimit-reset']),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenRouterClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly referer: string | undefined;
  private readonly title: string | undefined;

  constructor(options: OpenRouterOptions) {
    if (!options.apiKey) throw new Error('OpenRouter API key is required');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.referer = options.referer;
    this.title = options.title;
  }

  /**
   * Force a single tool call and return its arguments.
   *
   * Retries 429 and 5xx with exponential backoff, honouring `Retry-After`.
   * Does NOT retry 4xx other than 429 — a bad request or an unknown model will
   * fail identically on the next attempt, and burning free-tier quota on it is
   * exactly what we cannot afford.
   */
  async callTool(req: ToolCallRequest): Promise<ToolCallResult> {
    let lastError: OpenRouterError | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.callToolOnce(req);
      } catch (error) {
        const wrapped =
          error instanceof OpenRouterError
            ? error
            : new OpenRouterError(error instanceof Error ? error.message : String(error));

        lastError = wrapped;
        if (!wrapped.retryable || attempt === this.maxRetries) throw wrapped;

        const backoff = wrapped.retryAfterMs ?? 1_500 * 2 ** attempt;
        await sleep(Math.min(backoff, 30_000));
      }
    }

    throw lastError ?? new OpenRouterError('OpenRouter call failed with no error recorded');
  }

  private async callToolOnce(req: ToolCallRequest): Promise<ToolCallResult> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
    };
    if (this.referer) headers['http-referer'] = this.referer;
    if (this.title) headers['x-title'] = this.title;

    let response;
    try {
      response = await request(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          tools: [req.tool],
          tool_choice: { type: 'function', function: { name: req.tool.function.name } },
          max_tokens: req.maxTokens ?? 900,
          temperature: req.temperature ?? 0.2,
        }),
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
      });
    } catch (error) {
      // Network-level failure: worth retrying.
      throw new OpenRouterError(
        `OpenRouter request failed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      );
    }

    const raw = await response.body.text();
    const rateLimit = readRateLimit(response.headers as Record<string, string | string[] | undefined>);

    if (response.statusCode === 429) {
      const retryAfter = parseHeaderNumber(
        (response.headers as Record<string, string | string[] | undefined>)['retry-after'],
      );
      throw new OpenRouterError(`OpenRouter rate limited: ${raw.slice(0, 200)}`, {
        statusCode: 429,
        retryable: true,
        retryAfterMs: retryAfter === null ? null : retryAfter * 1000,
      });
    }

    if (response.statusCode >= 500) {
      throw new OpenRouterError(`OpenRouter ${response.statusCode}: ${raw.slice(0, 200)}`, {
        statusCode: response.statusCode,
        retryable: true,
      });
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new OpenRouterError(`OpenRouter ${response.statusCode}: ${raw.slice(0, 300)}`, {
        statusCode: response.statusCode,
        retryable: false,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new OpenRouterError(`OpenRouter returned non-JSON: ${raw.slice(0, 200)}`, {
        statusCode: response.statusCode,
        retryable: true,
      });
    }

    const body = parsed as {
      model?: string;
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };

    if (body.error?.message) {
      throw new OpenRouterError(`OpenRouter error: ${body.error.message}`, {
        statusCode: response.statusCode,
        retryable: false,
      });
    }

    const choice = body.choices?.[0];
    const toolCalls = choice?.message?.tool_calls ?? [];
    const matching = toolCalls.find((call) => call.function?.name === req.tool.function.name);
    const call = matching ?? toolCalls[0];

    if (!call?.function?.arguments) {
      // A model that ignored `tool_choice` and answered in prose. Retrying with the
      // same prompt usually fails the same way, so this is surfaced as non-retryable
      // and the caller falls back to the secondary model.
      throw new OpenRouterError(
        `Model ${req.model} did not return a tool call (finish_reason=${choice?.finish_reason ?? 'unknown'})`,
        { statusCode: response.statusCode, retryable: false },
      );
    }

    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      throw new OpenRouterError(`Tool arguments were not valid JSON: ${call.function.arguments.slice(0, 200)}`, {
        statusCode: response.statusCode,
        retryable: false,
      });
    }

    return {
      args,
      model: body.model ?? req.model,
      promptTokens: body.usage?.prompt_tokens ?? null,
      completionTokens: body.usage?.completion_tokens ?? null,
      rateLimit,
    };
  }
}
