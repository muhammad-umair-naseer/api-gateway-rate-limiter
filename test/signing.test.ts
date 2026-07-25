import { describe, expect, it } from "vitest";
import { sign, verify, type SignatureParts } from "../src/signing.js";

const SECRET = "top-secret";
const parts: SignatureParts = {
  tenantId: "acme",
  timestamp: 1_000_000,
  method: "GET",
  path: "/api/hello",
  body: "",
};

describe("HMAC request signing", () => {
  it("accepts a correct, fresh signature", () => {
    const sig = sign(SECRET, parts);
    expect(verify(SECRET, sig, parts, { now: parts.timestamp, toleranceMs: 30_000 })).toEqual({
      ok: true,
    });
  });

  it("rejects a signature made with the wrong secret (forged tenant)", () => {
    const forged = sign("wrong-secret", parts);
    const r = verify(SECRET, forged, parts, { now: parts.timestamp, toleranceMs: 30_000 });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects if any signed field is tampered with", () => {
    const sig = sign(SECRET, parts);
    const tampered = { ...parts, path: "/api/admin" };
    const r = verify(SECRET, sig, tampered, { now: parts.timestamp, toleranceMs: 30_000 });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a stale timestamp (replay defence)", () => {
    const sig = sign(SECRET, parts);
    const r = verify(SECRET, sig, parts, {
      now: parts.timestamp + 60_000,
      toleranceMs: 30_000,
    });
    expect(r).toEqual({ ok: false, reason: "stale" });
  });
});
