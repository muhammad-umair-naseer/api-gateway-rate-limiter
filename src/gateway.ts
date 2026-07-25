import type Redis from "ioredis";
import { RateLimiter } from "./rateLimiter.js";
import { getTenant } from "./tenants.js";
import { verify } from "./signing.js";
import { CircuitBreaker, CircuitOpenError } from "./circuitBreaker.js";
import { callUpstream } from "./upstream.js";

/**
 * The gateway request pipeline, framework-free so it can be unit-tested without
 * a socket. Order matters and is deliberate:
 *
 *   1. resolve tenant        (who are you)
 *   2. verify HMAC signature (prove it — reject forged tenant headers/replays)
 *   3. rate limit            (per-tenant token bucket; degrade if Redis is down)
 *   4. circuit breaker       (protect a failing upstream)
 *   5. call upstream         (stub)
 *
 * Auth stops at step 2 by design: signing IS the authN for this slice. No login,
 * sessions, or user accounts — those are explicitly out of scope.
 */

export type DegradationPolicy = "fail_open" | "fail_closed";

export interface GatewayOptions {
  signatureToleranceMs?: number;
  /**
   * What to do if the rate-limiter backend (Redis) is unreachable.
   *  - fail_open:  allow the request. Favours availability; risks unbounded load.
   *  - fail_closed: deny the request. Favours protection; a Redis blip = outage.
   * Default fail_open: a rate limiter that takes the whole API down when its
   * bookkeeping store hiccups has inverted its own purpose. The tradeoff is
   * explicit so it can be flipped per deployment.
   */
  degradation?: DegradationPolicy;
  breaker?: { failureThreshold: number; cooldownMs: number };
  /** Injectable clock for signature freshness (tests). Defaults to Date.now. */
  now?: () => number;
}

export interface GatewayRequest {
  tenantId: string;
  method: string;
  path: string;
  body: string;
  signature: string;
  timestamp: number;
}

export interface GatewayResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export class Gateway {
  private readonly limiter: RateLimiter;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly signatureToleranceMs: number;
  private readonly degradation: DegradationPolicy;
  private readonly breakerOpts: { failureThreshold: number; cooldownMs: number };
  private readonly now: () => number;

  constructor(redis: Redis, opts: GatewayOptions = {}) {
    this.limiter = new RateLimiter(redis);
    this.signatureToleranceMs = opts.signatureToleranceMs ?? 30_000;
    this.degradation = opts.degradation ?? "fail_open";
    this.breakerOpts = opts.breaker ?? { failureThreshold: 5, cooldownMs: 5_000 };
    this.now = opts.now ?? Date.now;
  }

  private breakerFor(tenantId: string): CircuitBreaker {
    let b = this.breakers.get(tenantId);
    if (!b) {
      b = new CircuitBreaker({ ...this.breakerOpts, now: this.now });
      this.breakers.set(tenantId, b);
    }
    return b;
  }

  async handle(req: GatewayRequest): Promise<GatewayResponse> {
    // 1. Resolve tenant.
    const tenant = getTenant(req.tenantId);
    if (!tenant) {
      return json(401, { error: "unknown_tenant" });
    }

    // 2. Verify signature (authN + replay protection).
    const sig = verify(
      tenant.secret,
      req.signature,
      {
        tenantId: req.tenantId,
        timestamp: req.timestamp,
        method: req.method,
        path: req.path,
        body: req.body,
      },
      { now: this.now(), toleranceMs: this.signatureToleranceMs },
    );
    if (!sig.ok) {
      return json(401, { error: "invalid_signature", reason: sig.reason });
    }

    // 3. Rate limit — with graceful degradation if Redis is unreachable.
    let allowed: boolean;
    let remaining = -1;
    let retryAfterMs = 0;
    let degraded = false;
    try {
      const rl = await this.limiter.consume(req.tenantId);
      allowed = rl.allowed;
      remaining = rl.remaining;
      retryAfterMs = rl.retryAfterMs;
    } catch {
      // Redis is down. Apply the configured policy instead of crashing.
      degraded = true;
      allowed = this.degradation === "fail_open";
    }

    if (!allowed && !degraded) {
      return {
        status: 429,
        body: { error: "rate_limited" },
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": String(remaining),
          "retry-after-ms": String(retryAfterMs),
        },
      };
    }
    if (!allowed && degraded) {
      return json(503, { error: "rate_limiter_unavailable" }, { "x-degraded": "true" });
    }

    // 4 + 5. Call the (stub) upstream behind the tenant's circuit breaker.
    try {
      const up = await this.breakerFor(req.tenantId).exec(() =>
        callUpstream(req.tenantId, req.path),
      );
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-ratelimit-remaining": String(remaining),
      };
      if (degraded) headers["x-degraded"] = "true";
      return { status: up.status, body: up.body, headers };
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        return json(503, { error: "upstream_circuit_open" });
      }
      return json(502, { error: "upstream_error" });
    }
  }
}

function json(
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): GatewayResponse {
  return { status, body, headers: { "content-type": "application/json", ...extra } };
}
