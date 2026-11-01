import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createIdentityService,
  type DeactivationRecord,
  type OffboardedChange,
  type PrincipalRecord,
} from "../src/identity/identity-service.ts";
import type { ExternalMember } from "../src/identity/external-members.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { testMap } from "./support/test-database.ts";

const id = createIdentityService(testMap(), { externalMembers: testMap(), principals: testMap() });

test("classifies a same-org member as internal", () => {
  const p = id.classify("U1");
  assert.equal(p.type, "internal");
  assert.equal(id.isInternal(p), true);
});

test("classifies a flagged Slack Connect user as guest", () => {
  const p = id.classify("U2", true);
  assert.equal(p.type, "guest");
  assert.equal(id.isInternal(p), false);
});

test("resolves bot assertions as internal automation callers", () => {
  const p = id.resolve({ externalId: "B1", isBot: true });
  assert.equal(p.type, "internal");
  assert.equal(id.isInternal(p), true);
});

test("audienceIsAllInternal is false if any member is non-internal (G1)", () => {
  const internal = id.classify("U1");
  const guest = id.classify("U2", true);
  assert.equal(id.audienceIsAllInternal([internal]), true);
  assert.equal(id.audienceIsAllInternal([internal, guest]), false);
});

test("audienceIsAllInternal is false for an empty audience (unknown ≠ all-internal)", () => {
  assert.equal(id.audienceIsAllInternal([]), false);
});

test("a deactivated principal classifies as non-internal (fail-closed source, §3)", async () => {
  const svc = createIdentityService(testMap(), { externalMembers: testMap(), principals: testMap() });
  assert.equal(svc.classify("U-leaver").type, "internal");
  await svc.deactivate("U-leaver");
  const after = svc.classify("U-leaver");
  assert.equal(after.type, "guest");
  assert.equal(svc.isInternal(after), false);
  await svc.reactivate("U-leaver");
  assert.equal(svc.classify("U-leaver").type, "internal");
});

test("deactivation folds email case: a leaver stays out under any casing of their address", async () => {
  const svc = createIdentityService(testMap(), { externalMembers: testMap(), principals: testMap() });
  await svc.deactivate("Alice@Corp.com");
  assert.equal(svc.classify("alice@corp.com").type, "guest");
  assert.equal(svc.classify("ALICE@CORP.COM").type, "guest");
  await svc.reactivate("alice@corp.com");
  assert.equal(svc.classify("Alice@Corp.com").type, "internal");
});

test("case fold does not merge distinct emails or touch non-email ids", async () => {
  const svc = createIdentityService(testMap(), { externalMembers: testMap(), principals: testMap() });
  await svc.deactivate("bob@corp.com");
  assert.equal(svc.classify("bobby@corp.com").type, "internal");
  await svc.deactivate("U-Case");
  assert.equal(svc.classify("u-case").type, "internal");
});

test("durable rehydration folds a cased stored deactivation", async () => {
  const backing = testMap<DeactivationRecord>();
  const first = createIdentityService(backing, { externalMembers: testMap(), principals: testMap() });
  await first.deactivate("Carol@Corp.com");
  const second = createIdentityService(backing, { externalMembers: testMap(), principals: testMap() });
  await second.refresh();
  assert.equal(second.classify("carol@corp.com").type, "guest");
});

test("deactivation is durable: a fresh service over the same backing rehydrates it", async () => {
  const backing = testMap<DeactivationRecord>();
  const first = createIdentityService(backing, { externalMembers: testMap(), principals: testMap() });
  await first.deactivate("U-leaver");

  const second = createIdentityService(backing, { externalMembers: testMap(), principals: testMap() });
  assert.equal(second.classify("U-leaver").type, "internal");
  await second.refresh();
  assert.equal(second.classify("U-leaver").type, "guest");
});

test("a running instance refreshes deactivations written by another instance", async () => {
  const backing = testMap<DeactivationRecord>();
  const writer = createIdentityService(backing, { externalMembers: testMap(), principals: testMap() });
  const reader = createIdentityService(backing, { externalMembers: testMap(), principals: testMap() });
  await reader.refresh();
  await writer.deactivate("U-leaver");
  assert.equal(reader.classify("U-leaver").type, "internal");
  await reader.refresh(true);
  assert.equal(reader.classify("U-leaver").type, "guest");
});

test("external members written by one instance reach another over the same backing", async () => {
  const externalMembers = testMap<ExternalMember>();
  const writer = createIdentityService(testMap(), { externalMembers, principals: testMap() });
  const reader = createIdentityService(testMap(), { externalMembers, principals: testMap() });
  await reader.refresh();
  const now = Date.now();
  const member = (expiresAt: number): ExternalMember => ({
    email: "pat@partner.example",
    role: "member",
    expiresAt,
    invitedBy: "admin-alice",
    createdAt: now,
    updatedAt: now,
  });
  await writer.putExternalMember(member(now + 60_000));
  assert.equal(reader.externalMember("pat@partner.example"), undefined);
  await reader.refresh(true);
  assert.equal(reader.externalMember("Pat@Partner.example")?.expiresAt, now + 60_000);
  assert.equal(reader.classify("pat@partner.example").type, "internal");

  await writer.putExternalMember(member(now - 1));
  await reader.refresh();
  assert.equal(reader.classify("pat@partner.example").type, "internal", "within the TTL the cache is served");
  await reader.refresh(true);
  assert.equal(reader.classify("pat@partner.example").type, "guest", "a forced refresh reads the store");
  const late = createIdentityService(testMap(), { externalMembers, principals: testMap() });
  await late.refresh();
  assert.equal(late.classify("pat@partner.example").type, "guest");
});

