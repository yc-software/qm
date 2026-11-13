import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { CapabilityClaims } from "../src/auth/capability-token.ts";
import { composioUserId } from "../src/api/routes/composio.ts";
import { composioProxyRoutes } from "../src/api/routes/composio-proxy.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { createKeychain } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { orgId } from "../src/config.ts";
import { testAdvisoryLock, testMap } from "./support/test-database.ts";
import { testTenant } from "./support/test-tenant.ts";
import { liveRunClaims, liveRunStore } from "./support/live-run.ts";

const cap: CapabilityClaims = {
  ...liveRunClaims("alice"),
  sessionId: "test-session",
  actorId: "alice",
  scopeId: "personal:alice",
  ownerConnections: true,
  exp: Date.now() + 60_000,
};
const alice = composioUserId(orgId(), "alice");
const gmail = { id: "ca_gmail", user_id: alice, status: "ACTIVE", toolkit: { slug: "gmail" } };
const calendar = { id: "ca_cal", user_id: alice, status: "ACTIVE", toolkit: { slug: "googlecalendar" } };
const accounts = (...items: unknown[]) => ({ items });
const proxied = (data: unknown, status = 200, headers: Record<string, string> = {}) => ({
  data,
  status,
  headers: { "set-cookie": "hidden", "content-type": "application/json", ...headers },
});

async function fixture() {
  const keychain = createKeychain({
    creds: testMap(),
    grants: testMap(),
    asks: testMap(),
    lock: testAdvisoryLock(),
    key: deriveConnectorKey("composio-test"),
  });
  await keychain.save({ ownerId: "alice", service: "composio", envKey: "COMPOSIO_API_KEY", secret: "private-key" });
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> | null }> = [];
  const replies: unknown[] = [];
  const audits: string[] = [];
  const deps: Partial<ServerDeps> = {
    keychain,
    serviceCreds: keychain,
    auditLog: {
      record: (_t: unknown, e: { action: string }) => audits.push(e.action),
    } as unknown as ServerDeps["auditLog"],
    runs: liveRunStore(),
    composioFetch: (async (input, init) => {
      calls.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      if (reply instanceof Response) return reply;
      return Response.json(reply);
    }) as typeof fetch,
  };
  async function send(body: unknown, options: { capability?: CapabilityClaims; actor?: string } = {}) {
    let status = 0;
    let headers: Record<string, string> = {};
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    });
    const res = Object.assign(sink, {
      headersSent: false,
      setHeader() {},
      getHeader() {},
      writeHead(code: number, h?: Record<string, string>) {
        status = code;
        headers = { ...headers, ...h };
        return sink;
      },
    }) as unknown as ServerResponse;
    const ctx = {
      deps,
      res,
      tenant: testTenant,
      url: new URL("/v1/composio/proxy", "http://localhost"),
      body,
      capability: "capability" in options ? options.capability : cap,
      actor: options.actor ? { p: options.actor, exp: Date.now() + 60_000 } : null,
    } as unknown as ApiCtx;
    await composioProxyRoutes[0]!.handle(ctx);
    if (!sink.writableFinished) await finished(sink);
    const raw = Buffer.concat(chunks);
    const text = raw.toString("utf8");
    const parse = (): Record<string, unknown> => {
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        return {};
      }
    };
    return { status, headers, raw, text, data: parse() };
  }
  return { send, calls, replies, audits, deps };
}

