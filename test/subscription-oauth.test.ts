import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { generateCodeVerifier } from "../src/connectors/oauth.ts";
import { completeClaudeLogin, startClaudeLogin } from "../src/model/subscription-oauth.ts";

test("generateCodeVerifier mints fresh high-entropy base64url verifiers", () => {
  const a = generateCodeVerifier();
  const b = generateCodeVerifier();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});

test("startClaudeLogin keeps the verifier out of the authorize URL", () => {
  const { authorizeUrl, verifier, state } = startClaudeLogin();
  const url = new URL(authorizeUrl);
  assert.ok(!authorizeUrl.includes(verifier));
  assert.equal(url.searchParams.get("state"), state);
  assert.notEqual(state, verifier);
  assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(verifier).digest("base64url"));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("completeClaudeLogin exchanges the pasted state and the held verifier", async () => {
  const { verifier } = startClaudeLogin();
  let exchanged: Record<string, unknown> | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    exchanged = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 60 }), {
      status: 200,
    });
  }) as typeof fetch;
  try {
    const tokens = await completeClaudeLogin("the-code#the-state", verifier);
    assert.equal(tokens.accessToken, "at");
    assert.equal(exchanged?.code, "the-code");
    assert.equal(exchanged?.state, "the-state");
    assert.equal(exchanged?.code_verifier, verifier);

    await completeClaudeLogin("bare-code", verifier, "expected-state");
    assert.equal(exchanged?.code, "bare-code");
    assert.equal(exchanged?.state, "expected-state");

    await assert.rejects(
      () => completeClaudeLogin("the-code#other-state", verifier, "expected-state"),
      /different login attempt/,
    );
    await assert.rejects(() => completeClaudeLogin("bare-code", verifier), /including the part after the #/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
