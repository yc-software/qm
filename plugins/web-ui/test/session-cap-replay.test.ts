import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const seenSignatures = new Set<string>();
let sessionCapMints = 0;
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const u = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && u.startsWith("/v1/session-cap")) {
      sessionCapMints++;
      const signature = String(req.headers["x-signature"] ?? "");
      if (seenSignatures.has(signature)) {
        res.writeHead(401);
        return void res.end(JSON.stringify({ error: "unauthorized", message: "duplicate event (already processed)" }));
      }
      seenSignatures.add(signature);
      res.writeHead(200);
      return void res.end(JSON.stringify({ token: `cap-${sessionCapMints}` }));
    }
    if (req.method === "GET" && u.startsWith("/v1/admin/whoami")) {
      res.writeHead(200);
      return void res.end(JSON.stringify({ isAdmin: false, permissions: [] }));
    }
    if (req.method === "GET" && u.startsWith("/v1/keychain/overview")) {
      res.writeHead(200);
      return void res.end(
        JSON.stringify({
          credentials: [{ id: "c1", service: "stripe", envKey: "STRIPE_API_KEY", createdAt: 1 }],
          connectorCredentials: [],
          grants: [],
          asks: [],
          usage: [],
        }),
      );
    }
    res.writeHead(200);
    res.end("{}");
  });
});
await new Promise<void>((r) => core.listen(0, r));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_ORG_ID = "acme";
process.env.CORE_SIGNING_SECRET = "session-cap-replay-test-secret";
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

const FROZEN_NOW = 1_800_000_000_000;

test("same-second session-cap mints stay unique past core's replay dedupe", async () => {
  const token = mintPortalIdentity({ p: "alice", exp: FROZEN_NOW + 60_000 }, "session-cap-replay-test-secret");
  const headers = { [PORTAL_IDENTITY_HEADER]: token };

  const realNow = Date.now;
  Date.now = () => FROZEN_NOW;
  try {
    const me = await fetch(`${base}/me`, { headers });
    assert.equal(me.status, 200);

    const overview = await fetch(`${base}/api/keychain/overview`, { headers });
    assert.equal(overview.status, 200, "second same-second mint must not be rejected as a replay");
    const body = (await overview.json()) as { credentials?: Array<{ id: string }> };
    assert.equal(body.credentials?.length, 1, "stored credentials must survive the second mint");
  } finally {
    Date.now = realNow;
  }

  assert.equal(sessionCapMints, 2);
  assert.equal(seenSignatures.size, 2, "each session-cap mint must carry a distinct signature");
});
