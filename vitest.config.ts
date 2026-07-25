import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The concurrency proof spins up real Redis and fires hundreds of parallel
    // requests; give it room and keep tests serial so buckets don't collide.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
