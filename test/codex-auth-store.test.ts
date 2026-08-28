import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  childCodexOAuthAuth,
  codexOAuthAccessTokenExpiresAt,
  codexOAuthAuthFromValue,
  fileCodexAuthStore,
  keychainCodexAuthStore,
} from "../src/harness/codex-auth-store.ts";
import type { CredentialFile, Keychain, KeychainCredentialMeta } from "../src/credentials/keychain.ts";

function jwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256" }): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc(header)}.${enc(payload)}.sig`;
}

function idToken(accountId: string): string {
  return jwt({
    iss: "https://auth.openai.com",
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  });
}

function accessToken(accountId: string, expSec: number, marker = "a"): string {
  return jwt({
    iss: "https://auth.openai.com",
    exp: expSec,
    marker,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  });
}

function authJson(
  accountId: string,
  expSec: number,
  refreshToken = "refresh-1",
  marker = "a",
): Record<string, unknown> {
  return {
    auth_mode: "chatgpt",
    tokens: {
      access_token: accessToken(accountId, expSec, marker),
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
}

function fakeKeychain(state: FakeKeychainState): Keychain {
  return {
    async getCredential(id: string) {
      return id === state.meta.id ? state.meta : null;
    },
    async materializeOwnFiles(ownerId: string) {
      if (ownerId !== state.meta.ownerId) return [];
      return [{ credentialId: state.meta.id, ownerId, service: state.meta.service, files: state.files }];
    },
    async save(input: { ownerId: string; service: string; files?: CredentialFile[] }) {
      state.saves.push(input);
      if (input.files) state.files = input.files;
      return state.meta;
    },
  } as unknown as Keychain;
}

function credFiles(auth: Record<string, unknown>): CredentialFile[] {
  return [{ path: ".codex/auth.json", contentBase64: Buffer.from(JSON.stringify(auth)).toString("base64") }];
}

const META = {
  id: "cred-1",
  ownerId: "owner@example.com",
  service: "codex-chatgpt",
  kind: "file",
  fingerprint: "f",
  createdAt: 0,
  updatedAt: 0,
} as KeychainCredentialMeta;

test("child auth material never includes the refresh token", () => {
  const auth = authJson("acct", FRESH_EXP);
  const child = childCodexOAuthAuth(auth);
  const tokens = child.tokens as Record<string, unknown>;
  assert.equal(tokens.refresh_token, undefined);
  assert.equal(tokens.access_token, (auth.tokens as Record<string, unknown>).access_token);
  assert.equal(tokens.id_token, (auth.tokens as Record<string, unknown>).id_token);
  assert.equal(child.auth_mode, "chatgpt");
});

test("codexOAuthAuthFromValue validates shape and account binding", () => {
  assert.ok(codexOAuthAuthFromValue(authJson("acct", FRESH_EXP)));
  assert.equal(codexOAuthAuthFromValue({ auth_mode: "apikey" }), null);
  const missingRefresh = authJson("acct", FRESH_EXP);
  delete (missingRefresh.tokens as Record<string, unknown>).refresh_token;
  assert.equal(codexOAuthAuthFromValue(missingRefresh), null);
});

test("keychain store returns fresh auth without refreshing", async () => {
  const state: FakeKeychainState = { meta: META, files: credFiles(authJson("acct", FRESH_EXP)), saves: [] };
  const store = keychainCodexAuthStore({
    keychain: fakeKeychain(state),
    credentialId: "cred-1",
    now: () => NOW,
    fetchImpl: () => {
      throw new Error("must not refresh");
    },
  });
  const auth = await store.load();
  assert.ok(auth);
  assert.equal(state.saves.length, 0);
});

test("keychain store refreshes a stale access token centrally and persists rotation", async () => {
  const state: FakeKeychainState = {
    meta: META,
    files: credFiles(authJson("acct", STALE_EXP, "refresh-1")),
    saves: [],
  };
  const calls: Array<Record<string, unknown>> = [];
  const store = keychainCodexAuthStore({
    keychain: fakeKeychain(state),
    credentialId: "cred-1",
    now: () => NOW,
    fetchImpl: (async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body) as Record<string, unknown>);
      return {
        ok: true,
        json: async () => ({
          access_token: accessToken("acct", FRESH_EXP, "refreshed"),
          id_token: idToken("acct"),
          refresh_token: "refresh-2",
        }),
      };
    }) as unknown as typeof fetch,
  });
  const auth = await store.load();
  assert.ok(auth);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.grant_type, "refresh_token");
  assert.equal(calls[0]?.refresh_token, "refresh-1");
  const tokens = auth!.tokens as Record<string, unknown>;
  assert.equal(tokens.refresh_token, "refresh-2");
  assert.equal(state.saves.length, 1);
  const persisted = JSON.parse(
    Buffer.from(state.saves[0]!.files![0]!.contentBase64, "base64").toString("utf8"),
  ) as Record<string, unknown>;
  assert.equal((persisted.tokens as Record<string, unknown>).refresh_token, "refresh-2");
});

test("keychain store refuses a refresh that switches accounts", async () => {
  const state: FakeKeychainState = { meta: META, files: credFiles(authJson("acct", STALE_EXP)), saves: [] };
  const store = keychainCodexAuthStore({
    keychain: fakeKeychain(state),
    credentialId: "cred-1",
    now: () => NOW,
    fetchImpl: (async () => ({
      ok: true,
      json: async () => ({
        access_token: accessToken("other-acct", FRESH_EXP),
        id_token: idToken("other-acct"),
        refresh_token: "refresh-2",
      }),
    })) as unknown as typeof fetch,
  });
  const auth = await store.load();
  // Falls back to the (stale) stored auth rather than adopting a different account.
  assert.ok(auth);
  assert.equal((auth!.tokens as Record<string, unknown>).refresh_token, "refresh-1");
  assert.equal(state.saves.length, 0);
});

test("keychain store surfaces null when the credential is missing", async () => {
  const state: FakeKeychainState = { meta: META, files: credFiles(authJson("acct", FRESH_EXP)), saves: [] };
  const store = keychainCodexAuthStore({ keychain: fakeKeychain(state), credentialId: "other", now: () => NOW });
  assert.equal(await store.load(), null);
});

test("file store refreshes a stale token and writes back under the lock with compare-and-set", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-store-file-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify(authJson("acct", STALE_EXP, "refresh-1")));
  chmodSync(path, 0o600);
  const store = fileCodexAuthStore(
    path,
    (async () => ({
      ok: true,
      json: async () => ({
        access_token: accessToken("acct", FRESH_EXP, "refreshed"),
        id_token: idToken("acct"),
        refresh_token: "refresh-2",
      }),
    })) as unknown as typeof fetch,
    () => NOW,
  );
  const auth = await store.load();
  assert.ok(auth);
  assert.equal((auth!.tokens as Record<string, unknown>).refresh_token, "refresh-2");
  const persisted = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal((persisted.tokens as Record<string, unknown>).refresh_token, "refresh-2");
  assert.equal(codexOAuthAccessTokenExpiresAt(persisted), FRESH_EXP * 1000);
});

test("file store keeps serving current auth when the refresh endpoint fails", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-codex-store-file-fail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify(authJson("acct", STALE_EXP, "refresh-1")));
  chmodSync(path, 0o600);
  const store = fileCodexAuthStore(
    path,
    (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch,
    () => NOW,
  );
  const auth = await store.load();
  assert.ok(auth);
  assert.equal((auth!.tokens as Record<string, unknown>).refresh_token, "refresh-1");
});
