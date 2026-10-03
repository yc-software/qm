import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const core = createServer((req: IncomingMessage, res) => {
  const u = req.url ?? "";
  if (u.startsWith("/v1/files/")) {
    res.writeHead(200, {
      "content-type": u.includes("/v1/files/page/") ? "text/html" : "application/pdf",
      "content-length": "1000000",
    });
    res.write(Buffer.alloc(1000, 0x41));
    setTimeout(() => res.socket?.destroy(), 50);
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((r) => core.listen(0, r));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "file-stream-error-secret";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

for (const path of ["/api/files/doc/content", "/api/playgrounds/page"]) {
  test(`core dropping a file stream mid-body ends the response without crashing the web UI (${path})`, async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      const r = await fetch(`${base}${path}`, {
        headers: { cookie: "webuiuser=alice" },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(r.status, 200);
      await assert.rejects(r.arrayBuffer());
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(uncaught.map(String), []);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
}
