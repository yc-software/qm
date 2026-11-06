import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const core = createServer((req: IncomingMessage, res) => {
  const u = req.url ?? "";
  if (u.includes("/v1/files/cut-off/")) {
    res.writeHead(200, { "content-type": "application/pdf" });
    res.write("x".repeat(64 * 1024));
    return void setTimeout(() => res.socket?.destroy(), 20);
  }
  if (u.includes("/v1/files/cut-off-html/")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.write("<html>".padEnd(64 * 1024, " "));
    return void setTimeout(() => res.socket?.destroy(), 20);
  }
  if (u.includes("/v1/files/whole/")) {
    res.writeHead(200, { "content-type": "application/pdf" });
    return void res.end("%PDF-1.4 fine");
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((r) => core.listen(0, r));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "file-content-abort-test-secret";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

const uncaught: unknown[] = [];
const onUncaught = (e: unknown): void => void uncaught.push(e);
process.on("uncaughtException", onUncaught);

test.after(() => {
  process.off("uncaughtException", onUncaught);
  surface.close();
  core.close();
});

const headers = { cookie: "webuiuser=alice" };

async function readCutOff(path: string): Promise<void> {
  const r = await fetch(`${base}${path}`, { headers });
  assert.equal(r.status, 200);
  await assert.rejects(r.arrayBuffer(), "the truncated body surfaces to the client as a failed download");
}

test(
  "core dropping a file body mid-stream fails only that response and leaves the server serving",
  { timeout: 10_000 },
  async () => {
    await readCutOff("/api/files/cut-off/content");
    await readCutOff("/api/playgrounds/cut-off-html");
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(uncaught, [], "no uncaught exception escapes the file relay");
    const ok = await fetch(`${base}/api/files/whole/content`, { headers });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "%PDF-1.4 fine");
  },
);
