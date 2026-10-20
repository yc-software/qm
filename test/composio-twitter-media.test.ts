import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import type { CapabilityClaims } from "../src/auth/capability-token.ts";
import { composioUserId } from "../src/api/routes/composio.ts";
import { composioTwitterMediaRoutes } from "../src/api/routes/composio-twitter-media.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { createKeychain } from "../src/credentials/keychain.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { orgId } from "../src/config.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const cap: CapabilityClaims = {
  runId: "test-run",
  sessionId: "test-session",
  threadRef: "test-thread",
  runAttempt: 1,
  runLeaseToken: "test-lease",
  actorId: "alice",
  scopeId: "personal:alice",
  ownerConnections: true,
  liveActor: true,
  exp: Date.now() + 60_000,
};
const xAccount = {
  id: "ca_alice",
  user_id: composioUserId(orgId(), "alice"),
  status: "ACTIVE",
  toolkit: { slug: "twitter" },
};
const proxied = (data: unknown, status = 200) => ({ data, status, headers: { "set-cookie": "hidden" } });

async function fixture() {
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("composio-test"),
  });
  await keychain.save({ ownerId: "alice", service: "composio", envKey: "COMPOSIO_API_KEY", secret: "private-key" });
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  const replies: unknown[] = [];
  const audits: string[] = [];
  const deps: Partial<ServerDeps> = {
    keychain,
    serviceCreds: keychain,
    auditLog: { record: (e: { action: string }) => audits.push(e.action) } as unknown as ServerDeps["auditLog"],
    runs: {
      get: async () => ({
        status: "running",
        sessionId: "test-thread",
        attempts: 1,
        leaseToken: "test-lease",
        leaseExpiresAt: Date.now() + 60_000,
        request: { actor: { id: "alice" } },
      }),
    } as unknown as ServerDeps["runs"],
    composioFetch: (async (input, init) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return Response.json(reply);
    }) as typeof fetch,
  };
  async function upload(body: unknown, options: { capability?: CapabilityClaims; actor?: string } = {}) {
    let status = 0;
    let text = "";
    const res = {
      setHeader() {},
      getHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        text = value;
      },
    } as unknown as ServerResponse;
    const ctx = {
      deps,
      res,
      url: new URL("/v1/composio/twitter/media", "http://localhost"),
      body,
      capability: "capability" in options ? options.capability : cap,
      actor: options.actor ? { p: options.actor, exp: Date.now() + 60_000 } : null,
    } as unknown as ApiCtx;
    await composioTwitterMediaRoutes[0]!.handle(ctx);
    return { status, data: JSON.parse(text), text };
  }
  return { upload, calls, replies, audits, deps };
}

test("uploads an image through the caller's own X connection and returns only the media id", async () => {
  const f = await fixture();
  f.replies.push(
    xAccount,
    proxied({ data: { id: "1001" } }),
    proxied({}),
    proxied({ data: { id: "1001", expires_after_secs: 86400 } }),
  );
  const result = await f.upload({ accountId: "ca_alice", data: PNG.toString("base64") });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, {
    mediaId: "1001",
    mediaType: "image/png",
    bytes: PNG.length,
    expiresAfterSecs: 86400,
  });
  assert.doesNotMatch(result.text, /private-key|hidden/);
  const proxyCalls = f.calls.slice(1).map((call) => call.body);
  assert.ok(f.calls.slice(1).every((call) => call.url.endsWith("/tools/execute/proxy")));
  assert.deepEqual(proxyCalls, [
    {
      connected_account_id: "ca_alice",
      endpoint: "https://api.x.com/2/media/upload/initialize",
      method: "POST",
      body: { media_type: "image/png", total_bytes: PNG.length, media_category: "tweet_image" },
    },
    {
      connected_account_id: "ca_alice",
      endpoint: "https://api.x.com/2/media/upload/1001/append",
      method: "POST",
      body: { media: PNG.toString("base64"), segment_index: 0 },
    },
    { connected_account_id: "ca_alice", endpoint: "https://api.x.com/2/media/upload/1001/finalize", method: "POST" },
  ]);
  assert.deepEqual(f.audits, ["composio.twitter_media.started", "composio.twitter_media.completed"]);
});

