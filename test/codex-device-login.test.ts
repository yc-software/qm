import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createCodexDeviceLogin } from "../src/model/codex-device-login.ts";

function accessToken(accountId: string): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "RS256", typ: "JWT" })}.${seg({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.sig`;
}

interface FakeAuthServer {
  approve(): void;
  deny(): void;
  calls: Array<{ url: string; body: string }>;
}

function fakeAuthServer(t: TestContext, opts: { userCodeStatus?: number } = {}): FakeAuthServer {
  let decision: "pending" | "approved" | "denied" = "pending";
  const calls: Array<{ url: string; body: string }> = [];
  const json = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? "") });
    if (url.endsWith("/api/accounts/deviceauth/usercode")) {
      if (opts.userCodeStatus) return json(opts.userCodeStatus, { error: "unavailable" });
      return json(200, { device_auth_id: "device-1", user_code: "ABCD-1234", interval: "1" });
    }
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      if (decision === "approved")
        return json(200, { authorization_code: "code-1", code_challenge: "c", code_verifier: "verifier-1" });
      if (decision === "denied") return json(400, { error: { code: "access_denied", message: "denied by user" } });
      return json(403, { error: { code: "deviceauth_authorization_pending" } });
    }
    if (url.endsWith("/oauth/token"))
      return json(200, { access_token: accessToken("acct_9"), refresh_token: "ref-1", expires_in: 3600 });
    return json(404, {});
  });
  return {
    approve: () => (decision = "approved"),
    deny: () => (decision = "denied"),
    calls,
  };
}

async function settle(poll: () => Promise<unknown>): Promise<unknown> {
  for (let i = 0; i < 60; i += 1) {
    const result = await poll().catch((error: unknown) => error);
    if (result !== "pending") return result;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("login never settled");
}

test("device login: start returns the prompt, poll is pending then yields subscription tokens", async (t) => {
  const server = fakeAuthServer(t);
  const login = createCodexDeviceLogin();
  t.after(() => login.close());
  const prompt = await login.start();
  assert.equal(prompt.userCode, "ABCD-1234");
  assert.equal(prompt.verificationUrl, "https://auth.openai.com/codex/device");
  assert.equal(prompt.intervalMs, 1000);
  assert.equal(await login.poll(prompt.deviceAuthId), "pending");
  server.approve();
  const tokens = await settle(() => login.poll(prompt.deviceAuthId));
  assert.ok(tokens && typeof tokens === "object" && "accessToken" in tokens);
  assert.equal(tokens.accessToken, accessToken("acct_9"));
  assert.equal((tokens as { refreshToken?: string }).refreshToken, "ref-1");
  assert.equal((tokens as { accountId?: string }).accountId, "acct_9");
  const exchange = server.calls.find((call) => call.url.endsWith("/oauth/token"));
  assert.match(exchange?.body ?? "", /code_verifier=verifier-1/);
  assert.match(exchange?.body ?? "", /deviceauth%2Fcallback/);
  await assert.rejects(() => login.poll(prompt.deviceAuthId), /expired or unknown/);
});

test("device login: a denied login surfaces the provider error and cleans up", async (t) => {
  const server = fakeAuthServer(t);
  const login = createCodexDeviceLogin();
  t.after(() => login.close());
  const prompt = await login.start();
  server.deny();
  const error = await settle(() => login.poll(prompt.deviceAuthId));
  assert.match(String(error), /denied by user/);
  await assert.rejects(() => login.poll(prompt.deviceAuthId), /expired or unknown/);
});

test("device login: a provider failure before the prompt rejects start", async (t) => {
  fakeAuthServer(t, { userCodeStatus: 500 });
  const login = createCodexDeviceLogin();
  t.after(() => login.close());
  await assert.rejects(() => login.start(), /device code request failed with status 500/);
});
