import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCodexDeviceLogin } from "../src/model/codex-device-login.ts";

function idToken(accountId: string): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "RS256", typ: "JWT" })}.${seg({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.sig`;
}

/** Fake `codex app-server` that serves the device-login RPCs and writes auth.json on approval. */
function loginBinary(dir: string, opts: { succeed: boolean; delayMs?: number }): string {
  const path = join(dir, `codex-login-${opts.succeed ? "ok" : "fail"}`);
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return send({ id: msg.id, result: {} });
  if (msg.method === "initialized") return;
  if (msg.method === "account/login/start") {
    send({ id: msg.id, result: { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" } });
    return setTimeout(() => {
      if (${JSON.stringify(opts.succeed)}) {
        fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { access_token: "acc-1", refresh_token: "ref-1", id_token: ${JSON.stringify(idToken("acct_9"))}, account_id: "acct_9" },
        }));
        send({ method: "account/login/completed", params: { loginId: "login-1", success: true, error: null } });
      } else {
        send({ method: "account/login/completed", params: { loginId: "login-1", success: false, error: "denied by user" } });
      }
    }, ${opts.delayMs ?? 30});
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

test("device login: start returns the prompt, poll is pending then yields tokens without exposing internals", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-device-login-test-"));
  const login = createCodexDeviceLogin({ binaryPath: loginBinary(dir, { succeed: true, delayMs: 120 }) });
  t.after(async () => {
    await login.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const prompt = await login.start();
  assert.equal(prompt.userCode, "ABCD-1234");
  assert.equal(prompt.verificationUrl, "https://auth.openai.com/codex/device");
  assert.equal(await login.poll(prompt.deviceAuthId), "pending");
  await new Promise((r) => setTimeout(r, 200));
  const tokens = await login.poll(prompt.deviceAuthId);
  assert.notEqual(tokens, "pending");
  if (tokens === "pending") return;
  assert.equal(tokens.accessToken, "acc-1");
  assert.equal(tokens.refreshToken, "ref-1");
  assert.equal(tokens.accountId, "acct_9");
  // The login is one-shot: after harvest it is gone.
  await assert.rejects(() => login.poll(prompt.deviceAuthId), /expired or unknown/);
});

test("device login: a denied login surfaces the provider error and cleans up", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-device-login-test-"));
  const login = createCodexDeviceLogin({ binaryPath: loginBinary(dir, { succeed: false, delayMs: 20 }) });
  t.after(async () => {
    await login.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const prompt = await login.start();
  await new Promise((r) => setTimeout(r, 120));
  await assert.rejects(() => login.poll(prompt.deviceAuthId), /denied by user/);
  await assert.rejects(() => login.poll(prompt.deviceAuthId), /expired or unknown/);
});
