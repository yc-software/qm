import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  personKey,
  personKeys,
  samePerson,
  samePersonInDirectory,
  samePersonMatcher,
} from "../src/directory/person.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { canAdministerCron, canAdministerWebhook, resolveRunAsChange } from "../src/api/control-service.ts";
import type { Cron, Webhook } from "../src/types.ts";
import { scopeId } from "../src/types.ts";

describe("personKey / samePerson: the canonical same-person primitive", () => {
  it("trims, and lowercases emails only (the exact formula the connector/secret-drop checks used)", () => {
    assert.equal(personKey(" Fixture-Beta@Example.test "), "fixture-beta@example.test");
    assert.equal(personKey("U_FIXTURE_BETA"), "U_FIXTURE_BETA", "a non-email id is byte-exact — never folded");
    assert.equal(personKey(undefined), "");
    assert.equal(personKey(null), "");
  });

  it("equates email-case drift, never distinct ids, and never the empty id", () => {
    assert.equal(samePerson("Fixture-Beta@Example.test", "fixture-beta@example.test"), true);
    assert.equal(samePerson("fixture-beta@example.test", "casey@acme.test"), false);
    assert.equal(samePerson("U_FIXTURE_BETA", "u_fixture_beta"), false, "non-email ids stay case-sensitive");
    assert.equal(samePerson("", ""), false, "an empty id names nobody — fail closed");
  });

  it("bridges slackId ↔ email principal ONLY via an authoritative roster row", async () => {
    const dir = createDirectoryStore();
    await dir.replace([
      {
        principalId: "fixture-beta@example.test",
        displayName: "Fixture Beta",
        type: "internal",
        slackId: "U_FIXTURE_BETA",
      },
      { principalId: "casey@acme.test", displayName: "Casey", type: "internal", slackId: "U-casey" },
    ]);
    assert.equal(await samePersonInDirectory(dir, "fixture-beta@example.test", "U_FIXTURE_BETA"), true);
    assert.equal(
      await samePersonInDirectory(dir, "U_FIXTURE_BETA", "Fixture-Beta@Example.test"),
      true,
      "cased email still finds its roster row",
    );
    assert.equal(
      await samePersonInDirectory(dir, "fixture-beta@example.test", "U-casey"),
      false,
      "distinct people never merge",
    );
    assert.equal(
      await samePersonInDirectory(dir, "fixture-beta@example.test", "U-ghost"),
      false,
      "no roster row, no bridge — fail closed",
    );
    assert.equal(
      await samePersonInDirectory(createDirectoryStore(), "fixture-beta@example.test", "U_FIXTURE_BETA"),
      false,
      "empty directory bridges nothing",
    );
  });

  it("personKeys collects every id the roster asserts for one person", () => {
    const keys = personKeys(
      { principalId: "fixture-beta@example.test", slackId: "U_FIXTURE_BETA" },
      "Fixture-Beta@Example.test",
    );
    assert.deepEqual([...keys].sort(), ["U_FIXTURE_BETA", "fixture-beta@example.test"]);
  });
});

describe("canAdminister: owner checks are same-person, not raw id equality", () => {
  const cron = (over: Partial<Cron> = {}): Cron =>
    ({
      id: "c1",
      owner: "Fixture-Beta@Example.test",
      ownerScopeId: scopeId("personal", "Fixture-Beta@Example.test"),
      schedule: { everyMs: 1 },
      createdAt: 0,
      ...over,
    }) as Cron;

  function appOver(dir = createDirectoryStore()) {
    return {
      membershipControlsScope: async () => false,
      managesScope: async () => false,
      samePerson: (a: string, b: string) => samePersonInDirectory(dir, a, b),
    };
  }

  it("an email-cased owner passes for the lowercase capability actor", async () => {
    assert.equal(await canAdministerCron(appOver(), cron(), "fixture-beta@example.test"), true);
    assert.equal(await canAdministerCron(appOver(), cron(), "casey@acme.test"), false);
  });

  it("a Slack-id owner resolves through the directory for an email-identity actor", async () => {
    const dir = createDirectoryStore();
    await dir.replace([
      {
        principalId: "fixture-beta@example.test",
        displayName: "Fixture Beta",
        type: "internal",
        slackId: "U_FIXTURE_BETA",
      },
    ]);
    const slackOwned = cron({ owner: "U_FIXTURE_BETA", ownerScopeId: scopeId("personal", "U_FIXTURE_BETA") });
    assert.equal(await canAdministerCron(appOver(dir), slackOwned, "fixture-beta@example.test"), true);
    assert.equal(
      await canAdministerCron(appOver(), slackOwned, "fixture-beta@example.test"),
      false,
      "without the roster the bridge fails closed",
    );
  });

  it("webhooks share the same owner rule", async () => {
    const webhook = {
      id: "w1",
      owner: "Fixture-Delta@Example.test",
      ownerScopeId: scopeId("personal", "Fixture-Delta@Example.test"),
    } as Webhook;
    assert.equal(await canAdministerWebhook(appOver(), webhook, "fixture-delta@example.test"), true);
    assert.equal(await canAdministerWebhook(appOver(), webhook, "casey@yc.com"), false);
  });

  it("the list-path matcher agrees with the per-item check, including the roster bridge", async () => {
    const dir = createDirectoryStore();
    await dir.replace([
      {
        principalId: "fixture-beta@example.test",
        displayName: "Fixture Beta",
        type: "internal",
        slackId: "U_FIXTURE_BETA",
      },
    ]);
    const slackOwned = cron({ owner: "U_FIXTURE_BETA", ownerScopeId: scopeId("personal", "U_FIXTURE_BETA") });
    const isFixtureBeta = await samePersonMatcher(dir, "fixture-beta@example.test");
    assert.equal(
      await canAdministerCron(appOver(dir), slackOwned, "fixture-beta@example.test", undefined, isFixtureBeta),
      true,
    );
    assert.equal(
      await canAdministerCron(
        appOver(dir),
        cron({ owner: "casey@acme.test" }),
        "fixture-beta@example.test",
        undefined,
        isFixtureBeta,
      ),
      false,
    );
  });
});

