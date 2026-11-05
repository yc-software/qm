import test from "node:test";
import assert from "node:assert/strict";
import {
  completeClaudeLogin,
  refreshChatGPTTokens,
  refreshClaudeTokens,
  startClaudeLogin,
} from "../src/model/subscription-oauth.ts";

const jwt = (claims: object) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

function mockToken(t: test.TestContext, status: number, body: unknown) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

test("ChatGPT refresh posts the refresh grant and maps the rotated tokens", async (t) => {
  const idToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
  const calls = mockToken(t, 200, { access_token: "at-2", refresh_token: "rt-2", id_token: idToken, expires_in: 60 });
  const before = Date.now();
  const tokens = await refreshChatGPTTokens("rt-1");
  assert.equal(calls[0]!.url, "https://auth.openai.com/oauth/token");
  assert.deepEqual(calls[0]!.body, {
    grant_type: "refresh_token",
    refresh_token: "rt-1",
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    scope: "openid profile email offline_access",
  });
  assert.equal(tokens.accessToken, "at-2");
  assert.equal(tokens.refreshToken, "rt-2");
  assert.equal(tokens.idToken, idToken);
  assert.equal(tokens.accountId, "acct-1");
  assert.ok(tokens.expiresAt! >= before + 60_000 && tokens.expiresAt! <= Date.now() + 60_000);
});

test("ChatGPT refresh keeps the old refresh token and reads expiry from the access token", async (t) => {
  const access = jwt({ exp: 2_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "acct-2" } });
  mockToken(t, 200, { access_token: access });
  const tokens = await refreshChatGPTTokens("rt-1");
  assert.equal(tokens.refreshToken, "rt-1");
  assert.equal(tokens.accountId, "acct-2");
  assert.equal(tokens.expiresAt, 2_000_000_000_000);
});

test("token responses without an access token are rejected", async (t) => {
  mockToken(t, 200, { refresh_token: "rt-2" });
  await assert.rejects(refreshChatGPTTokens("rt-1"), /chatgpt refresh .*missing access_token/);
  await assert.rejects(refreshClaudeTokens("rt-1"), /claude refresh .*missing access_token/);
  await assert.rejects(completeClaudeLogin("code", "verifier"), /claude token .*missing access_token/);
});

test("Claude login builds a PKCE authorize URL and exchanges the pasted code", async (t) => {
  const start = startClaudeLogin();
  const url = new URL(start.authorizeUrl);
  assert.equal(url.origin + url.pathname, "https://claude.ai/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "https://platform.claude.com/oauth/code/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), start.verifier);
  assert.ok(url.searchParams.get("code_challenge"));

  const calls = mockToken(t, 200, { access_token: "cat-1", refresh_token: "crt-1", expires_in: 3600 });
  const tokens = await completeClaudeLogin("  the-code#the-state \n", start.verifier);
  assert.equal(calls[0]!.url, "https://console.anthropic.com/v1/oauth/token");
  assert.deepEqual(calls[0]!.body, {
    grant_type: "authorization_code",
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    code: "the-code",
    state: "the-state",
    code_verifier: start.verifier,
    redirect_uri: "https://platform.claude.com/oauth/code/callback",
  });
  assert.equal(tokens.accessToken, "cat-1");
  assert.equal(tokens.refreshToken, "crt-1");
  assert.ok(tokens.expiresAt! > Date.now());

  const withoutState = mockToken(t, 200, { access_token: "cat-2" });
  const second = await completeClaudeLogin("code-only", "v-2");
  assert.equal(withoutState[0]!.body.state, "v-2");
  assert.equal(second.refreshToken, undefined);
});

test("token endpoint failures carry the provider status and detail", async (t) => {
  mockToken(t, 400, { error: "invalid_grant", error_description: "refresh token revoked" });
  await assert.rejects(refreshChatGPTTokens("rt-1"), /^Error: chatgpt refresh failed \(400\).*refresh token revoked/);
  await assert.rejects(completeClaudeLogin("code", "v"), /^Error: claude token exchange failed \(400\)/);
  await assert.rejects(refreshClaudeTokens("rt"), /^Error: claude refresh failed \(400\)/);
});

test("Claude refresh posts the refresh grant and keeps the old refresh token when none is returned", async (t) => {
  const calls = mockToken(t, 200, { access_token: "cat-3", expires_in: 10 });
  const tokens = await refreshClaudeTokens("crt-old");
  assert.deepEqual(calls[0]!.body, {
    grant_type: "refresh_token",
    refresh_token: "crt-old",
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  });
  assert.equal(tokens.accessToken, "cat-3");
  assert.equal(tokens.refreshToken, "crt-old");
});
