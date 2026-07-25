import type Redis from "ioredis";
import { getTenant, type TenantQuota } from "./tenants.js";
import type { RateLimitResult } from "./rateLimiter.js";
import { UnknownTenantError } from "./rateLimiter.js";

/**
 * DELIBERATELY BROKEN control group. Do not use in production — its only job is
 * to prove the atomic path earns its keep.
 *
 * It implements the identical token-bucket math as token_bucket.lua, but does
 * the read, the decide, and the write as THREE separate Redis round-trips from
 * the Node process. Between the HMGET and the HSET, other concurrent requests
 * read the same stale token count and all conclude "allowed". That is the
 * classic check-then-act race. Under parallel load this over-admits: more than
 * `capacity` requests pass. Phase 3 runs the same concurrency test against this
 * and against the Lua path — the diff is the whole point.
 */
export class NaiveRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix = "rl:naive",
  ) {}

  private key(tenantId: string): string {
    return `${this.keyPrefix}:${tenantId}`;
  }

  async consume(tenantId: string, cost = 1): Promise<RateLimitResult> {
    const quota = getTenant(tenantId);
    if (!quota) throw new UnknownTenantError(tenantId);
    return this.consumeWithQuota(this.key(tenantId), quota, cost);
  }

  private async consumeWithQuota(
    key: string,
    quota: TenantQuota,
    cost: number,
  ): Promise<RateLimitResult> {
    const now = Date.now() / 1000;

    // (1) READ — non-atomic. Every concurrent caller can land here together.
    const state = await this.redis.hmget(key, "tokens", "ts");
    let tokens = state[0] === null ? quota.capacity : Number(state[0]);
    const ts = state[1] === null ? now : Number(state[1]);

    // Same lazy-refill math as the Lua script.
    const elapsed = Math.max(0, now - ts);
    tokens = Math.min(quota.capacity, tokens + elapsed * quota.refillRate);

    // (2) DECIDE — on a value that may already be stale.
    let allowed = false;
    if (tokens >= cost) {
      allowed = true;
      tokens -= cost;
    }

    // (3) WRITE — the read from step 1 is long gone; last writer wins and the
    //     tokens it "consumed" were already handed out to someone else.
    await this.redis.hset(key, "tokens", tokens, "ts", now);

    const retryAfterMs =
      !allowed && quota.refillRate > 0
        ? Math.ceil(((cost - tokens) / quota.refillRate) * 1000)
        : 0;

    return { allowed, remaining: Math.floor(tokens), retryAfterMs };
  }
}
