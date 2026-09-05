import { test } from "node:test";
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QmConfig } from "../src/config.ts";
import { runPassword } from "../src/commands/password.ts";
import { hashPassword, normalizePasswordEmail, parsePasswordHashes, promptPasswordHash } from "../src/passwords.ts";
import { isInvalidSecret, readEnvFile } from "../src/util.ts";

const config: QmConfig = {
  contract: 1,
  orgId: "acme",
  publicUrl: "http://localhost:8082",
  target: "docker",
  services: ["core", "portal", "auth"],
  plugins: [],
  skills: [],
  env: { auth: { AUTH_LOGIN_METHOD: "password" } },
  imageOverrides: {},
};

function verifies(password: string, hash: string): boolean {
  const parts = hash.split("$");
  const derived = scryptSync(password, Buffer.from(parts[4]!, "base64url"), 64, {
    N: 32768,
    r: 8,
    p: 3,
    maxmem: 64 * 1024 * 1024,
  });
  return derived.equals(Buffer.from(parts[5]!, "base64url"));
}

test("password identities normalize case and whitespace and reject ambiguous addresses", () => {
  assert.equal(normalizePasswordEmail(" Admin+Alias@Example.com "), "admin+alias@example.com");
  assert.equal(normalizePasswordEmail(`${"a".repeat(242)}@example.com`).length, 254);
  for (const email of [
    "admin,alias@example.com",
    "admin;alias@example.com",
    "<admin@example.com>",
    '"admin"@example.com',
    "admin alias@example.com",
    "admin@example.com\nother@example.com",
    `${"a".repeat(243)}@example.com`,
    "admin@example",
    "admin@@example.com",
  ])
    assert.throws(() => normalizePasswordEmail(email), /valid email address/);
});

test("password hashing preserves spaces and Unicode and produces fresh verifiable hashes", async () => {
  const password = ` ${"🔒".repeat(13)} `;
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.ok(verifies(password, first));
  assert.ok(!verifies(password.trim(), first));
  assert.equal(isInvalidSecret("AUTH_PASSWORD_HASHES", JSON.stringify({ "admin@example.com": first })), false);
  await assert.rejects(hashPassword("🔒".repeat(14)), /15 to 128/);
  await assert.rejects(hashPassword("a".repeat(129)), /15 to 128/);
  assert.ok(verifies("a".repeat(128), await hashPassword("a".repeat(128))));
});

test("password collection refuses confirmation mismatch without returning a hash", async () => {
  const answers = ["first password here", "different password here"];
  await assert.rejects(
    promptPasswordHash("admin@example.com", async () => answers.shift()!),
    /do not match/,
  );
});

test("malformed password secrets are rejected without exposing their contents", async () => {
  const hash = await hashPassword("correct horse battery staple");
  for (const value of [
    "plaintext-secret",
    "null",
    "[]",
    "{}",
    JSON.stringify({ "Admin@example.com": hash }),
    JSON.stringify({ " admin@example.com": hash }),
    JSON.stringify({ "admin@example.com": "plaintext-secret" }),
    JSON.stringify({ "admin@example.com": hash.replace("32768", "16384") }),
    JSON.stringify({ "admin@example.com": `${hash.slice(0, -1)}B` }),
  ]) {
    assert.equal(isInvalidSecret("AUTH_PASSWORD_HASHES", value), true);
    assert.throws(
      () => parsePasswordHashes(value),
      (error: unknown) => {
        assert.match((error as Error).message, /AUTH_PASSWORD_HASHES/);
        assert.ok(!(error as Error).message.includes("plaintext-secret"));
        assert.ok(!(error as Error).message.includes(hash));
        return true;
      },
    );
  }
});

test("qm password provisions and resets one identity, retains others, and saves only hashes privately", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-password-"));
  const path = join(dir, ".env");
  const prior = await hashPassword("an existing password here");
  writeFileSync(
    path,
    `KEEP_ME=untouched\nAUTH_ALLOWED_EMAILS=other@example.com\nAUTH_PASSWORD_HASHES=${JSON.stringify({ "other@example.com": prior })}\n`,
    { mode: 0o644 },
  );
  const password = " my new password here ";
  try {
    await runPassword({ config, configDir: dir, email: " Admin@Example.com ", askHidden: async () => password });
    const first = readEnvFile(path);
    const hashes = parsePasswordHashes(first.get("AUTH_PASSWORD_HASHES")!);
    assert.equal(first.get("AUTH_ALLOWED_EMAILS"), "other@example.com");
    assert.equal(first.get("KEEP_ME"), "untouched");
    assert.equal(hashes["other@example.com"], prior);
    assert.ok(verifies(password, hashes["admin@example.com"]!));
    assert.ok(!readFileSync(path, "utf8").includes(password));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    await runPassword({
      config,
      configDir: dir,
      email: "admin@example.com",
      askHidden: async () => "replacement password here",
    });
    const updated = parsePasswordHashes(readEnvFile(path).get("AUTH_PASSWORD_HASHES")!);
    assert.ok(verifies("replacement password here", updated["admin@example.com"]!));
    assert.ok(!verifies(password, updated["admin@example.com"]!));
    assert.equal(updated["other@example.com"], prior);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("qm password refuses email mode before prompting or writing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-password-refuse-"));
  try {
    await assert.rejects(
      runPassword({
        config: { ...config, env: { auth: { AUTH_LOGIN_METHOD: "email" } } },
        configDir: dir,
        email: "admin@example.com",
        askHidden: async () => {
          throw new Error("unexpected prompt");
        },
      }),
      /requires the auth service/,
    );
    assert.deepEqual(readEnvFile(join(dir, ".env")), new Map());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("qm password preserves exported accounts and gives an external identity credentials without permanent membership", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-password-external-"));
  const original = process.env.AUTH_PASSWORD_HASHES;
  const prior = await hashPassword("existing account password");
  process.env.AUTH_PASSWORD_HASHES = JSON.stringify({ "admin@example.com": prior });
  try {
    await runPassword({
      config: { ...config, env: { auth: { AUTH_LOGIN_METHOD: "password", AUTH_ALLOWED_EMAIL_DOMAIN: "example.com" } } },
      configDir: dir,
      email: "guest@external.com",
      askHidden: async () => "new guest password here",
    });
    const env = readEnvFile(join(dir, ".env"));
    const hashes = parsePasswordHashes(env.get("AUTH_PASSWORD_HASHES")!);
    assert.equal(hashes["admin@example.com"], prior);
    assert.ok(verifies("new guest password here", hashes["guest@external.com"]!));
    assert.equal(env.get("AUTH_ALLOWED_EMAILS"), undefined);
  } finally {
    if (original === undefined) delete process.env.AUTH_PASSWORD_HASHES;
    else process.env.AUTH_PASSWORD_HASHES = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
