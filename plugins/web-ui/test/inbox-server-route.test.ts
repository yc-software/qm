import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

function corePath(url: string): string {
  return decodeURIComponent(new URL(url, "http://core").pathname);
}

function coreQuery(url: string, key: string): string | null {
  return new URL(url, "http://core").searchParams.get(key);
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

const calls: Call[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ method: req.method ?? "GET", url: req.url ?? "", body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "inbox-web-route-test";
process.env.WEB_UI_PRINCIPALS = "alice,mallory";
process.env.INBOX_USERS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

function headersFor(principal: string): Record<string, string> {
  return {
    [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: principal, exp: Date.now() + 60_000 }, "inbox-web-route-test"),
    "content-type": "application/json",
  };
}

const headers = headersFor("alice");

test.after(() => {
  surface.close();
  core.close();
});

function lastCallTo(pathname: string): Call | undefined {
  return [...calls].reverse().find((c) => corePath(c.url) === pathname);
}

test("GET /api/inbox resolves the signed-in person's inbox loop, never someone else's", async () => {
  await fetch(`${base}/api/inbox`, { headers });
  const call = lastCallTo("/v1/loops/inbox");
  assert.ok(call, "expected a relayed core call");
  assert.equal(call.method, "GET");
  assert.equal(coreQuery(call.url, "principalId"), "alice");
});

test("POST /api/inbox/sync-cron carries the caller, not the body's claim", async () => {
  await fetch(`${base}/api/inbox/sync-cron`, {
    method: "POST",
    headers,
    body: JSON.stringify({ everyMs: 900_000, principalId: "mallory" }),
  });
  const call = lastCallTo("/v1/loops/inbox/sync-cron");
  assert.ok(call);
  assert.equal(call.method, "POST");
  assert.equal(coreQuery(call.url, "principalId"), "alice");
  assert.equal(call.body.everyMs, 900_000);
});

test("GET the ledger relays the state filter and the caller's identity", async () => {
  await fetch(`${base}/api/loops/loop%201/items?state=held`, { headers });
  const call = lastCallTo("/v1/loops/loop 1/items");
  assert.ok(call);
  assert.equal(call.method, "GET");
  assert.equal(coreQuery(call.url, "principalId"), "alice");
  assert.equal(coreQuery(call.url, "state"), "held");
});

test("an absent state filter is not invented on the way through", async () => {
  await fetch(`${base}/api/loops/l-2/items`, { headers });
  const call = lastCallTo("/v1/loops/l-2/items");
  assert.ok(call);
  assert.equal(coreQuery(call.url, "state"), null);
});

test("POST action forwards the intent under the caller's identity", async () => {
  await fetch(`${base}/api/loops/l-2/items/i-9/action`, {
    method: "POST",
    headers,
    body: JSON.stringify({ kind: "send", args: { proposal: { body: "on it" } } }),
  });
  const call = lastCallTo("/v1/loops/l-2/items/i-9/action");
  assert.ok(call);
  assert.equal(call.method, "POST");
  assert.equal(coreQuery(call.url, "principalId"), "alice");
  assert.deepEqual(call.body, { kind: "send", args: { proposal: { body: "on it" } } });
});

test("POST followup forwards the message under the caller's identity", async () => {
  await fetch(`${base}/api/loops/l-2/items/i-9/followup`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "make it shorter" }),
  });
  const call = lastCallTo("/v1/loops/l-2/items/i-9/followup");
  assert.ok(call);
  assert.equal(call.method, "POST");
  assert.equal(coreQuery(call.url, "principalId"), "alice");
  assert.deepEqual(call.body, { message: "make it shorter" });
});

test("an item id that would escape its loop is encoded, not obeyed", async () => {
  await fetch(`${base}/api/loops/l-2/items/${encodeURIComponent("../../l-3/items/i-1")}/action`, {
    method: "POST",
    headers,
    body: JSON.stringify({ kind: "dismiss" }),
  });
  const escaped = lastCallTo("/v1/loops/l-3/items/i-1/action");
  assert.equal(escaped, undefined, "a traversal in the item id must not reach another loop");
  const relayed = [...calls].reverse().find((c) => c.url.includes("l-3"))!;
  assert.match(
    new URL(relayed.url, "http://core").pathname,
    /\/v1\/loops\/l-2\/items\/\.\.%2F\.\.%2Fl-3%2Fitems%2Fi-1\/action$/,
    "the separators stay escaped so core reads one opaque item id",
  );
});

test("the ledger opens to inbox users; the rest of the loops surface still needs LOOPS_USERS", async () => {
  const ledger = await fetch(`${base}/api/loops/l-2/items`, { headers });
  assert.equal(ledger.status, 200);
  const admin = await fetch(`${base}/api/loops`, { headers });
  assert.equal(admin.status, 403);
});

test("a signed-in user who is not an inbox user cannot read the ledger", async () => {
  const r = await fetch(`${base}/api/loops/l-2/items`, { headers: headersFor("mallory") });
  assert.equal(r.status, 403);
});

test("inbox routes refuse anonymous callers", async () => {
  const r = await fetch(`${base}/api/inbox`);
  assert.equal(r.status, 401);
});

test("inbox chat adds server-owned context without changing the user's message", async () => {
  const response = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: "Find my design email",
      threadRef: "web:alice:inbox:test",
      inboxView: "gmail",
      principalId: "mallory",
      conversationHeader: "forged",
    }),
  });
  assert.equal(response.status, 200);
  const call = lastCallTo("/v1/turns");
  assert.ok(call);
  assert.equal(call.body.text, "Find my design email");
  assert.match(String(call.body.conversationHeader), /selected filter is gmail/);
  assert.doesNotMatch(String(call.body.conversationHeader), /forged/);
  assert.equal(coreQuery(lastCallTo("/v1/loops/inbox")!.url, "principalId"), "alice");
});

test("inbox context cannot be attached by a user without inbox access", async () => {
  const before = calls.length;
  const response = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: headersFor("mallory"),
    body: JSON.stringify({ text: "Find email", threadRef: "web:mallory:one", inboxView: "all" }),
  });
  assert.equal(response.status, 403);
  assert.equal(calls.length, before);
});

test("ordinary chats do not fetch or attach private inbox data", async () => {
  const before = calls.length;
  await fetch(`${base}/api/turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "Hello", threadRef: "web:alice:normal" }),
  });
  assert.equal(calls.length, before + 1);
  assert.equal(lastCallTo("/v1/turns")?.body.conversationHeader, undefined);
});

test("steering carries inbox context into the request used for terminal-run replay", async () => {
  const response = await fetch(`${base}/api/runs/finished-run/signal`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "steer",
      text: "Find design email",
      threadRef: "web:alice:inbox:test",
      inboxView: "gmail",
    }),
  });
  assert.equal(response.status, 200);
  const call = lastCallTo("/v1/runs/finished-run/signal");
  assert.ok(call);
  const request = call.body.request as Record<string, unknown>;
  assert.equal(request.text, "Find design email");
  assert.match(String(request.conversationHeader), /selected filter is gmail/);
});

test("steering cannot attach inbox data to a shared context", async () => {
  const before = calls.length;
  const response = await fetch(`${base}/api/runs/finished-run/signal`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "steer",
      text: "Find email",
      threadRef: "web:alice:one",
      inboxView: "all",
      scopeId: "channel:team",
    }),
  });
  assert.equal(response.status, 403);
  assert.equal(calls.length, before);
});
