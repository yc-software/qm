import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { personKey, samePerson } from "../src/directory/person.ts";
import { canAdministerCron, canAdministerWebhook, resolveRunAsChange } from "../src/api/control-service.ts";
import type { Cron, Webhook } from "../src/types.ts";
import { scopeId } from "../src/types.ts";

const JORDAN = "0b6f8f1e-6a0c-4e43-9a2b-1c2d3e4f5a6b";
const CASEY = "5d1c9a7e-2b3f-4c8d-9e0a-6f7b8c9d0e1f";

describe("personKey / samePerson: the canonical same-person primitive", () => {
  it("treats a principal id as opaque: trimmed, never folded, never resolved through a handle", () => {
    assert.equal(personKey(` ${JORDAN} `), JORDAN);
    assert.equal(personKey("Jordan@Acme.test"), "Jordan@Acme.test");
    assert.equal(personKey(undefined), "");
    assert.equal(personKey(null), "");
  });

  it("equates one principal, never distinct ids, and never the empty id", () => {
    assert.equal(samePerson(` ${JORDAN}`, JORDAN), true);
    assert.equal(samePerson(JORDAN, CASEY), false);
    assert.equal(
      samePerson("Jordan@Acme.test", "jordan@acme.test"),
      false,
      "no email folding: handles resolve at edges",
    );
    assert.equal(samePerson("", ""), false, "an empty id names nobody — fail closed");
  });
});

describe("canAdminister: owner checks are same-person, not raw id equality", () => {
  const cron = (over: Partial<Cron> = {}): Cron =>
    ({
      id: "c1",
      owner: JORDAN,
      ownerScopeId: scopeId("personal", JORDAN),
      schedule: { everyMs: 1 },
      createdAt: 0,
      ...over,
    }) as Cron;

  const appOver = () => ({
    membershipControlsScope: async () => false,
    managesScope: async () => false,
    isCurrentSharedScopeMember: async () => false,
    isOpenScopeMember: async () => false,
    samePerson: async (a: string, b: string) => samePerson(a, b),
  });

  it("the owner passes; anyone else does not", async () => {
    assert.equal(await canAdministerCron(appOver(), cron(), JORDAN), true);
    assert.equal(await canAdministerCron(appOver(), cron(), CASEY), false);
  });

  it("webhooks share the same owner rule", async () => {
    const webhook = { id: "w1", owner: JORDAN, ownerScopeId: scopeId("personal", JORDAN) } as Webhook;
    assert.equal(await canAdministerWebhook(appOver(), webhook, JORDAN), true);
    assert.equal(await canAdministerWebhook(appOver(), webhook, CASEY), false);
  });

  it("the list-path matcher agrees with the per-item check", async () => {
    const isJordan = async (id: string) => samePerson(id, JORDAN);
    assert.equal(await canAdministerCron(appOver(), cron(), JORDAN, undefined, isJordan), true);
    assert.equal(await canAdministerCron(appOver(), cron({ owner: CASEY }), JORDAN, undefined, isJordan), false);
  });
});

describe("resolveRunAsChange: the owner gate is same-person, not raw id equality", () => {
  const shared = (owner: string): Cron =>
    ({
      id: "c2",
      owner,
      ownerScopeId: scopeId("channel", "C1"),
      schedule: { everyMs: 1 },
      createdAt: 0,
      runAs: "scopeFloor",
      members: [{ id: JORDAN, type: "internal" }],
    }) as Cron;
  const capability = {
    actorId: JORDAN,
    scopeId: scopeId("channel", "C1"),
    members: [{ id: JORDAN, type: "internal" as const }],
  };
  const app = { isOpenScopeMember: async () => false, samePerson: async (a: string, b: string) => samePerson(a, b) };

  it("the owner can change runAs", async () => {
    const r = await resolveRunAsChange(app, shared(JORDAN), "owner", capability);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.patch.runAs, "owner");
  });

  it("anyone else is forbidden", async () => {
    const r = await resolveRunAsChange(app, shared(CASEY), "owner", capability);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "forbidden");
  });
});
