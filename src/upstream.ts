/**
 * STUB upstream service.
 *
 * A real gateway proxies to actual backends. Here the "upstream" is an in-process
 * function that just echoes and sleeps a hair to mimic work. A global failure
 * toggle lets the demo/tests flip it to unhealthy so the circuit breaker has
 * something to trip on. None of the gateway logic depends on this being real.
 */

let healthy = true;

export function setUpstreamHealthy(v: boolean): void {
  healthy = v;
}

export interface UpstreamResponse {
  status: number;
  body: unknown;
}

export async function callUpstream(
  tenantId: string,
  path: string,
): Promise<UpstreamResponse> {
  // Simulate a little I/O latency.
  await new Promise((r) => setTimeout(r, 2));
  if (!healthy) {
    throw new Error("upstream_unavailable");
  }
  return { status: 200, body: { ok: true, tenantId, path, upstream: "stub" } };
}
