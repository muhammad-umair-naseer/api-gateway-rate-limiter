import { describe, expect, it } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "../src/circuitBreaker.js";

/** Controllable clock so we can test cooldown transitions without real waits. */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const boom = () => Promise.reject(new Error("upstream down"));
const ok = () => Promise.resolve("ok");

describe("CircuitBreaker", () => {
  it("opens after the failure threshold, then short-circuits fast", async () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: clock.now });

    for (let i = 0; i < 3; i++) {
      await expect(cb.exec(boom)).rejects.toThrow("upstream down");
    }
    expect(cb.currentState).toBe("open");

    // While open it rejects WITHOUT calling the upstream.
    let called = false;
    await expect(
      cb.exec(async () => {
        called = true;
        return "should not run";
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });

  it("half-opens after cooldown and closes on a successful trial", async () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: clock.now });

    await expect(cb.exec(boom)).rejects.toThrow();
    expect(cb.currentState).toBe("open");

    clock.advance(1000); // cooldown elapses
    expect(cb.currentState).toBe("half_open");

    await expect(cb.exec(ok)).resolves.toBe("ok"); // trial succeeds
    expect(cb.currentState).toBe("closed");
  });

  it("re-opens if the half-open trial fails", async () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: clock.now });

    await expect(cb.exec(boom)).rejects.toThrow();
    clock.advance(1000);
    await expect(cb.exec(boom)).rejects.toThrow(); // trial fails
    expect(cb.currentState).toBe("open");
  });
});
