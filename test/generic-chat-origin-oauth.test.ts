import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createGenericChatClient,
  GenericChatHttpError,
  genericChatOriginOAuthSchema,
} from "../src/surfaces/generic-chat/client.ts";
import { genericChatAccount, signGenericChatRequest } from "../src/surfaces/generic-chat/protocol.ts";

const originOAuth = {
  tokenUrl: "https://auth.example.test/token",
  clientId: "client",
  clientSecret: "secret",
  scope: "callbacks/send",
};
const origin = "https://one.dev.example.test";
const secret = "signing-secret";
const account = genericChatAccount("7000", origin);

function fixture(tokenStatus = 200) {
  let time = 1_800_000_000_000;
  const requests: { url: string; init: RequestInit }[] = [];
  let issued = 0;
  const client = createGenericChatClient({
    url: "https://chat.example.test",
    secret,
    originOAuth,
    allowedOrigins: ["https://*.dev.example.test"],
    now: () => time,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return String(url) === originOAuth.tokenUrl
        ? Response.json(
            tokenStatus === 200
              ? { access_token: `token-${++issued}`, token_type: "Bearer", expires_in: 60 }
              : { error: "temporarily_unavailable" },
            { status: tokenStatus },
          )
        : Response.json({});
    },
  });
  return {
    client,
    requests,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test("concurrent callbacks reuse service tokens and renew before expiry while keeping request signatures", async () => {
  const { client, requests, advance } = fixture();
  await Promise.all([client.call(account, "/agent_app/messages", {}), client.call(account, "/agent_app/typing", {})]);
  assert.equal(requests.filter((r) => r.url === originOAuth.tokenUrl).length, 1);
  assert.equal(new URLSearchParams(String(requests[0]!.init.body)).get("grant_type"), "client_credentials");
  for (const { url, init } of requests.slice(1)) {
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer token-1");
    assert.equal(
      headers.get("x-agent-app-signature"),
      signGenericChatRequest(
        secret,
        headers.get("x-agent-app-request-timestamp")!,
        "7000",
        new URL(url).pathname,
        String(init.body),
      ),
    );
    assert.equal(init.redirect, "error");
  }
  advance(45_000);
  await client.call(account, "/agent_app/messages", {});
  assert.equal(new Headers(requests.at(-1)!.init.headers).get("authorization"), "Bearer token-2");
});

test("base callbacks carry no service token and rejected origins never obtain credentials", async () => {
  const { client, requests } = fixture();
  await client.call("7000", "/agent_app/messages", {});
  assert.equal(new Headers(requests[0]!.init.headers).has("authorization"), false);
  await assert.rejects(
    client.call(genericChatAccount("7000", "https://attacker.example.test"), "/agent_app/messages", {}),
    /unsupported origin/,
  );
  assert.equal(requests.length, 1);
});

test("token failures stop callbacks and do not poison subsequent token requests", async () => {
  const { client, requests } = fixture(401);
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(
      client.call(account, "/agent_app/messages", {}),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof GenericChatHttpError) &&
        error.message.includes("origin authentication failed"),
    );
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.url === originOAuth.tokenUrl));
});

test("origin credentials require an HTTPS token endpoint without embedded credentials", () => {
  for (const tokenUrl of ["http://auth.example.test/token", "https://user:password@auth.example.test/token"]) {
    assert.equal(genericChatOriginOAuthSchema.safeParse({ ...originOAuth, tokenUrl }).success, false);
  }
});
