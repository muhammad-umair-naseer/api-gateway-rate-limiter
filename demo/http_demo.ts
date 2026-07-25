/**
 * `npm run demo:http` — exercises the running gateway over real HTTP.
 * Start the server first:  npm start   (in another terminal)
 *
 * Shows: unsigned request rejected, forged-tenant request rejected, a valid
 * signed request served, and the free tier's quota kicking in (5 pass, rest 429).
 */
import { sign } from "../src/signing.js";
import { getTenant } from "../src/tenants.js";

const BASE = `http://127.0.0.1:${process.env.PORT ?? 8080}`;

async function send(
  tenantId: string,
  opts: { signAs?: string; path?: string; method?: string } = {},
): Promise<number> {
  const path = opts.path ?? "/api/hello";
  const method = opts.method ?? "GET";
  const timestamp = Date.now();
  const headers: Record<string, string> = { "x-tenant-id": tenantId };

  // Sign as `signAs` (defaults to the claimed tenant). Signing as the wrong
  // tenant simulates a forged x-tenant-id header.
  const signer = opts.signAs ?? tenantId;
  const secret = getTenant(signer)?.secret;
  if (secret) {
    headers["x-timestamp"] = String(timestamp);
    headers["x-signature"] = sign(secret, { tenantId, timestamp, method, path, body: "" });
  }

  const res = await fetch(`${BASE}${path}`, { method, headers });
  return res.status;
}

const line = (s: string) => console.log(s);

line("1. Unsigned request as 'acme'      -> " + (await send("acme", { signAs: "__none__" })) + " (expect 401)");
line("2. Forged: claim 'acme', sign 'free' -> " + (await send("acme", { signAs: "free" })) + " (expect 401)");
line("3. Valid signed 'acme'             -> " + (await send("acme")) + " (expect 200)");

line("4. Free tier quota (capacity 5):");
await fetch(`${BASE}/health`); // no-op to ensure server is warm
const codes: number[] = [];
for (let i = 0; i < 8; i++) codes.push(await send("free"));
line("   " + codes.map((c, i) => `#${i + 1}:${c}`).join("  "));
const passed = codes.filter((c) => c === 200).length;
line(`   -> ${passed} passed, ${codes.length - passed} throttled (expect 5 / 3)`);
