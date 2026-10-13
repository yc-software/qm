import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const coreTurnBodies: Array<Record<string, unknown>> = [];

const core = createServer((req: IncomingMessage, res) => {
  const u = new URL(req.url ?? "", "http://core");
  const reply = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "POST" && u.pathname === "/v1/turns") {
    let body = "";
    req.on("data", (c) => (body += c));
    return void req.on("end", () => {
      coreTurnBodies.push(JSON.parse(body) as Record<string, unknown>);
      reply(200, { status: "queued", runId: `run-${coreTurnBodies.length}` });
    });
  }
  reply(404, { error: "not_found" });
});
await new Promise<void>((r) => core.listen(0, r));

const SECRET = "turn-idempotency-key-test";
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const IDENTITY = {
  cookie: "webuiuser=alice",
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, SECRET),
  "content-type": "application/json",
};

test.after(() => {
  surface.close();
  core.close();
});

async function postTurn(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  coreTurnBodies.length = 0;
  const r = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: IDENTITY,
    body: JSON.stringify({ text: "hello", threadRef: "web:alice:t1", ...body }),
  });
  assert.equal(r.status, 200);
  assert.equal(coreTurnBodies.length, 1);
  return coreTurnBodies[0]!;
}

test("a client idempotency key reaches core namespaced to the authenticated user", async () => {
  const turn = await postTurn({ idempotencyKey: "gesture-123" });
  assert.equal(turn.idempotencyKey, "web:alice:gesture-123");
});

test("a send without a key posts a turn with no idempotency key at all", async () => {
  const turn = await postTurn({});
  assert.ok(!("idempotencyKey" in turn));
});

test("blank, non-string, and oversized keys are dropped rather than forwarded", async () => {
  for (const bad of ["", "   ", 42, "x".repeat(129)]) {
    const turn = await postTurn({ idempotencyKey: bad });
    assert.ok(!("idempotencyKey" in turn), `key ${JSON.stringify(bad)} must not forward`);
  }
});

test("keys with separator characters are dropped so a send can't collide with an approval replay's key", async () => {
  for (const bad of ["a:b", "approval:a-1:true:approval:a-1:true", "a b", "a\nb"]) {
    const turn = await postTurn({ idempotencyKey: bad });
    assert.ok(!("idempotencyKey" in turn), `key ${JSON.stringify(bad)} must not forward`);
  }
});
