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
