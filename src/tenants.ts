/**
 * Per-tenant quota configuration.
 *
 * STUB: in a real gateway these rows come from a control-plane DB / config
 * service and are hot-reloaded. Here they are hardcoded — auth, tenant
 * onboarding, and plan management are deliberately out of scope for the slice.
 * The rate-limiting mechanism does not care where this map comes from.
 */
export interface TenantQuota {
  /** Max tokens the bucket can hold (burst ceiling). */
  capacity: number;
  /** Tokens refilled per second (sustained rate). */
  refillRate: number;
  /**
   * Shared secret for HMAC request signing.
   * STUB: real secrets would live in a KMS / secret store, rotated regularly —
   * never checked into source. Hardcoded here so the signing demo is runnable.
   */
  secret: string;
}

export const TENANTS: Record<string, TenantQuota> = {
  // Generous paid tenant: 100 burst, 50/s sustained.
  acme: { capacity: 100, refillRate: 50, secret: "acme-secret-do-not-ship" },
  // Free tier: small burst, slow refill.
  free: { capacity: 5, refillRate: 1, secret: "free-secret-do-not-ship" },
  // Test tenant used by the concurrency proof: refillRate 0 freezes the bucket
  // so exactly `capacity` requests may ever pass — no refill noise in asserts.
  proof: { capacity: 100, refillRate: 0, secret: "proof-secret-do-not-ship" },
};

export function getTenant(tenantId: string): TenantQuota | undefined {
  return TENANTS[tenantId];
}
