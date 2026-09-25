import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, parsePasswordHash, passwordProblem, verifyPassword } from "../src/password.ts";
import { bootProblems, parsePasswordUsers, passwordConfigured, readConfig } from "../src/config.ts";
import { testEnv } from "./helpers.ts";

const PASSWORD = "correct horse battery staple";

test("hashPassword produces a self-describing scrypt hash with a fresh salt every time", async () => {
  const a = await hashPassword(PASSWORD);
  const b = await hashPassword(PASSWORD);
  assert.notEqual(a, b);
  assert.match(a, /^scrypt\$15\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.ok(parsePasswordHash(a));
  assert.ok(!a.includes(PASSWORD));
});

test("verifyPassword accepts the right password and refuses the wrong one", async () => {
  const stored = await hashPassword(PASSWORD);
  assert.equal(await verifyPassword(PASSWORD, stored), true);
  assert.equal(await verifyPassword(`${PASSWORD} `, stored), false);
  assert.equal(await verifyPassword("", stored), false);
});

test("verifyPassword refuses when no hash or a malformed hash is stored, taking the same code path", async () => {
  assert.equal(await verifyPassword(PASSWORD, undefined), false);
  assert.equal(await verifyPassword(PASSWORD, "plaintext-password"), false);
  assert.equal(await verifyPassword(PASSWORD, "scrypt$15$8$1$short$short"), false);
  assert.equal(await verifyPassword("x".repeat(2000), await hashPassword(PASSWORD)), false);
});

test("parsePasswordHash rejects unsafe or foreign parameters", () => {
  const good = "scrypt$15$8$1$IkNbPCoGdHpvuEgON4o1vA$EHD6YCiYNlcxXuuQxmnMkjkdFvBH1Jd1WlP1Lnl-a5w";
  assert.ok(parsePasswordHash(good));
  assert.equal(parsePasswordHash(good.replace("scrypt", "bcrypt")), null);
  assert.equal(parsePasswordHash(good.replace("$15$", "$4$")), null);
  assert.equal(parsePasswordHash(good.replace("$15$", "$40$")), null);
  assert.equal(parsePasswordHash(good.slice(0, -1)), null);
  assert.equal(parsePasswordHash(`${good}$extra`), null);
});

test("passwordProblem enforces a minimum length", () => {
  assert.equal(passwordProblem("short"), "passwords must be at least 12 characters");
  assert.equal(passwordProblem(PASSWORD), null);
});

test("parsePasswordUsers reads comma or whitespace separated email:hash entries", async () => {
  const hash = await hashPassword(PASSWORD);
  const { users, problems } = parsePasswordUsers(`Admin@Example.com:${hash}, ops@example.com:${hash}\n`);
  assert.deepEqual(problems, []);
  assert.deepEqual([...users.keys()], ["admin@example.com", "ops@example.com"]);
  assert.equal(users.get("admin@example.com"), hash);
});

test("parsePasswordUsers reports malformed entries, plaintext passwords, and duplicates", async () => {
  const hash = await hashPassword(PASSWORD);
  const { users, problems } = parsePasswordUsers(
    `admin@example.com:${hash},not-an-email:${hash},ops@example.com:hunter2hunter2,admin@example.com:${hash}`,
  );
  assert.equal(users.size, 1);
  assert.equal(problems.length, 3);
  assert.ok(problems.some((p) => p.includes("<email>:<hash>")));
  assert.ok(problems.some((p) => p.includes("ops@example.com")));
  assert.ok(problems.some((p) => p.includes("more than once")));
});

test("password sign-in is off unless AUTH_PASSWORD_USERS is set, and bad entries refuse boot", async () => {
  const off = readConfig(testEnv());
  assert.equal(passwordConfigured(off), false);
  assert.deepEqual(
    bootProblems(off, true).filter((p) => p.includes("PASSWORD")),
    [],
  );

  const hash = await hashPassword(PASSWORD);
  const on = readConfig(testEnv({ AUTH_PASSWORD_USERS: `admin@example.com:${hash}` }));
  assert.equal(passwordConfigured(on), true);
  assert.deepEqual(
    bootProblems(on, true).filter((p) => p.includes("PASSWORD")),
    [],
  );

  const bad = readConfig(testEnv({ AUTH_PASSWORD_USERS: "admin@example.com:hunter2hunter2" }));
  assert.equal(passwordConfigured(bad), false);
  assert.ok(bootProblems(bad, true).some((p) => p.includes("AUTH_PASSWORD_USERS")));

  const limits = readConfig(
    testEnv({ AUTH_PASSWORD_USERS: `admin@example.com:${hash}`, AUTH_PASSWORD_LIMIT_PER_IP: "999" }),
  );
  assert.ok(bootProblems(limits, true).some((p) => p.includes("AUTH_PASSWORD_LIMIT_PER_IP")));
});
