import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

process.env.CORE_SIGNING_SECRET = "voice-route-test";
process.env.WEB_UI_PUBLIC_URL = "https://qm.example.test";
process.env.WEB_UI_VOICE_USERS = "alice";
process.env.OPENAI_API_KEY = "voice-test-key";
const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const identity = (user = "alice") => ({
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: user, exp: Date.now() + 60_000 }, "voice-route-test"),
});
const headers = { ...identity(), "content-type": "application/json", origin: "https://qm.example.test" };
const offer = JSON.stringify({ sdp: "v=0\r\no=offer" });
test.after(() => {
  surface.close();
});

test("voice route authenticates and gates accounts before spending", async () => {
  assert.equal((await fetch(`${base}/api/voice/sessions`, { method: "POST", body: offer })).status, 401);
  assert.equal(
    (
      await fetch(`${base}/api/voice/sessions`, {
        method: "POST",
        headers: { ...headers, ...identity("bob") },
        body: offer,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(`${base}/api/voice/sessions`, {
        method: "POST",
        headers: { ...headers, origin: "https://evil.test" },
        body: offer,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${base}/api/voice/sessions`, {
        method: "POST",
        headers: { cookie: "webuiuser=alice", [PORTAL_IDENTITY_HEADER]: "forged" },
        body: offer,
      })
    ).status,
    403,
  );
  const rejectedRequests: Record<string, string>[] = [
    { ...headers, origin: "null" },
    {
      cookie: "webuiuser=alice",
      [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() - 60_000 }, "voice-route-test"),
    },
  ];
  for (const rejectedHeaders of rejectedRequests) {
    assert.equal(
      (await fetch(`${base}/api/voice/sessions`, { method: "POST", headers: rejectedHeaders, body: offer })).status,
      403,
    );
  }
  const capability = await fetch(`${base}/api/voice`, { headers: identity() });
  assert.deepEqual(await capability.json(), { enabled: true, model: "gpt-live-1" });
  assert.equal(capability.headers.get("cache-control"), "no-store");
});

test("voice rejects invalid and oversized offers", async () => {
  for (const body of ["{", "null", "[]", "{}", JSON.stringify({ sdp: "bad" })]) {
    assert.equal((await fetch(`${base}/api/voice/sessions`, { method: "POST", headers, body })).status, 400);
  }
  assert.equal(
    (
      await fetch(`${base}/api/voice/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sdp: "v=0" + "x".repeat(70_000) }),
      })
    ).status,
    413,
  );
});

test("voice relays only a sanitized SDP result and never a provider key", async (t) => {
  const actualFetch = globalThis.fetch;
  let providerCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== "https://api.openai.com/v1/live/sessions") return actualFetch(input, init);
    providerCalls++;
    return Response.json({
      session: { id: "live_route" },
      transport: { type: "webrtc", sdp: "v=0\r\no=answer" },
      api_key: "must-not-leak",
    });
  });
  const response = await fetch(`${base}/api/voice/sessions`, { method: "POST", headers: identity(), body: offer });
  assert.equal(response.status, 201);
  assert.equal(providerCalls, 1);
  assert.deepEqual(await response.json(), {
    session: { id: "live_route" },
    transport: { type: "webrtc", sdp: "v=0\r\no=answer" },
  });
});
