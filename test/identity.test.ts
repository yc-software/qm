import { test } from "node:test";
import assert from "node:assert/strict";
import { createIdentityService, type DeactivationRecord } from "../src/identity/identity-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const id = createIdentityService();

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
  const svc = createIdentityService();
  assert.equal(svc.classify("U-leaver").type, "internal");
  await svc.deactivate("U-leaver");
  const after = svc.classify("U-leaver");
  assert.equal(after.type, "guest");
  assert.equal(svc.isInternal(after), false);
  await svc.reactivate("U-leaver");
  assert.equal(svc.classify("U-leaver").type, "internal");
});

test("deactivation folds email case: a leaver stays out under any casing of their address", async () => {
  const svc = createIdentityService();
  await svc.deactivate("Alice@Corp.com");
  assert.equal(svc.classify("alice@corp.com").type, "guest");
  assert.equal(svc.classify("ALICE@CORP.COM").type, "guest");
  await svc.reactivate("alice@corp.com");
  assert.equal(svc.classify("Alice@Corp.com").type, "internal");
});

test("case fold does not merge distinct emails or touch non-email ids", async () => {
  const svc = createIdentityService();
  await svc.deactivate("bob@corp.com");
  assert.equal(svc.classify("bobby@corp.com").type, "internal");
  await svc.deactivate("U-Case");
  assert.equal(svc.classify("u-case").type, "internal");
});

test("durable rehydration folds a cased stored deactivation", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  const first = createIdentityService(backing);
  await first.deactivate("Carol@Corp.com");
  const second = createIdentityService(backing);
  await second.hydrate();
  assert.equal(second.classify("carol@corp.com").type, "guest");
});

test("deactivation is durable: a fresh service over the same backing rehydrates it", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  const first = createIdentityService(backing);
  await first.deactivate("U-leaver");

  const second = createIdentityService(backing);
  assert.equal(second.classify("U-leaver").type, "internal");
  await second.hydrate();
  assert.equal(second.classify("U-leaver").type, "guest");
});

test("a running instance refreshes deactivations written by another instance", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  const writer = createIdentityService(backing);
  const reader = createIdentityService(backing);
  await reader.hydrate();
  await writer.deactivate("U-leaver");
  assert.equal(reader.classify("U-leaver").type, "internal");
  await reader.refresh();
  assert.equal(reader.classify("U-leaver").type, "guest");
});

test("a directory sync deactivates dropped members and self-heals when they reappear", async () => {
  const svc = createIdentityService();
  const out = await svc.recordDirectorySync(["U-gone"], ["U-here"]);
  assert.deepEqual(out, { deactivated: ["U-gone"], reactivated: [] });
  assert.equal(svc.classify("U-gone").type, "guest");

  const back = await svc.recordDirectorySync([], ["U-gone", "U-here"]);
  assert.deepEqual(back, { deactivated: [], reactivated: ["U-gone"] });
  assert.equal(svc.classify("U-gone").type, "internal");
});

test("directory-sync deactivation records carry durable identity ownership", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  const svc = createIdentityService(backing);
  await svc.recordDirectorySync(["U-owned"], []);
  assert.deepEqual(svc.deactivation("U-owned"), {
    principalId: "U-owned",
    source: "directory-sync",
    identitySource: "directory-sync",
    at: svc.deactivation("U-owned")!.at,
  });
  const restored = createIdentityService(backing);
  await restored.hydrate();
  assert.equal((await restored.portalIdentityAccess("U-owned")).active, false);
});

test("a verified portal identity repairs only legacy unowned directory-sync deactivations", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  await backing.put("legacy@example.com", {
    principalId: "Legacy@Example.com",
    source: "directory-sync",
    at: 1,
  });
  const svc = createIdentityService(backing);
  await svc.hydrate();
  assert.deepEqual(await svc.portalIdentityAccess("legacy@example.com"), { active: true, recovered: true });
  assert.equal(await backing.get("legacy@example.com"), null);

  await svc.deactivate("manual@example.com");
  assert.equal((await svc.portalIdentityAccess("manual@example.com")).active, false);
});

test("an impersonated portal identity cannot claim legacy recovery", async () => {
  const svc = createIdentityService();
  await svc.deactivate("legacy@example.com", "directory-sync");
  const access = await svc.portalIdentityAccess("legacy@example.com", false);
  assert.equal(access.active, false);
  assert.equal(svc.deactivation("legacy@example.com")?.source, "directory-sync");
});

test("stale instances cannot overwrite or recover a concurrent manual deactivation", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  const stale = createIdentityService(backing);
  const current = createIdentityService(backing);
  await Promise.all([stale.hydrate(), current.hydrate()]);

  await current.deactivate("member@example.com");
  await stale.recordDirectorySync(["member@example.com"], []);
  assert.equal((await backing.get("member@example.com"))?.source, "manual");
  assert.equal((await stale.portalIdentityAccess("member@example.com")).active, false);
  assert.equal((await backing.get("member@example.com"))?.source, "manual");
});

test("manual deactivation retries when a concurrent recovery deletes the prior record", async () => {
  const backing = createMemoryMap<DeactivationRecord>();
  await backing.put("member@example.com", {
    principalId: "member@example.com",
    source: "directory-sync",
    identitySource: "directory-sync",
    at: 1,
  });
  const update = backing.update!;
  let raced = false;
  const racing: typeof backing = {
    ...backing,
    async update(key, fn) {
      if (!raced) {
        raced = true;
        await backing.delete(key);
      }
      return update.call(backing, key, fn);
    },
  };
  const svc = createIdentityService(racing);
  await svc.hydrate();
  await svc.deactivate("member@example.com");
  assert.equal((await backing.get("member@example.com"))?.source, "manual");
});

test("directory synchronization folds email case and deduplicates transitions", async () => {
  const svc = createIdentityService();
  const outcome = await svc.recordDirectorySync(["Member@Example.com", "member@example.com"], ["MEMBER@example.com"]);
  assert.deepEqual(outcome, { deactivated: [], reactivated: [] });
  assert.equal(svc.deactivation("member@example.com"), null);
});

test("a manual deactivation survives roster churn — only reactivate() clears it", async () => {
  const svc = createIdentityService();
  await svc.deactivate("U-fired");
  await svc.recordDirectorySync([], ["U-fired"]);
  assert.equal(svc.classify("U-fired").type, "guest");
  await svc.recordDirectorySync(["U-fired"], []);
  await svc.recordDirectorySync([], ["U-fired"]);
  assert.equal(svc.classify("U-fired").type, "guest");
  await svc.reactivate("U-fired");
  assert.equal(svc.classify("U-fired").type, "internal");
});
