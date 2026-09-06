import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";

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

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/core-bridge.ts", import.meta.url), "utf8");
const crons = readFileSync(new URL("../src/crons.ts", import.meta.url), "utf8");
const search = readFileSync(new URL("../src/search.ts", import.meta.url), "utf8");

test("every send gesture mints exactly one key, carried on the prompt message so drive re-invocations reuse it", () => {
  const at = bridge.indexOf("export function userSendMessage");
  assert.ok(at >= 0);
  const body = bridge.slice(at, bridge.indexOf("export interface UiStateRecord", at));
  assert.match(body, /idempotencyKey: mintSendKey\(\)/);
  const send = composer.slice(
    composer.indexOf("async function sendPrompt"),
    composer.indexOf("const LARGE_PASTE_CHARS"),
  );
  assert.match(send, /agent\.prompt\(userSendMessage\(text, attachments\.length \? attachments : undefined\)\)/);
});

test("the queue path keys each message and a resend after a failed submit reuses the same key", () => {
  const at = composer.indexOf("async function enqueueTurn");
  assert.ok(at >= 0);
  const body = composer.slice(at, composer.indexOf("async function removeQueued", at));
  assert.match(body, /const idempotencyKey = queueSendKey\(threadRef, text, filesKey\);/);
  assert.match(body, /failedQueueSend = \{ threadRef, text, filesKey, idempotencyKey \};/);
  assert.match(
    composer,
    /failedQueueSend\?\.threadRef === threadRef &&\s*failedQueueSend\.text === text &&\s*failedQueueSend\.filesKey === filesKey/,
  );
});

test("drive forwards the message's key so a duplicate POST of the same gesture dedups in core", () => {
  const at = bridge.indexOf("async function drive(");
  assert.ok(at >= 0);
  const body = bridge.slice(at, bridge.indexOf("async function resumeDrive", at));
  assert.match(body, /const \{ text, attachments, idempotencyKey, issues, droppedIds, retryable \} = opener/);
  assert.match(body, /turnRequestBody\([\s\S]{0,200}?\{ idempotencyKey, attachments \}\)/);
});

test("latestUserTurn is the send chokepoint: it mints a key for any unkeyed message and writes it back", () => {
  const at = bridge.indexOf("async function latestUserTurn");
  assert.ok(at >= 0);
  const body = bridge.slice(at, bridge.indexOf("function attachmentBytes", at));
  assert.match(body, /const idempotencyKey = sendKeyOf\(m\) \?\? mintSendKey\(\);/);
  assert.match(body, /m\.idempotencyKey = idempotencyKey;/);
});

test("the pane send paths (crons, search) mint keys like the composer does", () => {
  for (const [name, src] of [
    ["crons", crons],
    ["search", search],
  ] as const) {
    const prompts = src.match(/agent\?\.prompt\(/g) ?? [];
    const keyed = src.match(/agent\?\.prompt\(\s*userSendMessage\(/g) ?? [];
    assert.equal(keyed.length, prompts.length, `${name}: every prompt goes through userSendMessage`);
    assert.ok(prompts.length > 0, `${name}: has at least one send path`);
  }
});
