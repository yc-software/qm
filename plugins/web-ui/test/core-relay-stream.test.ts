import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const secret = "relay-stream-test";
let releaseTail: (() => void) | undefined;
let heldClosed: (() => void) | undefined;
const seen: { method?: string; acceptEncoding?: string; body: string }[] = [];
const core = createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method, acceptEncoding: req.headers["accept-encoding"], body });
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"sessions":[');
    res.once("close", () => heldClosed?.());
    releaseTail = () => res.end("]}");
  });
}).listen(0, "127.0.0.1");
await once(core, "listening");
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = secret;
process.env.WEB_UI_PRINCIPALS = "alice";
const { handler } = await import("../server/index.ts");
const web = createServer((req, res) => void handler(req, res)).listen(0, "127.0.0.1");
await once(web, "listening");
test.after(() => {
  releaseTail?.();
  web.closeAllConnections();
  web.close();
  core.closeAllConnections();
  core.close();
});

function get(path: string, headers: Record<string, string>): Promise<IncomingMessage> {
  const token = mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, secret);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: (web.address() as AddressInfo).port, path }, resolve);
    req.setHeader(PORTAL_IDENTITY_HEADER, token);
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    req.on("error", reject);
    req.end();
  });
}

async function collect(res: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

test("a relayed core read streams the first core bytes before core finishes the body", { timeout: 5_000 }, async () => {
  const res = await get("/api/composio/slack", {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/json");
  assert.equal(seen.at(-1)?.acceptEncoding, "identity");
  const [first] = (await once(res, "data")) as [Buffer];
  assert.equal(first.toString(), '{"sessions":[');
  releaseTail!();
  const rest = await collect(res);
  assert.equal(first.toString() + rest.toString(), '{"sessions":[]}');
});

test("a browser that leaves mid-body closes the core response too", { timeout: 5_000 }, async () => {
  const closed = new Promise<void>((resolve) => (heldClosed = resolve));
  const res = await get("/api/composio/slack", {});
  await once(res, "data");
  res.destroy();
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("core response still open")), 500)),
  ]);
});
