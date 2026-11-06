import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const turns: Record<string, unknown>[] = [];
const signals: Record<string, unknown>[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    if (req.method === "POST" && req.url?.startsWith("/v1/turns"))
      turns.push(JSON.parse(raw) as Record<string, unknown>);
    if (req.method === "POST" && req.url?.includes("/signal")) signals.push(JSON.parse(raw) as Record<string, unknown>);
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "queued", runId: `run-${turns.length}` }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "turn-client-surface-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => {
  void handler(req, res).catch(() => {
    res.writeHead(502);
    res.end();
  });
});
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

function asAlice(headers: Record<string, string>): Record<string, string> {
  return {
    [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "turn-client-surface-test"),
    "content-type": "application/json",
    ...headers,
  };
}

async function sentSurface(headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: asAlice(headers),
    body: JSON.stringify({ text: "hello", threadRef: "web:alice:default" }),
  });
  assert.equal(response.status, 202);
  return turns.at(-1)?.clientSurface;
}

const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const QM_IOS = "QM/42 CFNetwork/3826.500.62 Darwin/25.0.0";

test("each web turn records the client surface the client declared", async () => {
  assert.equal(await sentSurface({ "x-qm-client": "ios", "user-agent": SAFARI_IPHONE }), "ios");
  assert.equal(await sentSurface({ "x-qm-client": "desktop", "user-agent": SAFARI_IPHONE }), "desktop");
  assert.equal(await sentSurface({ "x-qm-client": "browser", "user-agent": QM_IOS }), "browser");
});

test("iOS app builds that declare nothing are recognised by their user agent", async () => {
  assert.equal(await sentSurface({ "user-agent": QM_IOS }), "ios");
  assert.equal(await sentSurface({ "x-qm-client": "watch", "user-agent": QM_IOS }), "ios");
  assert.equal(await sentSurface({ "user-agent": SAFARI_IPHONE }), "browser");
});

test("a steer carries the client surface it was sent from", async () => {
  const response = await fetch(`${base}/api/runs/run-1/signal`, {
    method: "POST",
    headers: asAlice({ "x-qm-client": "ios" }),
    body: JSON.stringify({ kind: "steer", text: "left", threadRef: "web:alice:default" }),
  });
  assert.equal(response.status, 202);
  assert.equal((signals.at(-1)!.request as { clientSurface?: string }).clientSurface, "ios");
});