test("forwards a raw request through the caller's only matching connection and relays the provider reply", async () => {
  const f = await fixture();
  f.replies.push(accounts(gmail), proxied({ id: "r1", message: { id: "m1" } }));
  const result = await f.send({
    method: "POST",
    url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    query: { fields: "id,message" },
    body: { message: { raw: "abc" } },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { id: "r1", message: { id: "m1" } });
  assert.equal(result.headers["x-composio-account"], "ca_gmail");
  assert.equal(result.headers["set-cookie"], undefined);
  assert.doesNotMatch(result.text, /private-key|hidden/);
  assert.deepEqual(f.calls[1]!.body, {
    connected_account_id: "ca_gmail",
    endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/drafts?fields=id%2Cmessage",
    method: "POST",
    body: { message: { raw: "abc" } },
  });
});

test("provider errors keep their own status and body", async () => {
  const f = await fixture();
  f.replies.push(accounts(gmail), proxied({ error: { code: 404, message: "Requested entity was not found." } }, 404));
  const result = await f.send({ url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/missing" });
  assert.equal(result.status, 404);
  assert.deepEqual(result.data, { error: { code: 404, message: "Requested entity was not found." } });
  assert.equal(f.calls[1]!.body!.method, "GET");
});

test("empty replies stay empty and pass through location for resumable uploads", async () => {
  const f = await fixture();
  f.replies.push(
    accounts({ ...gmail, id: "ca_drive", toolkit: { slug: "googledrive" } }),
    proxied("", 200, { location: "https://www.googleapis.com/upload/drive/v3/files?upload_id=u1" }),
  );
  const result = await f.send({
    method: "POST",
    url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
    body: { name: "a.bin" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.raw.length, 0);
  assert.equal(result.headers.location, "https://www.googleapis.com/upload/drive/v3/files?upload_id=u1");
});

test("dropbox file calls forward Dropbox-API-Arg upstream and return Dropbox-API-Result", async () => {
  const f = await fixture();
  f.replies.push(
    accounts({ ...gmail, id: "ca_dbx", toolkit: { slug: "dropbox" } }),
    proxied("hello", 200, { "Dropbox-API-Result": '{"name":"a.txt"}', "Content-Type": "application/octet-stream" }),
  );
  const result = await f.send({
    method: "POST",
    url: "https://content.dropboxapi.com/2/files/download",
    headers: { "Dropbox-API-Arg": '{"path":"/a.txt"}' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers["dropbox-api-result"], '{"name":"a.txt"}');
  assert.deepEqual(f.calls.at(-1)?.body?.parameters, [
    { name: "Dropbox-API-Arg", value: '{"path":"/a.txt"}', type: "header" },
  ]);
});

test("binary uploads go as a binary body and binary downloads come back as bytes", async () => {
  const bytes = Buffer.from([0, 255, 1, 254, 137, 80, 78, 71]);
  const f = await fixture();
  f.replies.push(accounts({ ...gmail, id: "ca_dbx", toolkit: { slug: "dropbox" } }), proxied({ id: "id:1" }));
  const up = await f.send({
    method: "POST",
    url: "https://content.dropboxapi.com/2/files/upload",
    headers: { "Dropbox-API-Arg": '{"path":"/a.bin"}', "Content-Type": "application/octet-stream" },
    bodyBase64: bytes.toString("base64"),
  });
  assert.equal(up.status, 200);
  assert.deepEqual(f.calls[1]!.body, {
    connected_account_id: "ca_dbx",
    endpoint: "https://content.dropboxapi.com/2/files/upload",
    method: "POST",
    parameters: [
      { name: "Dropbox-API-Arg", value: '{"path":"/a.bin"}', type: "header" },
      { name: "Content-Type", value: "application/octet-stream", type: "header" },
    ],
    binary_body: { base64: bytes.toString("base64"), content_type: "application/octet-stream" },
  });

  const g = await fixture();
  g.replies.push(
    accounts({ ...gmail, id: "ca_drive", toolkit: { slug: "googledrive" } }),
    {
      data: {},
      status: 200,
      binary_data: { url: "https://files.example/abc?sig=1", content_type: "image/png", size: bytes.length },
    },
    new Response(bytes),
  );
  const down = await g.send({ url: "https://www.googleapis.com/drive/v3/files/F1?alt=media" });
  assert.equal(down.status, 200);
  assert.equal(down.headers["content-type"], "image/png");
  assert.deepEqual(down.raw, bytes);
  assert.equal(g.calls[2]!.url, "https://files.example/abc?sig=1");
  assert.equal(g.calls[2]!.headers["x-api-key"], undefined);
});

test("only an app's own API hosts are reachable, and only with that app's connection", async () => {
  for (const url of [
    "https://evil.example/collect",
    "https://www.googleapis.com/oauth2/v2/userinfo",
    "https://gmail.googleapis.com.evil.example/x",
    "http://gmail.googleapis.com/gmail/v1/users/me/profile",
    "https://user:pw@gmail.googleapis.com/gmail/v1/users/me/profile",
    "https://gmail.googleapis.com:8443/gmail/v1/users/me/profile",
  ]) {
    const f = await fixture();
    const result = await f.send({ url });
    assert.ok([400, 403].includes(result.status), url);
    assert.equal(f.calls.length, 0, url);
  }
  const f = await fixture();
  f.replies.push(gmail);
  const result = await f.send({
    url: "https://www.googleapis.com/calendar/v3/../drive/v3/files",
    accountId: "ca_gmail",
  });
  assert.equal(result.status, 403);
  assert.equal(result.data.error, "url_not_allowed");
  assert.equal(f.calls.length, 1);

  const c = await fixture();
  c.replies.push(accounts(calendar), proxied({ timeZone: "UTC" }));
  const ok = await c.send({ url: "https://www.googleapis.com/calendar/v3/users/me/settings/timezone" });
  assert.equal(ok.status, 200);
  assert.equal(new URL(c.calls[0]!.url).searchParams.get("toolkit_slugs"), "googlecalendar");
});

test("an explicit account of another app cannot reach this app's API", async () => {
  const f = await fixture();
  f.replies.push(calendar);
  const result = await f.send({ url: "https://gmail.googleapis.com/gmail/v1/users/me/profile", accountId: "ca_cal" });
  assert.equal(result.status, 403);
  assert.equal(result.data.error, "url_not_allowed");
  assert.equal(f.calls.length, 1);
});

test("lookup ignores other owners' or inactive accounts and asks the agent to connect or choose", async () => {
  const none = await fixture();
  none.replies.push(
    accounts({ ...gmail, user_id: composioUserId(orgId(), "bob") }, { ...gmail, status: "EXPIRED" }, calendar),
  );
  const missing = await none.send({ url: "https://gmail.googleapis.com/gmail/v1/users/me/profile" });
  assert.equal(missing.status, 409);
  assert.equal(missing.data.error, "not_connected");
  assert.deepEqual(missing.data.toolkits, ["gmail"]);
  assert.equal(none.calls.length, 1);

  const two = await fixture();
  two.replies.push(accounts(gmail, { ...gmail, id: "ca_gmail2" }));
  const ambiguous = await two.send({ url: "https://gmail.googleapis.com/gmail/v1/users/me/profile" });
  assert.equal(ambiguous.status, 409);
  assert.equal(ambiguous.data.error, "choose_account");
  assert.deepEqual(ambiguous.data.accounts, [
    { id: "ca_gmail", toolkit: "gmail" },
    { id: "ca_gmail2", toolkit: "gmail" },
  ]);
  assert.equal(two.calls.length, 1);
});

test("the agent cannot supply credentials or extra fields", async () => {
  const url = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
  for (const body of [
    { url, headers: { Authorization: "Bearer stolen" } },
    { url, headers: { cookie: "a=b" } },
    { url, user_id: "bob" },
    { url, connected_account_id: "ca_bob" },
    { url, method: "TRACE" },
    { url, accountId: "../connected_accounts" },
    { url, body: {}, bodyBase64: "AA==" },
    { url, bodyBase64: "not base64!" },
    { url, query: { q: { nested: true } } },
    null,
  ]) {
    const f = await fixture();
    const result = await f.send(body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(f.calls.length, 0);
  }
});

test("Composio failures surface cause and provider status without retry advice for writes", async () => {
  const f = await fixture();
  f.replies.push(accounts(gmail), new Response("Request Entity Too Large", { status: 413 }));
  const result = await f.send({
    method: "POST",
    url: "https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media",
    headers: { "content-type": "message/rfc822" },
    bodyBase64: Buffer.alloc(16).toString("base64"),
  });
  assert.equal(result.status, 502);
  assert.equal(result.data.error, "composio_proxy_failed");
  assert.equal(result.data.cause, "provider_error");
  assert.equal(result.data.providerStatus, 413);
  assert.ok(result.data.providerDetail);
  assert.deepEqual(f.audits, ["composio.proxy.started", "composio.proxy.failed"]);
});
