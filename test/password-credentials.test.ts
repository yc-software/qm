import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  createPasswordCredentialStore,
  hashPassword,
  passwordMatches,
  passwordProblem,
  type PasswordCredential,
} from "../src/auth/password-credentials.ts";

const store = () => createPasswordCredentialStore(createMemoryMap<PasswordCredential>());

test("the stored value is a tagged hash, never the password", async () => {
  const s = store();
  await s.set("Ops@Example.com", "correct horse", "admin@example.com", true);
  const row = await s.get("ops@example.com");
  assert.ok(row);
  assert.match(row.hash, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(row.hash, /correct horse/);
  assert.equal(row.mustChange, true);
  assert.equal(row.updatedBy, "admin@example.com");
});

test("the identifier is a person key, so case does not create a second account", async () => {
  const s = store();
  await s.set("Ops@Example.com", "correct horse", "admin", false);
  const verdict = await s.verify("OPS@example.COM", "correct horse");
  assert.equal(verdict.ok, true);
  assert.equal((await s.list()).length, 1);
});

test("a wrong password and an unknown identifier both refuse, and neither says which", async () => {
  const s = store();
  await s.set("ops@example.com", "correct horse", "admin", false);
  assert.deepEqual(await s.verify("ops@example.com", "wrong"), { ok: false, reason: "no-match" });
  assert.deepEqual(await s.verify("nobody@example.com", "wrong"), { ok: false, reason: "no-match" });
});

test("a credential store that cannot answer refuses rather than admits", async () => {
  const broken = createPasswordCredentialStore({
    ...createMemoryMap<PasswordCredential>(),
    async get(): Promise<PasswordCredential | null> {
      throw new Error("database is away");
    },
  });
  const verdict = await broken.verify("ops@example.com", "anything");
  assert.deepEqual(verdict, { ok: false, reason: "unavailable" });
});

test("changing a password verifies the old one and clears the change requirement", async () => {
  const s = store();
  await s.set("ops@example.com", "issued-by-admin", "admin", true);
  assert.equal((await s.change("ops@example.com", "wrong", "a-longer-one")).ok, false);
  const changed = await s.change("ops@example.com", "issued-by-admin", "a-longer-one");
  assert.equal(changed.ok, true);
  const row = await s.get("ops@example.com");
  assert.equal(row!.mustChange, false);
  assert.equal((await s.verify("ops@example.com", "a-longer-one")).ok, true);
  assert.equal((await s.verify("ops@example.com", "issued-by-admin")).ok, false);
});

test("a password shorter than the minimum is refused, at set and at change", async () => {
  const s = store();
  assert.equal(passwordProblem("short"), "a password must be at least 8 characters");
  assert.equal(passwordProblem("longenough"), null);
  await assert.rejects(() => s.set("ops@example.com", "short", "admin", true), /at least 8/);
  await s.set("ops@example.com", "issued-by-admin", "admin", true);
  await assert.rejects(() => s.change("ops@example.com", "issued-by-admin", "short"), /at least 8/);
});

test("a hash is rejected when its parameters are outside the accepted range", async () => {
  const real = await hashPassword("correct horse");
  assert.equal(await passwordMatches(real, "correct horse"), true);
  assert.equal(await passwordMatches(real, "correct horsE"), false);
  assert.equal(await passwordMatches("argon2id$x$y", "correct horse"), false);
  assert.equal(await passwordMatches(real.replace(/^scrypt\$\d+/, "scrypt$2"), "correct horse"), false);
  assert.equal(await passwordMatches("scrypt$32768$8$1$$", "correct horse"), false);
});

test("removing a credential leaves nothing to verify against", async () => {
  const s = store();
  await s.set("ops@example.com", "correct horse", "admin", false);
  await s.remove("ops@example.com");
  assert.equal(await s.get("ops@example.com"), null);
  assert.equal((await s.verify("ops@example.com", "correct horse")).ok, false);
});
