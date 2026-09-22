/**
 * Failure circuit for a fan-out fetch stage.
 *
 * `mapWithConcurrency` happily works through 250 detail fetches. That is right
 * when the failures are isolated and wrong when they are systemic: if a CDN has
 * decided to block us, every remaining request is a wasted request that also
 * extends the block. The observed HSBC run made ~247 detail requests against an
 * endpoint that had started answering 403 — the run could have stopped after ten.
 *
 * A ratio rather than a plain failure count, because the two situations look
 * different: 10 failures out of 250 is noise to push through, while 10 failures
 * out of 12 means the host is down and the remaining 238 are pointless.
 */
export class FailureCircuit {
  private successes = 0;
  private failures = 0;
  private open = false;

  constructor(
    /** Failures required before the circuit can trip at all. */
    private readonly minFailures = 8,
    /** Fraction of attempts that must be failures, once `minFailures` is reached. */
    private readonly failureRatio = 0.8,
  ) {}

  recordSuccess(): void {
    this.successes += 1;
  }

  recordFailure(): void {
    this.failures += 1;
    const attempts = this.successes + this.failures;
    if (!this.open && this.failures >= this.minFailures && this.failures / attempts >= this.failureRatio) {
      this.open = true;
    }
  }

  get failureCount(): number {
    return this.failures;
  }

  get successCount(): number {
    return this.successes;
  }

  /**
   * Latches once tripped. Recomputing the ratio on every poll would let a handful
   * of in-flight successes push it back under the threshold and re-open the gate
   * onto a host that is still refusing — the opposite of the intent.
   *
   * Recovery is not this class's job: a run that has tripped the circuit reports
   * a partial result and tries again in six hours, which is both simpler and
   * kinder to the host than probing for recovery.
   */
  get isOpen(): boolean {
    return this.open;
  }

  describe(): string {
    return `${this.failures} failed / ${this.successes} ok`;
  }
}
