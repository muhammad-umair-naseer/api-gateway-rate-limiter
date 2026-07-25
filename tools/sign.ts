/**
 * tools/sign.ts — generate a signed request for the running gateway.
 *
 *   npx tsx tools/sign.ts <tenantId> [path] [method]
 *
 * Prints ready-to-run curl for the demo. Uses the tenant's hardcoded stub
 * secret from src/tenants.ts.
 */
import { getTenant } from "../src/tenants.js";
import { sign } from "../src/signing.js";

const [, , tenantId = "acme", path = "/api/hello", method = "GET"] = process.argv;

const tenant = getTenant(tenantId);
if (!tenant) {
  console.error(`unknown tenant: ${tenantId} (try acme, free)`);
  process.exit(1);
}

const timestamp = Date.now();
const body = "";
const signature = sign(tenant.secret, { tenantId, timestamp, method, path, body });
const port = process.env.PORT ?? "8080";

console.log(
  [
    `curl -sS -X ${method} http://127.0.0.1:${port}${path} \\`,
    `  -H 'x-tenant-id: ${tenantId}' \\`,
    `  -H 'x-timestamp: ${timestamp}' \\`,
    `  -H 'x-signature: ${signature}' \\`,
    `  -w '\\nHTTP %{http_code}\\n'`,
  ].join("\n"),
);
