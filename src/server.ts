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

// Cap the request body: it is buffered in memory BEFORE auth, so without a limit
// an unauthenticated caller could exhaust memory by streaming an endless body.
const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = req.url ?? "/";

  if (path === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payload_too_large" }));
      return;
    }
    throw err;
  }

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
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  // The createServer callback's returned promise is neither awaited nor caught
  // by Node, so an unhandled rejection here (e.g. a client aborting mid-request)
  // would crash the whole process. Catch it and fail the one request instead.
  handle(req, res).catch((err) => {
    console.error("request handler error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error" }));
    } else {
      res.end();
    }
  });
});

// Last-resort guards so a stray rejection/exception is logged, not silently fatal.
process.on("unhandledRejection", (reason) => console.error("unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => {
  console.log(`gateway listening on http://127.0.0.1:${port}`);
  console.log(`degradation policy: ${process.env.DEGRADATION ?? "fail_open"}`);
});
