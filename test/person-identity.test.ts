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
    assert.equal(personKey(" Jordan@Acme.test "), "jordan@acme.test");
    assert.equal(personKey("U-Jordan"), "U-Jordan", "a non-email id is byte-exact — never folded");
    assert.equal(personKey(undefined), "");
    assert.equal(personKey(null), "");
  });

  it("equates email-case drift, never distinct ids, and never the empty id", () => {
    assert.equal(samePerson("Jordan@Acme.test", "jordan@acme.test"), true);
    assert.equal(samePerson("jordan@acme.test", "casey@acme.test"), false);
    assert.equal(samePerson("U-jordan", "u-jordan"), false, "non-email ids stay case-sensitive");
    assert.equal(samePerson("", ""), false, "an empty id names nobody — fail closed");
  });

  it("bridges slackId ↔ email principal ONLY via an authoritative roster row", async () => {
    const dir = createDirectoryStore();
    await dir.replace([
      { principalId: "jordan@acme.test", displayName: "Jordan", type: "internal", slackId: "U-jordan" },
      { principalId: "casey@acme.test", displayName: "Casey", type: "internal", slackId: "U-casey" },
    ]);
    assert.equal(await samePersonInDirectory(dir, "jordan@acme.test", "U-jordan"), true);
    assert.equal(
      await samePersonInDirectory(dir, "U-jordan", "Jordan@Acme.test"),
      true,
      "cased email still finds its roster row",
    );
    assert.equal(await samePersonInDirectory(dir, "jordan@acme.test", "U-casey"), false, "distinct people never merge");
    assert.equal(
      await samePersonInDirectory(dir, "jordan@acme.test", "U-ghost"),
      false,
      "no roster row, no bridge — fail closed",
    );
    assert.equal(
      await samePersonInDirectory(createDirectoryStore(), "jordan@acme.test", "U-jordan"),
      false,
      "empty directory bridges nothing",
    );
  });

  it("personKeys collects every id the roster asserts for one person", () => {
    const keys = personKeys({ principalId: "jordan@acme.test", slackId: "U-jordan" }, "Jordan@Acme.test");
    assert.deepEqual([...keys].sort(), ["U-jordan", "jordan@acme.test"]);
  });
});

describe("canAdminister: owner checks are same-person, not raw id equality", () => {
  const cron = (over: Partial<Cron> = {}): Cron =>
    ({
      id: "c1",
      owner: "Jordan@Acme.test",
      ownerScopeId: scopeId("personal", "Jordan@Acme.test"),
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
    assert.equal(await canAdministerCron(appOver(), cron(), "jordan@acme.test"), true);
    assert.equal(await canAdministerCron(appOver(), cron(), "casey@acme.test"), false);
  });

  it("a Slack-id owner resolves through the directory for an email-identity actor", async () => {
    const dir = createDirectoryStore();
    await dir.replace([
      { principalId: "jordan@acme.test", displayName: "Jordan", type: "internal", slackId: "U-jordan" },
    ]);
    const slackOwned = cron({ owner: "U-jordan", ownerScopeId: scopeId("personal", "U-jordan") });
    assert.equal(await canAdministerCron(appOver(dir), slackOwned, "jordan@acme.test"), true);
    assert.equal(
      await canAdministerCron(appOver(), slackOwned, "jordan@acme.test"),
      false,
      "without the roster the bridge fails closed",
    );
  });

  it("webhooks share the same owner rule", async () => {
    const webhook = { id: "w1", owner: "Regan@YC.com", ownerScopeId: scopeId("personal", "Regan@YC.com") } as Webhook;
    assert.equal(await canAdministerWebhook(appOver(), webhook, "regan@yc.com"), true);
    assert.equal(await canAdministerWebhook(appOver(), webhook, "casey@yc.com"), false);
  });

  it("the list-path matcher agrees with the per-item check, including the roster bridge", async () => {
    const dir = createDirectoryStore();
    await dir.replace([
      { principalId: "jordan@acme.test", displayName: "Jordan", type: "internal", slackId: "U-jordan" },
    ]);
    const slackOwned = cron({ owner: "U-jordan", ownerScopeId: scopeId("personal", "U-jordan") });
    const isJordan = await samePersonMatcher(dir, "jordan@acme.test");
    assert.equal(await canAdministerCron(appOver(dir), slackOwned, "jordan@acme.test", undefined, isJordan), true);
    assert.equal(
      await canAdministerCron(
        appOver(dir),
        cron({ owner: "casey@acme.test" }),
        "jordan@acme.test",
        undefined,
        isJordan,
      ),
      false,
    );
  });
});

describe("samePersonMatcher: one roster read answers many owner checks", () => {
  it("matches the actor's own row's ids without further lookups, and never a stranger", async () => {
    const dir = createDirectoryStore();
    await dir.replace([
      { principalId: "jordan@acme.test", displayName: "Jordan", type: "internal", slackId: "U-jordan" },
      { principalId: "casey@acme.test", displayName: "Casey", type: "internal", slackId: "U-casey" },
    ]);
    const isJordan = await samePersonMatcher(dir, "jordan@acme.test");
    assert.equal(await isJordan("Jordan@Acme.test"), true);
    assert.equal(await isJordan("U-jordan"), true);
    assert.equal(await isJordan("U-casey"), false);
    assert.equal(await isJordan("casey@acme.test"), false);
    assert.equal(await isJordan(""), false, "an empty id names nobody — fail closed");
  });

  it("an actor id with NO row of its own still bridges through the owner's row", async () => {
    const dir = createDirectoryStore();
    await dir.replace([
      { principalId: "jordan@acme.test", displayName: "Jordan", type: "internal", slackId: "U-jordan" },
    ]);
    const isJordan = await samePersonMatcher(dir, "U-jordan");
    assert.equal(await isJordan("jordan@acme.test"), true, "falls back to the per-pair directory bridge");
    assert.equal(await isJordan("casey@acme.test"), false);
    const noRoster = await samePersonMatcher(createDirectoryStore(), "U-jordan");
    assert.equal(await noRoster("jordan@acme.test"), false, "no roster row anywhere — fail closed");
  });
});

describe("resolveRunAsChange: the owner gate is same-person, not raw id equality", () => {
  const shared = (over: Partial<Cron> = {}): Cron =>
    ({
      id: "c2",
      owner: "U-jordan",
      ownerScopeId: scopeId("channel", "C1"),
      schedule: { everyMs: 1 },
      createdAt: 0,
      runAs: "scopeFloor",
      members: [{ id: "jordan@acme.test", type: "internal" }],
      ...over,
    }) as Cron;
  const capability = {
    actorId: "jordan@acme.test",
    scopeId: scopeId("channel", "C1"),
    members: [{ id: "jordan@acme.test", type: "internal" as const }],
  };

  it("a U-id owner with a roster bridge can change runAs as the email actor", async () => {
    const dir = createDirectoryStore();
    await dir.replace([
      { principalId: "jordan@acme.test", displayName: "Jordan", type: "internal", slackId: "U-jordan" },
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