test("a manual deactivation issued alongside a directory sync is not undone by it", async () => {
  const svc = createIdentityService(testMap(), { externalMembers: testMap(), principals: testMap() });
  await svc.deactivate("alice", "directory-sync");
  await Promise.all([svc.deactivate("alice", "manual"), svc.recordDirectorySync([], ["alice"])]);
  assert.equal(svc.deactivationSource("alice"), "manual");
  assert.equal(svc.classify("alice").type, "guest");
});

test("a deactivation written during a refresh survives that refresh", async () => {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const backing = testMap<DeactivationRecord>();
  const all = backing.all.bind(backing);
  const svc = createIdentityService(
    {
      ...backing,
      all: async () => {
        const rows = await all();
        entered.resolve();
        await gate.promise;
        return rows;
      },
    },
    { externalMembers: testMap(), principals: testMap() },
  );
  const loading = svc.refresh(true);
  await entered.promise;
  const deactivating = svc.deactivate("U-leaver");
  gate.resolve();
  await Promise.all([loading, deactivating]);
  assert.equal(svc.classify("U-leaver").type, "guest");
});

test("a directory sync deactivates dropped members and self-heals when they reappear", async () => {
  const svc = createIdentityService(testMap(), { externalMembers: testMap(), principals: testMap() });
  const out = await svc.recordDirectorySync(["U-gone"], ["U-here"]);
  assert.deepEqual(out, { deactivated: ["U-gone"], reactivated: [] });
  assert.equal(svc.classify("U-gone").type, "guest");

  const back = await svc.recordDirectorySync([], ["U-gone", "U-here"]);
  assert.deepEqual(back, { deactivated: [], reactivated: ["U-gone"] });
  assert.equal(svc.classify("U-gone").type, "internal");
});

test("a manual deactivation survives roster churn — only reactivate() clears it", async () => {
  const svc = createIdentityService(testMap(), { externalMembers: testMap(), principals: testMap() });
  await svc.deactivate("U-fired");
  await svc.recordDirectorySync([], ["U-fired"]);
  assert.equal(svc.classify("U-fired").type, "guest");
  await svc.recordDirectorySync(["U-fired"], []);
  await svc.recordDirectorySync([], ["U-fired"]);
  assert.equal(svc.classify("U-fired").type, "guest");
  await svc.reactivate("U-fired");
  assert.equal(svc.classify("U-fired").type, "internal");
});

test("an offboarding is recorded on the person, survives reactivation as history, and reaches other instances", async () => {
  const principals = testMap<PrincipalRecord>();
  const writer = createIdentityService(testMap(), { externalMembers: testMap(), principals });
  const reader = createIdentityService(testMap(), { externalMembers: testMap(), principals });
  await reader.refresh();
  const change = (id: string): OffboardedChange => ({
    kind: "cron",
    id,
    label: id,
    scopeId: "personal:leaver@example.com",
    action: "disable_and_archive",
    result: "done",
  });
  const first = await writer.recordOffboarded("Leaver@example.com", "admin-alice", [change("c1")]);
  assert.deepEqual([first.offboarded, first.offboardedBy], [true, "admin-alice"]);
  assert.equal(writer.offboarded("leaver@example.com"), true);
  await writer.recordOffboarded("leaver@example.com", "admin-bob", [change("c2")]);
  const again = (await writer.principal("leaver@example.com"))!;
  assert.equal(again.offboardedAt, first.offboardedAt, "a retry keeps the first offboarding time");
  assert.equal(again.offboardedBy, "admin-alice");
  assert.deepEqual(
    again.offboardChanges!.map((c) => c.id),
    ["c1", "c2"],
  );

  await reader.reactivate("leaver@example.com", "admin-bob");
  const back = (await writer.principal("leaver@example.com"))!;
  assert.equal(back.offboarded, false, "another instance clears the flag from the store, not its stale cache");
  assert.equal(back.reactivatedBy, "admin-bob");
  assert.equal(back.offboardedBy, "admin-alice", "reactivation keeps who offboarded them and when");
  assert.equal(back.offboardChanges!.length, 2);
  await writer.refresh(true);
  assert.equal(writer.offboarded("leaver@example.com"), false);
  assert.deepEqual(
    (await reader.listPrincipals()).map((r) => [r.principalId, r.offboarded, "offboardChanges" in r]),
    [["Leaver@example.com", false, false]],
    "the cached list carries the flags, not the change history",
  );

  await writer.recordOffboarded("leaver@example.com", "admin-carol", [change("c3")]);
  const second = (await writer.principal("leaver@example.com"))!;
  assert.deepEqual(
    [second.offboarded, second.offboardedBy, second.offboardChanges!.map((c) => c.id)],
    [true, "admin-carol", ["c1", "c2", "c3"]],
    "a later offboarding keeps the earlier rounds' changes",
  );

  await writer.reactivate("someone-else@example.com", "admin-bob");
  assert.equal(
    await writer.principal("someone-else@example.com"),
    null,
    "reactivating a non-offboarded person adds no record",
  );
});

