import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { createRedis } from "../src/redis.js";
import { Gateway, type GatewayRequest } from "../src/gateway.js";
import { sign } from "../src/signing.js";
import { getTenant } from "../src/tenants.js";
import { setUpstreamHealthy } from "../src/upstream.js";

const redis = createRedis();

/** Build a correctly-signed request for a tenant. */
function signed(tenantId: string, path = "/api/x"): GatewayRequest {
  const timestamp = Date.now();
  const secret = getTenant(tenantId)!.secret;
  return {
    tenantId,
    method: "GET",
    path,
    body: "",
    timestamp,
    signature: sign(secret, { tenantId, timestamp, method: "GET", path, body: "" }),
  };
}

afterAll(async () => {
  await redis.quit();
});

beforeEach(async () => {
  setUpstreamHealthy(true);
  await redis.del("rl:free", "rl:acme");
});

describe("gateway: signing", () => {
  it("rejects unknown tenant", async () => {
    const gw = new Gateway(redis);
    const res = await gw.handle({ ...signed("acme"), tenantId: "nope" });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "unknown_tenant" });
  });

  it("rejects a request signed with the wrong secret", async () => {
    const gw = new Gateway(redis);
    const req = signed("acme");
    req.signature = sign("wrong", { ...req }); // forged
    const res = await gw.handle(req);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "invalid_signature" });
  });

  it("serves a valid signed request", async () => {
    const gw = new Gateway(redis);
    const res = await gw.handle(signed("acme"));
    expect(res.status).toBe(200);
  });
});

describe("gateway: rate limiting", () => {
  it("throttles the free tier after its quota (5), returning 429", async () => {
    const gw = new Gateway(redis);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await gw.handle(signed("free"))).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(3);
  });
});

describe("gateway: circuit breaker", () => {
  it("trips to 503 after the upstream fails past the threshold", async () => {
    const gw = new Gateway(redis, { breaker: { failureThreshold: 3, cooldownMs: 10_000 } });
    setUpstreamHealthy(false);

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await gw.handle(signed("acme"))).status);

    // First 3 hit the (failing) upstream → 502. Then the breaker opens → 503.
    expect(statuses.slice(0, 3)).toEqual([502, 502, 502]);
    expect(statuses.slice(3)).toEqual([503, 503]);
  });
});

describe("gateway: graceful degradation when Redis is down", () => {
  /** A client pointed at a dead port: commands reject instead of hanging. */
  function brokenRedis(): Redis {
    const r = new Redis({
      host: "127.0.0.1",
      port: 6390,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    r.on("error", () => {}); // swallow connection noise
    return r;
  }

  it("fail_open: serves the request (200) and flags it degraded", async () => {
    const r = brokenRedis();
    const gw = new Gateway(r, { degradation: "fail_open" });
    const res = await gw.handle(signed("acme"));
    expect(res.status).toBe(200);
    expect(res.headers["x-degraded"]).toBe("true");
    r.disconnect();
  });

  it("fail_closed: refuses the request with 503", async () => {
    const r = brokenRedis();
    const gw = new Gateway(r, { degradation: "fail_closed" });
    const res = await gw.handle(signed("acme"));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "rate_limiter_unavailable" });
    r.disconnect();
  });
});
