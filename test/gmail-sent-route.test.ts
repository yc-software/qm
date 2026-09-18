import assert from "node:assert/strict";
import { test } from "node:test";
import { gmailSent } from "../src/api/routes/connectors.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { createKeychain } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { withOperatorTokenFallback } from "../src/credentials/connector-token.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

test("sent mail requires portal identity and ignores a forged principal query", async () => {
  let status = 0;
  let requestedPrincipal = "";
  const ctx = {
    actor: null,
    url: new URL("http://localhost/v1/connectors/gmail/sent?principalId=someone-else"),
    res: {
      setHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end() {},
    },
    deps: {
      keychain: {
        async connectorAccessToken(_host: string, principal: string) {
          requestedPrincipal = principal;
          return null;
        },
      },
    },
  } as unknown as ApiCtx;
  await gmailSent(ctx);
  assert.equal(status, 403);
  assert.equal(requestedPrincipal, "");
  ctx.actor = { p: "signed-in-user" } as ApiCtx["actor"];
  await gmailSent(ctx);
  assert.equal(status, 409);
  assert.equal(requestedPrincipal, "signed-in-user");
  requestedPrincipal = "";
  ctx.url.searchParams.set("accountType", "forged");
  await gmailSent(ctx);
  assert.equal(status, 400);
  assert.equal(requestedPrincipal, "");
});

test("sent mail resolves the connected Google account slot", async () => {
  const requestedAccountTypes: Array<string | undefined> = [];
  let status = 0;
  let body = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: [] });
    if (url.pathname.endsWith("/profile")) return Response.json({ emailAddress: "eve@example.com" });
    return new Response(null, { status: 404 });
  };
  const ctx = {
    actor: { p: "eve@example.com" },
    url: new URL("http://localhost/v1/connectors/gmail/sent"),
    params: {},
    res: {
      setHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        body = value;
      },
    },
    deps: {
      keychain: {
        async connectorAccessToken(_host: string, _principal: string, accountType?: string) {
          requestedAccountTypes.push(accountType);
          return accountType === "company" ? "company-token" : null;
        },
      },
    },
  } as unknown as ApiCtx;
  try {
    await gmailSent(ctx);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(status, 200);
  assert.deepEqual(requestedAccountTypes, ["default", "personal", "company"]);
  assert.deepEqual(JSON.parse(body), {
    messages: [],
    accountEmail: "eve@example.com",
    accountType: "company",
  });
});

for (const messageId of [undefined, "sent-message"]) {
  test(`guarded Google permits trusted sent-mail ${messageId ? "detail" : "list"} reads without exporting tokens`, async (t) => {
    const connectorTokens = createKeychain({
      creds: createMemoryMap(),
      grants: createMemoryMap(),
      asks: createMemoryMap(),
      key: deriveConnectorKey("guarded-gmail-route-test"),
      blockedConnectorMaterializationHosts: ["gmail.googleapis.com"],
    });
    await connectorTokens.setConnectorToken(
      "gmail.googleapis.com",
      "viewer",
      { accessToken: "viewer-google-token" },
      "personal",
    );
    await connectorTokens.setConnectorToken(
      "gmail.googleapis.com",
      "other",
      { accessToken: "other-google-token" },
      "personal",
    );
    let status = 0;
    let body = "";
    const requests: Array<{ url: string; authorization: string | null }> = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url: url.href, authorization: new Headers(init?.headers).get("authorization") });
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: [] });
      if (url.pathname.endsWith("/profile")) return Response.json({ emailAddress: "viewer@example.com" });
      return Response.json({ id: "sent-message", threadId: "thread", labelIds: ["SENT"], snippet: "Message preview" });
    });
    const ctx = {
      actor: { p: "viewer" },
      url: new URL("http://localhost/v1/connectors/gmail/sent?accountType=personal&principalId=other"),
      params: messageId ? { messageId } : {},
      res: {
        setHeader() {},
        writeHead(code: number) {
          status = code;
        },
        end(value: string) {
          body = value;
        },
      },
      deps: { keychain: connectorTokens },
    } as unknown as ApiCtx;
    await gmailSent(ctx);
    assert.equal(status, 200);
    assert.equal(JSON.parse(body).accountType, "personal");
    if (messageId) assert.equal(JSON.parse(body).id, "sent-message");
    else assert.deepEqual(JSON.parse(body).messages, []);
    assert.equal(requests.length, messageId ? 1 : 2);
    assert.ok(requests.every((request) => request.authorization === "Bearer viewer-google-token"));
    assert.ok(requests.every((request) => new URL(request.url).hostname === "gmail.googleapis.com"));
    assert.doesNotMatch(body, /google-token/);
    await assert.rejects(
      connectorTokens.connectorDerivedAuth("gmail.googleapis.com", "viewer", "personal"),
      /trusted service/,
    );
  });
}

for (const hasKeychain of [true, false]) {
  test(`sent mail never uses operator fallback when the actor has no Google login (keychain=${hasKeychain})`, async (t) => {
    const keychain = createKeychain({
      creds: createMemoryMap(),
      grants: createMemoryMap(),
      asks: createMemoryMap(),
      key: deriveConnectorKey("gmail-operator-fallback-test"),
    });
    const connectorTokens = withOperatorTokenFallback(keychain, ["gmail.googleapis.com"], {
      get: async () => "operator-google-token",
    });
    let status = 0;
    let body = "";
    const exportedTokens: Array<string | null> = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      exportedTokens.push(new Headers(init?.headers).get("authorization"));
      const url = new URL(String(input));
      return Response.json(
        url.pathname.endsWith("/profile") ? { emailAddress: "operator@example.com" } : { messages: [] },
      );
    });
    await gmailSent({
      actor: { p: "unconnected-viewer" },
      url: new URL("http://localhost/v1/connectors/gmail/sent"),
      params: {},
      res: {
        setHeader() {},
        writeHead(code: number) {
          status = code;
        },
        end(value: string) {
          body = value;
        },
      },
      deps: { connectorTokens, ...(hasKeychain ? { keychain } : {}) },
    } as unknown as ApiCtx);
    assert.equal(status, 409);
    assert.equal(JSON.parse(body).error, "not_connected");
    assert.deepEqual(exportedTokens, []);
  });
}
