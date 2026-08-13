import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import {
  codexOAuthAccountId,
  parseCodexOAuthAuth,
  syncCodexOAuthAuthFile,
  writeCodexOAuthAuthFile,
  type CodexOAuthAuth,
} from "../src/harness/codex-auth.ts";
import { createDurableCodexOAuthAuthBackend, type StoredCodexOAuthAuth } from "../src/harness/codex-oauth-store.ts";

function token(accountId: string, marker: string): string {
  return [
    Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        iss: "https://auth.openai.com",
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
        marker,
      }),
    ).toString("base64url"),
    "signature",
  ].join(".");
}

function auth(accountId: string, marker: string): CodexOAuthAuth {
  return {
    auth_mode: "chatgpt",
    last_refresh: marker,
    tokens: {
      access_token: token(accountId, `access-${marker}`),
      refresh_token: `refresh-${marker}`,
      id_token: token(accountId, `id-${marker}`),
      account_id: accountId,
    },
  };
}

const verify = async (value: unknown): Promise<CodexOAuthAuth | null> => parseCodexOAuthAuth(value);
const verifyToken = async (value: string): Promise<string | undefined> =>
  codexOAuthAccountId({ auth_mode: "chatgpt", tokens: { id_token: value } });

test("durable Codex OAuth encrypts, rotates atomically, and survives a fresh backend", async (t) => {
  const backing = createMemoryMap<StoredCodexOAuthAuth>();
  const advisoryLock = createMemoryAdvisoryLock();
  const initial = auth("account-1", "initial");
  const first = createDurableCodexOAuthAuthBackend({
    orgId: "acme",
    backing,
    advisoryLock,
    keyMaterial: "secret-material".repeat(4),
    bootstrapBase64: Buffer.from(JSON.stringify(initial)).toString("base64"),
    verifyAuth: verify,
    now: () => 100,
  });
  t.after(() => first.close().catch(() => undefined));
  await first.ready();
  const storedInitial = await backing.get("acme");
  assert.ok(storedInitial);
  assert.equal(JSON.stringify(storedInitial).includes("refresh-initial"), false);
  assert.equal(storedInitial.version, 1);

  const lock = await first.acquire();
  assert.equal(statSync(first.path).mode & 0o077, 0);
  assert.deepEqual(JSON.parse(readFileSync(first.path, "utf8")), initial);
  const childDir = mkdtempSync(join(tmpdir(), "qm-codex-oauth-child-"));
  const childPath = join(childDir, "auth.json");
  t.after(() => rmSync(childDir, { recursive: true, force: true }));
  writeCodexOAuthAuthFile(childPath, auth("account-1", "rotated"));
  assert.equal(
    await syncCodexOAuthAuthFile(first.path, childPath, lock.path, undefined, undefined, initial, verifyToken),
    true,
  );
  await lock.release();
  assert.equal(existsSync(first.path), false);
  const storedRotated = await backing.get("acme");
  assert.ok(storedRotated);
  assert.equal(storedRotated.version, 2);
  assert.equal(JSON.stringify(storedRotated).includes("refresh-rotated"), false);
  await first.close();

  const restarted = createDurableCodexOAuthAuthBackend({
    orgId: "acme",
    backing,
    advisoryLock,
    keyMaterial: "secret-material".repeat(4),
    verifyAuth: verify,
  });
  t.after(() => restarted.close().catch(() => undefined));
  await restarted.ready();
  const restartedLock = await restarted.acquire();
  assert.deepEqual(JSON.parse(readFileSync(restarted.path, "utf8")), auth("account-1", "rotated"));
  await restartedLock.release();
});

test("durable Codex OAuth serializes instances and rehydrates after the preceding rotation", async (t) => {
  const backing = createMemoryMap<StoredCodexOAuthAuth>();
  const advisoryLock = createMemoryAdvisoryLock();
  const shared = {
    orgId: "acme",
    backing,
    advisoryLock,
    keyMaterial: "shared-secret-material".repeat(3),
    verifyAuth: verify,
  };
  const first = createDurableCodexOAuthAuthBackend({
    ...shared,
    bootstrapBase64: Buffer.from(JSON.stringify(auth("account-1", "initial"))).toString("base64"),
  });
  const second = createDurableCodexOAuthAuthBackend(shared);
  t.after(() => Promise.all([first.close().catch(() => undefined), second.close().catch(() => undefined)]));
  await first.ready();
  await second.ready();
  const firstLock = await first.acquire();
  await assert.doesNotReject(second.ready());
  let secondEntered = false;
  const secondLockPromise = second.acquire().then((lock) => {
    secondEntered = true;
    return lock;
  });
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 30));
  assert.equal(secondEntered, false);
  writeCodexOAuthAuthFile(first.path, auth("account-1", "from-first"));
  await firstLock.release();
  const secondLock = await secondLockPromise;
  assert.deepEqual(JSON.parse(readFileSync(second.path, "utf8")), auth("account-1", "from-first"));
  await secondLock.release();
});

test("durable Codex OAuth refuses a rotated credential for another account", async (t) => {
  const backing = createMemoryMap<StoredCodexOAuthAuth>();
  const backend = createDurableCodexOAuthAuthBackend({
    orgId: "acme",
    backing,
    advisoryLock: createMemoryAdvisoryLock(),
    keyMaterial: "secret-material".repeat(4),
    bootstrapBase64: Buffer.from(JSON.stringify(auth("account-1", "initial"))).toString("base64"),
    verifyAuth: verify,
  });
  t.after(() => backend.close().catch(() => undefined));
  await backend.ready();
  const lock = await backend.acquire();
  writeCodexOAuthAuthFile(backend.path, auth("account-2", "replacement"));
  await assert.rejects(lock.release(), /persistence refused/);
  assert.equal((await backing.get("acme"))?.accountId, "account-1");
  assert.equal(existsSync(backend.path), false);
});

test("closing during durable OAuth entry waits and prevents plaintext recreation", async () => {
  const memory = createMemoryMap<StoredCodexOAuthAuth>();
  let releaseGet!: () => void;
  const blocked = new Promise<void>((resolve) => {
    releaseGet = resolve;
  });
  let getStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    getStarted = resolve;
  });
  const backing: DurableMap<StoredCodexOAuthAuth> = {
    ...memory,
    async get(id) {
      getStarted();
      await blocked;
      return memory.get(id);
    },
  };
  const backend = createDurableCodexOAuthAuthBackend({
    orgId: "acme",
    backing,
    advisoryLock: createMemoryAdvisoryLock(),
    keyMaterial: "secret-material".repeat(4),
    bootstrapBase64: Buffer.from(JSON.stringify(auth("account-1", "initial"))).toString("base64"),
    verifyAuth: verify,
  });
  const acquiring = backend.acquire();
  await started;
  const closing = backend.close();
  releaseGet();
  await assert.rejects(acquiring, /backend is closed/);
  await closing;
  assert.equal(existsSync(backend.path), false);
});
