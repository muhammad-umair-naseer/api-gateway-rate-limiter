import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type Redis from "ioredis";
import { createRedis } from "../src/redis.js";
import { RateLimiter } from "../src/rateLimiter.js";
import { NaiveRateLimiter } from "../src/rateLimiterNaive.js";

/**
 * THE PROOF.
 *
 * The "proof" tenant has capacity=100, refillRate=0 (frozen), so across an
 * entire test run exactly 100 requests may ever be admitted — no refill noise.
 * We fire N=500 requests CONCURRENTLY (all in flight before any resolves) and
 * assert the bucket admitted exactly the quota.
 *
 * - The atomic Lua limiter must pass this every time, over many rounds.
 * - The naive limiter (same math, but read/decide/write as separate round-trips)
 *   must FAIL it by over-admitting — that failure is the evidence that the
 *   atomicity is load-bearing, not decoration.
 */

const CAPACITY = 100;
const N = 500;
const ROUNDS = 20;

let redis: Redis;

function fresh(): Promise<Redis> {
  return Promise.resolve((redis ??= createRedis()));
}

afterAll(async () => {
  await redis?.quit();
});

/** Fire `n` consume() calls truly concurrently and tally how many were allowed. */
async function fireConcurrent(
  consume: () => Promise<{ allowed: boolean }>,
  n: number,
): Promise<number> {
  const results = await Promise.all(Array.from({ length: n }, () => consume()));
  return results.filter((r) => r.allowed).length;
}

describe("atomic Lua token bucket", () => {
  beforeEach(async () => {
    await fresh();
    await redis.del("rl:proof");
  });

  it(`admits EXACTLY the quota under ${N}-way concurrency, ${ROUNDS}x`, async () => {
    const limiter = new RateLimiter(redis);

    for (let round = 0; round < ROUNDS; round++) {
      await redis.del("rl:proof");
      const allowed = await fireConcurrent(() => limiter.consume("proof"), N);

      // The whole point: not "about 100", EXACTLY 100. No over-admission,
      // no under-admission, no matter how the 500 requests interleave.
      expect(allowed, `round ${round}`).toBe(CAPACITY);
    }
  });

  it("frozen bucket (refillRate=0) never expires, so an emptied budget can't resurrect", async () => {
    const limiter = new RateLimiter(redis);
    await redis.del("rl:proof");
    await limiter.consume("proof");

    // A refillRate=0 bucket must persist forever; if it got a TTL it would
    // expire, re-init to full, and silently hand out a second full budget.
    expect(await redis.ttl("rl:proof")).toBe(-1); // -1 = key exists, no expiry
  });
});

describe("naive non-atomic limiter (control group)", () => {
  beforeEach(async () => {
    await fresh();
    await redis.del("rl:naive:proof");
  });

  it(`OVER-ADMITS under ${N}-way concurrency (race is real)`, async () => {
    const naive = new NaiveRateLimiter(redis);

    // Take the worst round: with 500 requests each doing read->decide->write as
    // separate hops, many read the same stale token count and all say "yes".
    let maxAllowed = 0;
    for (let round = 0; round < 5; round++) {
      await redis.del("rl:naive:proof");
      const allowed = await fireConcurrent(() => naive.consume("proof"), N);
      maxAllowed = Math.max(maxAllowed, allowed);
    }

    // If atomicity didn't matter, this would also cap at CAPACITY. It doesn't.
    expect(maxAllowed).toBeGreaterThan(CAPACITY);
  });

  it("is CORRECT when called sequentially — proving only atomicity, not the math, differs", async () => {
    // This isolates the variable. The naive limiter runs the identical
    // token-bucket arithmetic as the Lua script; called one-at-a-time (no
    // overlapping read/decide/write windows) it admits EXACTLY the quota, same
    // as the atomic path. So the over-admission above is caused solely by the
    // check-then-act race under concurrency — not by a different or buggy
    // formula. That is what makes it a fair control group.
    const naive = new NaiveRateLimiter(redis);
    await redis.del("rl:naive:proof");

    let allowed = 0;
    for (let i = 0; i < N; i++) {
      if ((await naive.consume("proof")).allowed) allowed++;
    }
    expect(allowed).toBe(CAPACITY);
  });
});