describe("samePersonMatcher: one roster read answers many owner checks", () => {
  it("matches the actor's own row's ids without further lookups, and never a stranger", async () => {
    const dir = createDirectoryStore();
    await dir.replace([
      {
        principalId: "fixture-beta@example.test",
        displayName: "Fixture Beta",
        type: "internal",
        slackId: "U_FIXTURE_BETA",
      },
      { principalId: "casey@acme.test", displayName: "Casey", type: "internal", slackId: "U-casey" },
    ]);
    const isFixtureBeta = await samePersonMatcher(dir, "fixture-beta@example.test");
    assert.equal(await isFixtureBeta("Fixture-Beta@Example.test"), true);
    assert.equal(await isFixtureBeta("U_FIXTURE_BETA"), true);
    assert.equal(await isFixtureBeta("U-casey"), false);
    assert.equal(await isFixtureBeta("casey@acme.test"), false);
    assert.equal(await isFixtureBeta(""), false, "an empty id names nobody — fail closed");
  });

  it("an actor id with NO row of its own still bridges through the owner's row", async () => {
    const dir = createDirectoryStore();
    await dir.replace([
      {
        principalId: "fixture-beta@example.test",
        displayName: "Fixture Beta",
        type: "internal",
        slackId: "U_FIXTURE_BETA",
      },
    ]);
    const isFixtureBeta = await samePersonMatcher(dir, "U_FIXTURE_BETA");
    assert.equal(await isFixtureBeta("fixture-beta@example.test"), true, "falls back to the per-pair directory bridge");
    assert.equal(await isFixtureBeta("casey@acme.test"), false);
    const noRoster = await samePersonMatcher(createDirectoryStore(), "U_FIXTURE_BETA");
    assert.equal(await noRoster("fixture-beta@example.test"), false, "no roster row anywhere — fail closed");
  });
});

describe("resolveRunAsChange: the owner gate is same-person, not raw id equality", () => {
  const shared = (over: Partial<Cron> = {}): Cron =>
    ({
      id: "c2",
      owner: "U_FIXTURE_BETA",
      ownerScopeId: scopeId("channel", "C1"),
      schedule: { everyMs: 1 },
      createdAt: 0,
      runAs: "scopeFloor",
      members: [{ id: "fixture-beta@example.test", type: "internal" }],
      ...over,
    }) as Cron;
  const capability = {
    actorId: "fixture-beta@example.test",
    scopeId: scopeId("channel", "C1"),
    members: [{ id: "fixture-beta@example.test", type: "internal" as const }],
  };

  it("a U-id owner with a roster bridge can change runAs as the email actor", async () => {
    const dir = createDirectoryStore();
    await dir.replace([
      {
        principalId: "fixture-beta@example.test",
        displayName: "Fixture Beta",
        type: "internal",
        slackId: "U_FIXTURE_BETA",
      },
    ]);
    const app = { samePerson: (a: string, b: string) => samePersonInDirectory(dir, a, b) };
    const r = await resolveRunAsChange(app, shared(), "owner", capability);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.patch.runAs, "owner");
  });

  it("without the roster the bridge fails closed — forbidden", async () => {
    const app = { samePerson: (a: string, b: string) => samePersonInDirectory(createDirectoryStore(), a, b) };
    const r = await resolveRunAsChange(app, shared(), "owner", capability);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "forbidden");
  });
});
