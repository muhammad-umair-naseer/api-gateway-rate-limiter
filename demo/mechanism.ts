/**
 * `npm run demo` — proves the atomicity is load-bearing, in plain sight.
 *
 * Fires N concurrent requests at a frozen bucket of capacity C through BOTH
 * limiters and applies the SAME assertion — "exactly C admitted" — to each.
 *
 *   Atomic Lua path : passes. Exactly C, every round.
 *   Naive JS path   : fails.  Over-admits, because read/decide/write is a race.
 *
 * Same test, atomic mechanism removed, race returns. Exits non-zero if the
 * atomic path ever misses OR the naive path fails to over-admit (i.e. if the
 * demo stopped demonstrating anything).
 */
import { createRedis } from "../src/redis.js";
import { RateLimiter } from "../src/rateLimiter.js";
import { NaiveRateLimiter } from "../src/rateLimiterNaive.js";

const CAPACITY = 100;
const N = 500;
const ROUNDS = 5;

async function fire(
  consume: () => Promise<{ allowed: boolean }>,
  n: number,
): Promise<number> {
  const results = await Promise.all(Array.from({ length: n }, () => consume()));
  return results.filter((r) => r.allowed).length;
}

const redis = createRedis();
const atomic = new RateLimiter(redis);
const naive = new NaiveRateLimiter(redis);

const bar = "─".repeat(64);
console.log(bar);
console.log(
  `Firing ${N} CONCURRENT requests at a frozen bucket of capacity ${CAPACITY}`,
);
console.log(`Correct behaviour: EXACTLY ${CAPACITY} allowed, ${N - CAPACITY} denied.`);
console.log(bar);

let atomicOk = true;
let naiveOverAdmitted = false;

for (let round = 1; round <= ROUNDS; round++) {
  await redis.del("rl:proof");
  const a = await fire(() => atomic.consume("proof"), N);

  await redis.del("rl:naive:proof");
  const nve = await fire(() => naive.consume("proof"), N);

  const aVerdict = a === CAPACITY ? "PASS" : "FAIL";
  const nVerdict = nve === CAPACITY ? "PASS" : "FAIL";
  if (a !== CAPACITY) atomicOk = false;
  if (nve > CAPACITY) naiveOverAdmitted = true;

  console.log(
    `round ${round}  ` +
      `atomic(Lua): ${String(a).padStart(3)} → ${aVerdict}   ` +
      `naive(JS): ${String(nve).padStart(3)} → ${nVerdict}` +
      (nve > CAPACITY ? `  (over by ${nve - CAPACITY})` : ""),
  );
}

console.log(bar);
console.log(
  atomicOk
    ? "✅ ATOMIC path held the quota exactly, every round."
    : "❌ ATOMIC path missed — that should never happen.",
);
console.log(
  naiveOverAdmitted
    ? "❌ NAIVE path over-admitted — the check-then-act race is real, and the\n" +
        "   Lua atomicity is the only thing preventing it."
    : "⚠️  NAIVE path did not over-admit this run (try more concurrency).",
);
console.log(bar);

await redis.quit();

// The demo is only meaningful if atomic holds AND naive breaks.
process.exit(atomicOk && naiveOverAdmitted ? 0 : 1);
