import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Redis from "ioredis";
import { getTenant, type TenantQuota } from "./tenants.js";

const LUA = readFileSync(
  fileURLToPath(new URL("./lua/token_bucket.lua", import.meta.url)),
  "utf8",
);

export interface RateLimitResult {
  allowed: boolean;
  /** Tokens left in the bucket after this request. */
  remaining: number;
  /** Milliseconds until the caller could succeed (0 when allowed). */
  retryAfterMs: number;
}

/** ioredis exposes registered scripts as methods; declare the shape we added. */
interface RedisWithBucket extends Redis {
  tokenBucket(
    key: string,
    capacity: number | string,
    refillRate: number | string,
    cost: number | string,
  ): Promise<[number, number, number]>;
}

/**
 * The atomic distributed token bucket.
 *
 * All correctness lives in token_bucket.lua; this class is a thin, typed façade:
 * it registers the script once (ioredis then invokes it via EVALSHA and
 * transparently falls back to EVAL on NOSCRIPT) and maps tenant IDs to quotas.
 */
export class RateLimiter {
  private readonly redis: RedisWithBucket;

  constructor(redis: Redis, keyPrefix = "rl") {
    this.redis = redis as RedisWithBucket;
    this.keyPrefix = keyPrefix;
    // Register the script as a custom command exactly once per client.
    if (!(this.redis as unknown as Record<string, unknown>).tokenBucket) {
      this.redis.defineCommand("tokenBucket", { numberOfKeys: 1, lua: LUA });
    }
  }

  private readonly keyPrefix: string;

  private key(tenantId: string): string {
    return `${this.keyPrefix}:${tenantId}`;
  }

  /**
   * Consume `cost` tokens for `tenantId`. The entire refill+check+consume runs
   * inside Redis as one atomic step, so this is safe under any concurrency and
   * across any number of processes.
   *
   * @throws if the tenant is unknown (no quota to enforce).
   */
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
    const [allowed, remaining, retryAfterMs] = await this.redis.tokenBucket(
      key,
      quota.capacity,
      quota.refillRate,
      cost,
    );
    return { allowed: allowed === 1, remaining, retryAfterMs };
  }
}

export class UnknownTenantError extends Error {
  constructor(public readonly tenantId: string) {
    super(`Unknown tenant: ${tenantId}`);
    this.name = "UnknownTenantError";
  }
}
