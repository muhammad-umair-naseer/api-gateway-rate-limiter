import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRedis } from "./redis.js";
import { Gateway } from "./gateway.js";

/**
 * Minimal HTTP surface over the gateway pipeline. Ugly-on-purpose: no router,
 * no framework. Every non-health request is:
 *
 *   read headers (x-tenant-id, x-timestamp, x-signature) + body
 *     -> Gateway.handle() -> write status/headers/json
 *
 * Signing headers are how a caller proves which tenant it is; see src/signing.ts
 * and tools/sign.ts for generating them.
 */

const redis = createRedis();
const gateway = new Gateway(redis, {
  degradation: (process.env.DEGRADATION as "fail_open" | "fail_closed") ?? "fail_open",
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const path = req.url ?? "/";

  if (path === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const body = await readBody(req);
  const response = await gateway.handle({
    tenantId: String(req.headers["x-tenant-id"] ?? ""),
    method: req.method ?? "GET",
    path,
    body,
    signature: String(req.headers["x-signature"] ?? ""),
    timestamp: Number(req.headers["x-timestamp"] ?? 0),
  });

  res.writeHead(response.status, response.headers);
  res.end(JSON.stringify(response.body));
});

const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => {
  console.log(`gateway listening on http://127.0.0.1:${port}`);
  console.log(`degradation policy: ${process.env.DEGRADATION ?? "fail_open"}`);
});
