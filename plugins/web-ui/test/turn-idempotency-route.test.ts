import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const turns: Record<string, unknown>[] = [];
const inboxRequests: string[] = [];
let inboxAvailable = true;
let inboxAccessStatus = 200;
let inboxAccessBody = JSON.stringify({ enabled: true });
const accessRequests: string[] = [];
let inboxPages = 1;
let longPreview = false;
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    if (req.url?.startsWith("/v1/inbox/access?")) {
      accessRequests.push(req.url);
      res.writeHead(inboxAccessStatus, { "content-type": "application/json" });
      res.end(inboxAccessBody);
      return;
    }
    if (req.url?.startsWith("/v1/inbox?")) {
      inboxRequests.push(req.url);
      const page = Number(new URL(req.url, "http://core").searchParams.get("cursor") ?? 0);
      res.writeHead(inboxAvailable ? 200 : 503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          total: inboxPages,
          nextCursor: page + 1 < inboxPages ? String(page + 1) : null,
          items: [
            {
              id: `item-${page}`,
              loopId: "loop-1",
              state: "held",
              sourcePayload: {
                from: "Taylor",
                title: "Review the proposal",
                snippet: longPreview ? "x".repeat(10_000) : "Please review by Friday.",
              },
            },
          ],
        }),
      );
      return;
    }
    if (req.method === "POST") turns.push(JSON.parse(raw) as Record<string, unknown>);
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "queued", runId: "run-1" }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "turn-idempotency-test";
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.INBOX_USERS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => {
  void handler(req, res).catch(() => {
    res.writeHead(502);
    res.end();
  });
});
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "turn-idempotency-test"),
  "content-type": "application/json",
};

test.after(() => {
  surface.close();
  core.close();
});

test("web retries forward one user-scoped idempotency key", async () => {
  const clientTurnId = "123e4567-e89b-42d3-a456-426614174000";
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${base}/api/turn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "hello", threadRef: "web:alice:one", clientTurnId }),
    });
    assert.equal(response.status, 202);
  }
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.idempotencyKey, `web:alice:${clientTurnId}`);
  assert.equal(turns[1]?.idempotencyKey, turns[0]?.idempotencyKey);
});

test("malformed client turn ids are not forwarded", async () => {
  const response = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "hello", threadRef: "web:alice:two", clientTurnId: "shared-key" }),
  });
  assert.equal(response.status, 202);
  assert.equal(turns.at(-1)?.idempotencyKey, undefined);
});

test("app editing forwards app context separately from the exact user message", async () => {
  const response = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "Make the title smaller", threadRef: "web:alice:app-edit:sample-app" }),
  });
  assert.equal(response.status, 202);
  assert.equal(turns.at(-1)?.text, "Make the title smaller");
  assert.match(String(turns.at(-1)?.conversationHeader), /deployed app "sample-app"/);
});

test("ordinary chats and invalid app references cannot inject app context", async () => {
  for (const threadRef of ["web:alice:ordinary", "web:alice:app-edit:bad/name"]) {
    const response = await fetch(`${base}/api/turn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "hello", threadRef, conversationHeader: "injected" }),
    });
    assert.equal(response.status, 202);
    assert.equal(turns.at(-1)?.conversationHeader, undefined);
  }
  const count = turns.length;
  const response = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "hello", threadRef: "web:bob:app-edit:sample-app" }),
  });
  assert.equal(response.status, 403);
  assert.equal(turns.length, count);
});

test("inbox chat loads fresh caller-scoped previews separately from the user message", async () => {
  const response = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: "What needs my attention?",
      threadRef: "web:alice:inbox",
      principalId: "bob",
      conversationHeader: "injected",
    }),
  });
  assert.equal(response.status, 202);
  assert.equal(turns.at(-1)?.text, "What needs my attention?");
  assert.match(String(turns.at(-1)?.conversationHeader), /Review the proposal/);
  assert.match(String(turns.at(-1)?.conversationHeader), /untrusted data/);
  assert.doesNotMatch(String(turns.at(-1)?.conversationHeader), /injected/);
  assert.equal(new URL(inboxRequests.at(-1)!, "http://core").searchParams.get("principalId"), "alice");
  const count = inboxRequests.length;
  const denied = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "hello", threadRef: "web:bob:inbox" }),
  });
  assert.equal(denied.status, 403);
  assert.equal(inboxRequests.length, count);
  const shared = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "hello", threadRef: "web:alice:inbox", scopeId: "channel:shared" }),
  });
  assert.equal(shared.status, 403);
  assert.equal(inboxRequests.length, count);
});

test("inbox context failures do not start a context-free turn", async () => {
  inboxAvailable = false;
  const count = turns.length;
  try {
    const response = await fetch(`${base}/api/turn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "Summarize", threadRef: "web:alice:inbox" }),
    });
    assert.equal(response.status, 502);
    assert.equal(turns.length, count);
  } finally {
    inboxAvailable = true;
  }
});

