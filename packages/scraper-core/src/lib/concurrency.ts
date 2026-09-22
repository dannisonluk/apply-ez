/**
 * Bounded-concurrency helpers for adapters.
 *
 * Adapters fetch one request per posting, which is fine over plain HTTP but not
 * if it runs sequentially — 250 detail fetches at ~300ms each is over a minute of
 * wall clock doing nothing. Unbounded `Promise.all` is the other failure mode: it
 * opens 250 sockets at once and gets the run rate-limited or blocked.
 *
 * Lives here rather than in each adapter because two copies of this is exactly
 * how `normalizeText` ended up drifting between adapters.
 */

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving order.
 *
 * A shared cursor rather than chunking: chunked batches stall on the slowest item
 * in each chunk, so with a mix of fast and slow responses the effective
 * concurrency ends up well below `limit`.
 *
 * `shouldStop` is polled before each item is claimed, so a tripped `FailureCircuit`
 * halts every runner within one item of the check rather than letting the rest of
 * the batch through. When it stops early, `results` is left with holes — callers
 * that need completeness must track it themselves (the detail stages do, via the
 * circuit and their own failure counts).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  shouldStop?: () => boolean,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const effective = Math.max(1, Math.min(Math.floor(limit), items.length));
  let cursor = 0;

  const runners = Array.from({ length: effective }, async () => {
    for (;;) {
      if (shouldStop?.()) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      // `noUncheckedIndexedAccess` widens this to `T | undefined`; the bounds
      // check above already guarantees it is present.
      if (item === undefined) continue;
      results[index] = await worker(item, index);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Read a positive integer from config or env, falling back when absent or junk.
 *
 * Config values arrive as `unknown` (they come from a plain object literal), and
 * a typo like `maxPages: "five"` should degrade to the default rather than
 * produce `NaN` offsets that silently fetch nothing.
 */
export function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