test("images larger than one proxy request are appended in ordered segments", async () => {
  const f = await fixture();
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5 * 1024 * 1024 - 3, 1)]);
  f.replies.push(xAccount, proxied({ data: { id: "1002" } }), proxied({}), proxied({}), proxied({}));
  f.replies.push(proxied({ data: { id: "1002" } }));
  const result = await f.upload({ accountId: "ca_alice", data: jpeg.toString("base64") });
  assert.equal(result.status, 200);
  assert.equal(result.data.mediaType, "image/jpeg");
  const appends = f.calls.filter((call) => String(call.body?.endpoint).endsWith("/append"));
  assert.deepEqual(
    appends.map((call) => (call.body!.body as { segment_index: number }).segment_index),
    [0, 1, 2],
  );
  assert.deepEqual(
    Buffer.concat(appends.map((call) => Buffer.from((call.body!.body as { media: string }).media, "base64"))),
    jpeg,
  );
});

test("other owners, inactive or disabled accounts and non-X connections are refused before uploading", async () => {
  for (const account of [
    { ...xAccount, user_id: composioUserId(orgId(), "bob") },
    { ...xAccount, id: "ca_bob" },
    { ...xAccount, status: "EXPIRED" },
    { ...xAccount, is_disabled: true },
    { ...xAccount, toolkit: { slug: "gmail" } },
  ]) {
    const f = await fixture();
    f.replies.push(account);
    const result = await f.upload({ accountId: "ca_alice", data: PNG.toString("base64") });
    assert.equal(result.status, 403);
    assert.equal(f.calls.length, 1);
  }
});

test("the agent cannot choose the endpoint, identity or media type, and only real images are sent", async () => {
  const cases: Array<[unknown, number]> = [
    [{ accountId: "ca_alice", data: PNG.toString("base64"), endpoint: "https://api.x.com/2/tweets" }, 400],
    [{ accountId: "ca_alice", data: PNG.toString("base64"), user_id: "bob" }, 400],
    [{ accountId: "../connected_accounts", data: PNG.toString("base64") }, 400],
    [{ accountId: "ca_alice", data: "not base64!" }, 400],
    [{ accountId: "ca_alice", data: Buffer.from("GIF89a-animated").toString("base64") }, 415],
    [{ accountId: "ca_alice", data: Buffer.from("<svg/>").toString("base64") }, 415],
    [{ accountId: "ca_alice", data: Buffer.alloc(5 * 1024 * 1024 + 1, 0xff).toString("base64") }, 413],
  ];
  for (const [body, status] of cases) {
    const f = await fixture();
    assert.equal((await f.upload(body)).status, status);
    assert.equal(f.calls.length, 0);
  }
});

test("uploads need the current run's agent capability", async () => {
  for (const options of [
    { capability: undefined, actor: "alice" },
    { actor: "alice" },
    { capability: { ...cap, runLeaseToken: "stale" } },
  ]) {
    const f = await fixture();
    assert.equal((await f.upload({ accountId: "ca_alice", data: PNG.toString("base64") }, options)).status, 403);
    assert.equal(f.calls.length, 0);
  }
});

test("ending the run during account lookup prevents the upload", async () => {
  const f = await fixture();
  const original = f.deps.composioFetch!;
  f.deps.composioFetch = async (...args) => {
    const response = await original(...args);
    f.deps.runs = { get: async () => ({ status: "done" }) } as unknown as ServerDeps["runs"];
    return response;
  };
  f.replies.push(xAccount);
  assert.equal((await f.upload({ accountId: "ca_alice", data: PNG.toString("base64") })).status, 403);
  assert.equal(f.calls.length, 1);
});

test("an X refusal stops the upload and points the agent at reconnecting", async () => {
  const f = await fixture();
  f.replies.push(xAccount, proxied({ title: "Forbidden", detail: "Missing media.write" }, 403));
  const result = await f.upload({ accountId: "ca_alice", data: PNG.toString("base64") });
  assert.equal(result.status, 502);
  assert.equal(result.data.providerStatus, 403);
  assert.equal(result.data.providerDetail, "Missing media.write");
  assert.match(result.data.message, /reconnect X/);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.audits, ["composio.twitter_media.started", "composio.twitter_media.failed"]);
});
