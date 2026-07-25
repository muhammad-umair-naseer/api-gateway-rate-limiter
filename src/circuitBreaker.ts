/**
 * Circuit breaker.
 *
 * WHY: when an upstream starts failing, hammering it with every request makes
 * things worse (retries pile up, connections exhaust, latency spikes ripple
 * back to callers). A breaker notices a run of failures and "opens" — for a
 * cooldown it rejects instantly instead of calling the sick upstream, giving it
 * room to recover. After the cooldown it goes "half-open" and lets a trial
 * request through; success closes it, failure re-opens it.
 *
 *   CLOSED    → calls flow; count failures. Threshold hit → OPEN.
 *   OPEN      → short-circuit immediately until cooldown elapses → HALF_OPEN.
 *   HALF_OPEN → one trial call. Success → CLOSED. Failure → OPEN.
 *
 * STUB/SCOPE: state is per-process. In a multi-node gateway each instance keeps
 * its own view, which is acceptable (each protects its own connection pool);
 * truly shared breaker state would need Redis and is out of scope for today.
 * Time is injected so the state machine is unit-testable without real waits.
 */

export type BreakerState = "closed" | "open" | "half_open";

export class CircuitOpenError extends Error {
  constructor() {
    super("circuit_open");
    this.name = "CircuitOpenError";
  }
}

export interface BreakerOptions {
  failureThreshold: number; // consecutive failures before opening
  cooldownMs: number; // how long to stay open before a trial
  now?: () => number; // injectable clock (defaults to Date.now)
}

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private readonly now: () => number;

  constructor(private readonly opts: BreakerOptions) {
    this.now = opts.now ?? Date.now;
  }

  get currentState(): BreakerState {
    return this.snapshotState(this.now());
  }

  /** Resolve time-based transitions (open → half_open) without a side effect. */
  private snapshotState(t: number): BreakerState {
    if (this.state === "open" && t - this.openedAt >= this.opts.cooldownMs) {
      return "half_open";
    }
    return this.state;
  }

  /**
   * Run `fn` under the breaker. Throws CircuitOpenError immediately if open.
   * Otherwise runs fn and records success/failure.
   */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const t = this.now();
    this.state = this.snapshotState(t);

    if (this.state === "open") {
      throw new CircuitOpenError();
    }

    // Half-open is a SINGLE-FLIGHT probe: exactly one request is allowed through
    // to test the upstream; everyone else is short-circuited until it resolves.
    // Without this guard, the instant the cooldown elapses every concurrent
    // request sees "half_open" and stampedes the still-fragile upstream — the
    // thundering-herd the breaker exists to prevent.
    if (this.state === "half_open") {
      if (this.trialInFlight) {
        throw new CircuitOpenError();
      }
      this.trialInFlight = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    // A successful trial in half-open (or any success) fully heals the breaker.
    this.consecutiveFailures = 0;
    this.state = "closed";
    this.trialInFlight = false;
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    // A failure while half-open, or crossing the threshold while closed, opens.
    if (
      this.state === "half_open" ||
      this.consecutiveFailures >= this.opts.failureThreshold
    ) {
      this.state = "open";
      this.openedAt = this.now();
    }
    this.trialInFlight = false;
  }
}