test("deactivated means signed out: manual, or removed by directory sync and not kept", async () => {
  const svc = createIdentityService(testMap(), {
    externalMembers: testMap(),
    principals: testMap(),
    directorySyncProtected: ["kept@example.com"],
  });
  await svc.deactivate("manual@example.com");
  await svc.recordDirectorySync(["synced@example.com"], []);
  await svc.deactivate("kept@example.com", "directory-sync");
  assert.deepEqual(
    ["manual@example.com", "synced@example.com", "kept@example.com", "active@example.com"].map((id) =>
      svc.deactivated(id),
    ),
    [true, true, false, false],
  );
});

test("a person joins the roster once, folded to one record, on the first thing that makes them real", async () => {
  const principals = testMap<PrincipalRecord>();
  let writes = 0;
  const counted = {
    ...principals,
    mutateMany: (updates: Parameters<typeof principals.mutateMany>[0]) => {
      writes++;
      return principals.mutateMany(updates);
    },
  };
  const svc = createIdentityService(testMap(), { externalMembers: testMap(), principals: counted });
  await svc.refresh();
  await svc.notePerson("Pat@Example.com", "turn");
  await svc.notePerson("pat@example.com", "turn");
  await svc.notePerson("pat@example.com", "admin");
  assert.equal(writes, 1, "later notes for someone already on the roster cost no write");
  const [pat] = await svc.listPrincipals();
  assert.deepEqual([pat!.principalId, pat!.source, pat!.offboarded], ["Pat@Example.com", "turn", false]);
  assert.equal(typeof pat!.firstSeenAt, "number");

  const reader = createIdentityService(testMap(), { externalMembers: testMap(), principals });
  await reader.notePerson("pat@example.com", "admin");
  assert.equal((await reader.principal("pat@example.com"))!.source, "turn", "another instance keeps the first arrival");

  await svc.recordOffboarded("gone@example.com", "admin-alice", []);
  await reader.notePerson("gone@example.com", "turn");
  const gone = (await reader.principal("gone@example.com"))!;
  assert.deepEqual([gone.offboarded, gone.offboardedBy, gone.source], [true, "admin-alice", "turn"]);

  await svc.putExternalMember({
    email: "guest@example.com",
    role: "member",
    expiresAt: null,
    kind: "teammate",
    invitedBy: "admin-alice",
    createdAt: 1234,
    updatedAt: 1234,
  });
  const guest = (await svc.principal("guest@example.com"))!;
  assert.deepEqual([guest.source, guest.firstSeenAt], ["invite", 1234]);
});

test("the roster backfill runs once, takes each person's earliest arrival, and folds linked ids", async () => {
  installPrincipalLinks({
    canonical: (key) => (key === "U-SLACK" ? "sam@example.com" : undefined),
    aliases: (key) => (key === "sam@example.com" ? ["U-SLACK"] : []),
  });
  try {
    const principals = testMap<PrincipalRecord>();
    const svc = createIdentityService(testMap(), { externalMembers: testMap(), principals });
    await svc.recordOffboarded("left@example.com", "admin-alice", []);
    let loads = 0;
    const history = async () => {
      loads++;
      return [
        { principalId: "U-SLACK", source: "turn" as const, at: 300 },
        { principalId: "sam@example.com", source: "admin" as const, at: 200 },
        { principalId: "left@example.com", source: "turn" as const, at: 100 },
        { principalId: "Ann@Example.com", source: "invite" as const, at: 50 },
      ];
    };
    assert.equal(await svc.backfillPrincipals(history), 3);
    const rows = Object.fromEntries((await svc.listPrincipals()).map((r) => [r.principalId, r]));
    assert.deepEqual(Object.keys(rows).sort(), ["Ann@Example.com", "left@example.com", "sam@example.com"]);
    assert.deepEqual([rows["sam@example.com"]!.source, rows["sam@example.com"]!.firstSeenAt], ["admin", 200]);
    assert.deepEqual([rows["left@example.com"]!.offboarded, rows["left@example.com"]!.firstSeenAt], [true, 100]);

    const again = createIdentityService(testMap(), { externalMembers: testMap(), principals });
    assert.equal(await again.backfillPrincipals(history), 0);
    assert.equal(loads, 1, "a second boot sees the roster and skips the history scan");
  } finally {
    installPrincipalLinks(null);
  }
});
