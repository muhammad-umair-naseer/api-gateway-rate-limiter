/**
 * `npm run bench` — measures the atomic limiter's decision latency under load.
 *
 * Fires TOTAL requests through the token bucket with CONC in flight at once and
 * reports p50/p95/p99 latency and throughput. This is the hot path a real
 * gateway adds to every request, so its tail latency is what matters.
 *
 *   N=20000 C=50 npm run bench
 */
import { performance } from "node:perf_hooks";
import { createRedis } from "../src/redis.js";
import { RateLimiter } from "../src/rateLimiter.js";

const TOTAL = Number(process.env.N ?? 20_000);
const CONC = Number(process.env.C ?? 50);

const redis = createRedis();
const limiter = new RateLimiter(redis);

async function main() {
  await redis.del("rl:bench");

  // Warm up: register the script (EVALSHA cache) and JIT before we measure.
  for (let i = 0; i < 500; i++) await limiter.consume("bench");

  const latencies = new Float64Array(TOTAL);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= TOTAL) return;
      const t0 = performance.now();
      await limiter.consume("bench");
      latencies[i] = performance.now() - t0;
    }
  }

  const start = performance.now();
  await Promise.all(Array.from({ length: CONC }, worker));
  const elapsedMs = performance.now() - start;

  const sorted = Array.from(latencies).sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  const throughput = TOTAL / (elapsedMs / 1000);

  const bar = "─".repeat(52);
  console.log(bar);
  console.log(`atomic token bucket — ${TOTAL} requests, concurrency ${CONC}`);
  console.log(bar);
  console.log(`throughput   ${Math.round(throughput).toLocaleString()} req/s`);
  console.log(`latency p50  ${pct(50).toFixed(3)} ms`);
  console.log(`latency p95  ${pct(95).toFixed(3)} ms`);
  console.log(`latency p99  ${pct(99).toFixed(3)} ms`);
  console.log(`latency max  ${sorted[sorted.length - 1]!.toFixed(3)} ms`);
  console.log(bar);

  await redis.quit();
}

main();
