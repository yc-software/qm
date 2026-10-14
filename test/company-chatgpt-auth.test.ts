import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chatgptAuthFromValue,
  fileCompanyChatGPTAuth,
  keychainCompanyChatGPTAuth,
} from "../src/model/company-chatgpt-auth.ts";
import type { CredentialFile, Keychain, KeychainCredentialMeta } from "../src/credentials/keychain.ts";
import type { UserOAuthTokens } from "../src/model/user-model-credential-store.ts";

function jwt(payload: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(payload)}.sig`;
}

function idToken(accountId: string): string {
  return jwt({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
}

function accessToken(accountId: string, expSec: number, marker = "a"): string {
  return jwt({ exp: expSec, marker, "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
}

function authJson(accountId: string, expSec: number, refreshToken = "refresh-1"): Record<string, unknown> {
  return {
    auth_mode: "chatgpt",
    tokens: {
      access_token: accessToken(accountId, expSec),
      refresh_token: refreshToken,
      id_token: idToken(accountId),
      account_id: accountId,
    },
  };
}

const NOW = 1_900_000_000_000;
const FRESH_EXP = Math.floor(NOW / 1000) + 3600;
const STALE_EXP = Math.floor(NOW / 1000) + 60;

interface FakeKeychainState {
  meta: KeychainCredentialMeta;
  files: CredentialFile[];
  saves: Array<{ ownerId: string; service: string; files?: CredentialFile[] }>;
  materializations: number;
}

function fakeKeychain(state: FakeKeychainState): Keychain {
  return {
    async getCredential(id: string) {
      return id === state.meta.id ? state.meta : null;
    },
    async materializeOwnFiles(ownerId: string) {
      state.materializations += 1;
      if (ownerId !== state.meta.ownerId) return [];
      return [{ credentialId: state.meta.id, ownerId, service: state.meta.service, files: state.files }];
    },
    async save(input: { ownerId: string; service: string; files?: CredentialFile[] }) {
      state.saves.push(input);
      if (input.files) state.files = input.files;
      state.meta = { ...state.meta, fingerprint: `f${state.saves.length}`, updatedAt: state.saves.length };
      return state.meta;
    },
  } as unknown as Keychain;
}

function credFiles(auth: Record<string, unknown>): CredentialFile[] {
  return [{ path: ".codex/auth.json", contentBase64: Buffer.from(JSON.stringify(auth)).toString("base64") }];
}

function keychainState(auth: Record<string, unknown>): FakeKeychainState {
  return {
    meta: {
      id: "cred-1",
      ownerId: "owner@example.com",
      service: "codex-chatgpt",
      kind: "file",
      fingerprint: "f0",
      createdAt: 0,
      updatedAt: 0,
    } as KeychainCredentialMeta,
    files: credFiles(auth),
    saves: [],
    materializations: 0,
  };
}

function refreshTo(accountId: string, refreshToken = "refresh-2") {
  const calls: string[] = [];
  const refresh = async (token: string): Promise<UserOAuthTokens> => {
    calls.push(token);
    return {
      accessToken: accessToken(accountId, FRESH_EXP, "refreshed"),
      idToken: idToken(accountId),
      refreshToken,
    };
  };
  return { calls, refresh };
}

test("chatgptAuthFromValue validates shape and account binding", () => {
  assert.ok(chatgptAuthFromValue(authJson("acct", FRESH_EXP)));
  assert.equal(chatgptAuthFromValue({ auth_mode: "apikey" }), null);
  const missingRefresh = authJson("acct", FRESH_EXP);
  delete (missingRefresh.tokens as Record<string, unknown>).refresh_token;
  assert.equal(chatgptAuthFromValue(missingRefresh), null);
});

test("keychain auth serves a fresh token without refreshing and caches the decrypted credential", async () => {
  const state = keychainState(authJson("acct", FRESH_EXP));
  const auth = keychainCompanyChatGPTAuth({
    keychain: fakeKeychain(state),
    credentialId: "cred-1",
    now: () => NOW,
    refresh: async () => assert.fail("must not refresh"),
  });
  assert.equal(await auth.accessToken(), accessToken("acct", FRESH_EXP));
  assert.equal(await auth.accessToken(), accessToken("acct", FRESH_EXP));
  assert.equal(state.materializations, 1);
  assert.equal(state.saves.length, 0);
  state.files = credFiles(authJson("acct", FRESH_EXP, "replaced"));
  state.meta = { ...state.meta, fingerprint: "re-registered", updatedAt: 5 };
  await auth.accessToken();
  assert.equal(state.materializations, 2);
});

test("keychain auth refreshes a stale token centrally and persists the rotation once", async () => {
  const state = keychainState(authJson("acct", STALE_EXP, "refresh-1"));
  const { calls, refresh } = refreshTo("acct");
  const auth = keychainCompanyChatGPTAuth({
    keychain: fakeKeychain(state),
    credentialId: "cred-1",
    now: () => NOW,
    refresh,
  });
  const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
  assert.equal(a, accessToken("acct", FRESH_EXP, "refreshed"));
  assert.equal(b, a);
  assert.deepEqual(calls, ["refresh-1"]);
  assert.equal(state.saves.length, 1);
  const persisted = JSON.parse(Buffer.from(state.saves[0]!.files![0]!.contentBase64, "base64").toString("utf8")) as {
    tokens: Record<string, unknown>;
  };
  assert.equal(persisted.tokens.refresh_token, "refresh-2");
  assert.equal(await auth.accessToken(), a);
  assert.equal(calls.length, 1);
});

test("keychain auth refuses a refresh that switches ChatGPT accounts", async () => {
  const state = keychainState(authJson("acct", STALE_EXP));
  const { refresh } = refreshTo("other-acct");
  const auth = keychainCompanyChatGPTAuth({
    keychain: fakeKeychain(state),
    credentialId: "cred-1",
    now: () => NOW,
    refresh,
  });
  assert.equal(await auth.accessToken(), accessToken("acct", STALE_EXP));
  assert.equal(state.saves.length, 0);
});

test("keychain auth is unavailable when the credential is missing", async () => {
  const state = keychainState(authJson("acct", FRESH_EXP));
  const auth = keychainCompanyChatGPTAuth({ keychain: fakeKeychain(state), credentialId: "other", now: () => NOW });
  assert.equal(await auth.accessToken(), undefined);
});

test("file auth serves the local login as-is and never refreshes or rewrites it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-chatgpt-file-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "auth.json");
  const stored = JSON.stringify(authJson("acct", STALE_EXP, "refresh-1"));
  writeFileSync(path, stored);
  chmodSync(path, 0o600);
  const fetches = t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 500 }));
  const auth = fileCompanyChatGPTAuth(path);
  assert.equal(await auth.accessToken(), accessToken("acct", STALE_EXP));
  assert.equal(fetches.mock.callCount(), 0);
  assert.equal(readFileSync(path, "utf8"), stored);
  chmodSync(path, 0o644);
  await assert.rejects(auth.accessToken(), /must not be readable by group or others/);
  writeFileSync(path, JSON.stringify(authJson("acct", 1_000_000_000)));
  chmodSync(path, 0o600);
  await assert.rejects(auth.accessToken(), /has expired; run the Codex CLI to refresh it/);
});
