import assert from "node:assert/strict";
import { test } from "node:test";
import { gmailSent } from "../src/api/routes/connectors.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";

test("sent mail requires portal identity and ignores a forged principal query", async () => {
  let status = 0;
  let requestedPrincipal = "";
  const ctx = {
    actor: null,
    url: new URL("http://localhost/v1/connectors/gmail/sent?principalId=someone-else"),
    res: {
      setHeader() {},
      getHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end() {},
    },
    deps: {
      connectorTokens: {
        async connectorDerivedAuth(_host: string, principal: string) {
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
  ctx.url.searchParams.set("accountType", "forged/slot");
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
      getHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        body = value;
      },
    },
    deps: {
      connectorTokens: {
        async connectorDerivedAuth(_host: string, _principal: string, accountType?: string) {
          requestedAccountTypes.push(accountType);
          return accountType === "company" ? { accessToken: "company-token" } : null;
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

test("Gmail upstream failures map to reconnect, not found, or retry responses without upstream bodies", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [upstream, status, message] of [
      [401, 409, "Reconnect Google to read sent mail."],
      [403, 409, "Reconnect Google to read sent mail."],
      [404, 404, "Couldn't load sent mail from Gmail. Try again."],
      [500, 502, "Couldn't load sent mail from Gmail. Try again."],
    ] as const) {
      let code = 0;
      let body = "";
      globalThis.fetch = async () => new Response("secret upstream detail", { status: upstream });
      await gmailSent({
        actor: { p: "eve@example.com" },
        url: new URL("http://localhost/v1/connectors/gmail/sent/m1"),
        params: { messageId: "m1" },
        res: {
          setHeader() {},
          getHeader() {},
          writeHead(value: number) {
            code = value;
          },
          end(value: string) {
            body = value;
          },
        },
        deps: { connectorTokens: { connectorDerivedAuth: async () => ({ accessToken: "token" }) } },
      } as unknown as ApiCtx);
      assert.equal(code, status);
      assert.deepEqual(JSON.parse(body), { error: "gmail_unavailable", message });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sent mail falls back to a named Google account after the built-in slots", async () => {
  const requested: Array<string | undefined> = [];
  let status = 0;
  let body = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: [] });
    if (url.pathname.endsWith("/profile")) return Response.json({ emailAddress: "ops@example.com" });
    return new Response(null, { status: 404 });
  };
  const ctx = {
    actor: { p: "eve@example.com" },
    url: new URL("http://localhost/v1/connectors/gmail/sent"),
    params: {},
    res: {
      setHeader() {},
      getHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        body = value;
      },
    },
    deps: {
      connectorTokens: {
        async listConnectorsByOwners(owners: string[]) {
          const meta = { credentialId: "c", ownerId: owners[0]!, connected: true };
          return new Map([
            [
              owners[0]!,
              [
                { ...meta, host: "gmail.googleapis.com", accountType: "ops@example.com" },
                { ...meta, host: "slack.com", accountType: "globex" },
              ],
            ],
          ]);
        },
        async connectorDerivedAuth(_host: string, _principal: string, accountType?: string) {
          requested.push(accountType);
          return accountType === "ops@example.com" ? { accessToken: "ops-token" } : null;
        },
      },
    },
  } as unknown as ApiCtx;
  try {
    await gmailSent(ctx);
    assert.equal(status, 200);
    assert.deepEqual(requested, ["default", "personal", "company", "ops@example.com"]);
    assert.equal(JSON.parse(body).accountType, "ops@example.com");
    requested.length = 0;
    ctx.url.searchParams.set("accountType", "Ops@Example.com");
    await gmailSent(ctx);
    assert.equal(status, 200);
    assert.deepEqual(requested, ["ops@example.com"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
