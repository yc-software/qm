import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";

const SECRET = "core-signing-secret".repeat(3);
const TENANT_A = "3f1c7a52-9d4e-4b8a-a6f0-2c5e8d1b7a93";
const TENANT_B = "8a2d4c6e-1b3f-4a5c-9e7d-0f2b4d6a8c1e";
const viewerLookups: string[] = [];
const core = createServer((req, res) => {
  if (req.method === "POST" && req.url?.startsWith("/v1/inbox/viewers")) {
    viewerLookups.push(String(req.headers["x-qm-tenant"]));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ viewers: ["alice"] }));
    return;
  }
  res.writeHead(404);
  res.end();
});
core.listen(0);
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "";
const { handler, forwardSessionState, forwardInboxItem } = await import("../plugins/web-ui/server/index.ts");
const web = createServer(handler);
web.listen(0);
const webBase = `http://localhost:${(web.address() as AddressInfo).port}`;
const controller = new AbortController();

after(async () => {
  controller.abort();
  await new Promise<void>((r) => web.close(() => r()));
  await new Promise<void>((r) => core.close(() => r()));
});

async function openFeed(tenant: string) {
  const res = await fetch(`${webBase}/api/deliveries/events`, {
    headers: {
      cookie: "webuiuser=alice",
      [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", t: tenant, exp: Date.now() + 60_000 }, SECRET),
    },
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: string[] = [];
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const name = frame.split("\n").find((line) => line.startsWith("event: "));
        if (name) events.push(`${name.slice("event: ".length)} ${frame.split("data: ")[1] ?? ""}`);
      }
    }
  })();
  return events;
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 200));
}

test("one person signed in to two tenants hears each tenant's session states and inbox items only there", async () => {
  const inA = await openFeed(TENANT_A);
  const inB = await openFeed(TENANT_B);
  forwardSessionState({ tenantId: TENANT_A, threadRef: "web:alice:t1", participants: ["alice"], state: "working" });
  await forwardInboxItem({ tenantId: TENANT_B, loopId: "loop-b", itemId: "item-b", op: "ingest" });
  await settle();
  assert.deepEqual(inA, ['session_state {"threadRef":"web:alice:t1","state":"working"}']);
  assert.deepEqual(inB, ['inbox_item {"loopId":"loop-b","itemId":"item-b","op":"ingest"}']);
  assert.deepEqual(viewerLookups, [TENANT_B]);
});