test("inbox turn and steering enforce the same allowlist as the inbox page", async () => {
  process.env.INBOX_USERS = "bob";
  const count = inboxRequests.length;
  const submitted = turns.length;
  try {
    for (const path of ["/api/turn", "/api/runs/run-1/signal"]) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "steer", text: "Summarize", threadRef: "web:alice:inbox" }),
      });
      assert.equal(response.status, 403);
    }
    assert.equal(inboxRequests.length, count);
    assert.equal(turns.length, submitted);
  } finally {
    process.env.INBOX_USERS = "alice";
  }
});

test("inbox context follows pages, bounds previews, and discloses incomplete coverage", async () => {
  try {
    for (const pages of [2, 6]) {
      inboxPages = pages;
      longPreview = true;
      const count = inboxRequests.length;
      const response = await fetch(`${base}/api/turn`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "Summarize", threadRef: "web:alice:inbox" }),
      });
      assert.equal(response.status, 202);
      assert.equal(inboxRequests.length - count, Math.min(pages, 5));
      const context = String(turns.at(-1)?.conversationHeader);
      const snapshot = JSON.parse(context.slice(context.indexOf('{"attentionCount"')));
      assert.equal(snapshot.includedItems, Math.min(pages, 5));
      assert.equal(snapshot.hasMore, pages > 5);
      assert.equal(snapshot.items[1].id, "item-1");
      assert.equal(snapshot.items[0].snippet.length, 500);
      assert.match(context, /not the entire inbox/);
    }
  } finally {
    inboxPages = 1;
    longPreview = false;
  }
});

test("inbox steering refreshes the caller's inbox context", async () => {
  const count = inboxRequests.length;
  const response = await fetch(`${base}/api/runs/run-1/signal`, {
    method: "POST",
    headers,
    body: JSON.stringify({ kind: "steer", text: "Prioritize", threadRef: "web:alice:inbox" }),
  });
  assert.equal(response.status, 202);
  assert.equal(inboxRequests.length, count + 1);
  const request = turns.at(-1)?.request as Record<string, unknown>;
  assert.equal(request.text, "Prioritize");
  assert.match(String(request.conversationHeader), /Review the proposal/);
});

test("inbox turns and steering fail closed when the existing feature flag is off or unavailable", async () => {
  try {
    for (const [status, body] of [
      [200, JSON.stringify({ enabled: false })],
      [200, JSON.stringify({})],
      [200, "invalid json"],
      [503, JSON.stringify({ enabled: true })],
    ] as const) {
      inboxAccessStatus = status;
      inboxAccessBody = body;
      const reads = inboxRequests.length;
      const submitted = turns.length;
      for (const path of ["/api/turn", "/api/runs/run-1/signal"]) {
        const response = await fetch(`${base}${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ kind: "steer", text: "Summarize", threadRef: "web:alice:inbox" }),
        });
        assert.equal(response.status, 403);
        assert.equal((await response.json()).error, "feature_disabled");
        assert.equal(new URL(accessRequests.at(-1)!, "http://core").searchParams.get("principalId"), "alice");
      }
      assert.equal(inboxRequests.length, reads);
      assert.equal(turns.length, submitted);
      const accessCount = accessRequests.length;
      const ordinary = await fetch(`${base}/api/turn`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "Hello", threadRef: "web:alice:ordinary" }),
      });
      assert.equal(ordinary.status, 202);
      assert.equal(accessRequests.length, accessCount);
    }
  } finally {
    inboxAccessStatus = 200;
    inboxAccessBody = JSON.stringify({ enabled: true });
  }
});
