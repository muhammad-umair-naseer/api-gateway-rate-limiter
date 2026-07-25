import Redis, { type RedisOptions } from "ioredis";

/**
 * Single place that knows how to construct a Redis client.
 *
 * `maxRetriesPerRequest: null` + `enableReadyCheck` keep the client honest under
 * load: commands wait for a live connection rather than exploding mid-benchmark.
 * REDIS_URL lets the same code point at a local server, CI, or a container.
 */
export function createRedis(options: RedisOptions = {}): Redis {
  const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  return new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
    ...options,
  });
}
