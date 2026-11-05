import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const core = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ branding: {} }));
});
await new Promise<void>((r) => core.listen(0, r));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "web-ui-build-stamp-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const distIndex = join(dirname(fileURLToPath(import.meta.url)), "..", "dist-web", "index.html");
if (!existsSync(distIndex)) {
  mkdirSync(dirname(distIndex), { recursive: true });
  writeFileSync(distIndex, "<!doctype html><html><head><title>QM · Web</title></head><body></body></html>");
}
const build = createHash("sha256").update(readFileSync(distIndex)).digest("hex").slice(0, 16);

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

test("API responses and the shell carry the build the server is serving", async () => {
  const signedIn = { headers: { cookie: "webuiuser=alice" } };
  const relayed = await fetch(`${base}/api/surface-config`, signedIn);
  assert.equal(relayed.status, 200);
  assert.equal(relayed.headers.get("x-qm-web-build"), build);
  const unauthenticated = await fetch(`${base}/api/surface-config`);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("x-qm-web-build"), build);
  const shell = await fetch(`${base}/`, signedIn);
  assert.equal(shell.headers.get("x-qm-web-build"), build);
  assert.match(await shell.text(), new RegExp(`<meta name="qm-web-build" content="${build}" />`));
});
