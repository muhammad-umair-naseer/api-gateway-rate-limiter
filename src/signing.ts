import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC request signing.
 *
 * WHY A GATEWAY NEEDS THIS: rate limits and quotas are keyed by tenant. If a
 * caller can simply set `x-tenant-id: acme`, they can spend Acme's quota or
 * dodge their own. Signing binds the request to a secret only the real tenant
 * holds: the server recomputes the HMAC and compares. No secret, no valid
 * signature, no service.
 *
 * The signature covers a timestamp too, so a captured request can't be replayed
 * forever — the server rejects anything outside a freshness window.
 *
 * We compare with timingSafeEqual so an attacker can't recover the expected
 * signature byte-by-byte by measuring how long the comparison takes.
 */

export interface SignatureParts {
  tenantId: string;
  timestamp: number; // ms since epoch
  method: string;
  path: string;
  body: string;
}

/** Canonical string that both sides hash. Order and separators are fixed. */
function canonical(p: SignatureParts): string {
  return [p.timestamp, p.method.toUpperCase(), p.path, p.body].join("\n");
}

export function sign(secret: string, p: SignatureParts): string {
  return createHmac("sha256", secret).update(canonical(p)).digest("hex");
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "stale" | "bad_signature" };

export function verify(
  secret: string,
  provided: string,
  p: SignatureParts,
  opts: { now: number; toleranceMs: number },
): VerifyResult {
  // Replay defence: reject timestamps too far from now (either direction).
  if (Math.abs(opts.now - p.timestamp) > opts.toleranceMs) {
    return { ok: false, reason: "stale" };
  }

  const expected = sign(secret, p);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  // Length check first: timingSafeEqual throws on length mismatch, and unequal
  // lengths already mean the signature is wrong.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}
